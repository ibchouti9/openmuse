// MSP host bridge: spawns `muse serve` and speaks JSON-RPC 2.0 over stdio.
// Shapes follow `muse schema generate-json-schema` (stable surface).
"use strict";

const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const EventEmitter = require("node:events");

// Minimal UUIDv7 for idempotency handles (commandId).
function uuidv7() {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  b[0] = Number((ms >> 40n) & 0xffn);
  b[1] = Number((ms >> 32n) & 0xffn);
  b[2] = Number((ms >> 24n) & 0xffn);
  b[3] = Number((ms >> 16n) & 0xffn);
  b[4] = Number((ms >> 8n) & 0xffn);
  b[5] = Number(ms & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const DEFAULT_TIMEOUT_MS = 120000;
// Fast-fail reads: a hung list/page should surface in seconds, not hang
// the UI behind the 120s write default.
const READ_TIMEOUT_MS = 30000;
const METHOD_TIMEOUTS = {
  "session/list": READ_TIMEOUT_MS,
  "view/page": READ_TIMEOUT_MS,
  "model/list": READ_TIMEOUT_MS,
  "approval/listPending": READ_TIMEOUT_MS,
  "session/read": READ_TIMEOUT_MS,
};
// Cap the stdio line buffer so one oversized frame can't grow memory
// without bound; the buffer resets and the frame is reported as a log.
const MAX_BUF_BYTES = 64 * 1024 * 1024;

class MspHost extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.bin = opts.bin || process.env.MUSE_BIN || "muse";
    this.workspace = opts.workspace || process.env.OPENMUSE_WORKSPACE || process.cwd();
    this.rootArgs = opts.rootArgs || [];
    if (!opts.rootArgs && process.env.MUSE_WORKSPACE) this.rootArgs = ["--workspace", process.env.MUSE_WORKSPACE];
    this.extraArgs = opts.extraArgs || [];
    this.proc = null;
    this.capabilities = opts.capabilities || {};
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.connected = false;
    this.lastError = null;
    this.restarts = 0;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this._spawn();
  }

  stop() {
    this.stopped = true;
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* already exited */
      }
    }
    for (const [, p] of this.pending) p.reject(new Error("muse host is stopping"));
    this.pending.clear();
  }

  _spawn() {
    const args = [...this.rootArgs, "serve", ...this.extraArgs];
    this.proc = spawn(this.bin, args, { cwd: this.workspace, stdio: ["pipe", "pipe", "pipe"] });
    this.buf = "";
    this.proc.stdout.on("data", (c) => this._onData(c));
    this.proc.stderr.on("data", (c) => {
      const t = c.toString();
      if (t.trim()) this.emit("host-log", t);
    });
    this.proc.on("error", (err) => {
      this.connected = false;
      this.lastError = `cannot start '${this.bin} serve': ${err.message}`;
      this.emit("status", this.status());
      this._scheduleRestart();
    });
    this.proc.on("exit", (code) => {
      this.connected = false;
      for (const [, p] of this.pending) p.reject(new Error(`host exited (code ${code})`));
      this.pending.clear();
      if (!this.stopped) {
        this.lastError = `muse serve exited (code ${code})`;
        this.emit("status", this.status());
        this._scheduleRestart();
      }
    });
    this._initialize().then(
      () => {
        this.connected = true;
        this.lastError = null;
        this.restarts = 0;
        this.emit("status", this.status());
      },
      (err) => {
        this.lastError = `initialize failed: ${err.message}`;
        this.emit("status", this.status());
      },
    );
  }

  _scheduleRestart() {
    if (this.stopped || this.restarts >= 3) return;
    this.restarts += 1;
    setTimeout(() => !this.stopped && this._spawn(), 2000 * this.restarts);
  }

  status() {
    return { connected: this.connected, lastError: this.lastError, restarts: this.restarts };
  }

  _onData(chunk) {
    this.buf += chunk.toString("utf8");
    if (Buffer.byteLength(this.buf, "utf8") > MAX_BUF_BYTES) {
      this.buf = "";
      this.emit("host-log", "msp: dropped oversized stdio buffer (>64MB) to protect memory");
      return;
    }
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("host-log", line);
        continue;
      }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      // Server -> client notification (item/delta, approval/requested, ...).
      // Reply to requests (non-null id) with a null result so the host never stalls.
      if (msg.id !== undefined && msg.id !== null) {
        this._write({ jsonrpc: "2.0", id: msg.id, result: null });
      }
      this.emit("notification", msg);
      return;
    }
  }

  _write(obj) {
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params, timeoutMs) {
    if (this.stopped) {
      return Promise.reject(new Error("muse host is stopping"));
    }
    if (!this.proc || this.proc.exitCode !== null) {
      return Promise.reject(new Error("muse host is not running"));
    }
    const budget = timeoutMs ?? METHOD_TIMEOUTS[method] ?? DEFAULT_TIMEOUT_MS;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`msp request timed out: ${method}`));
      }, budget);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this._write({ jsonrpc: "2.0", id, method, params });
    });
  }

  _initialize() {
    return this.request("initialize", {
      clientInfo: { name: "openmuse", title: "OpenMuse", version: "0.1.0" },
      capabilities: this.capabilities,
    }).then((result) => {
      // Handshake notification: client-to-server notification closing the handshake; no params.
      // The host answers "Not initialized" to every method until it arrives.
      this._write({ jsonrpc: "2.0", method: "initialized" });
      return result;
    });
  }

  // ---- convenience wrappers (names match the MSP method index) ----
  sessionStart({ modelId, approvalMode, workspaceRoot, providerId = null, sessionId = null } = {}) {
    const params = { commandId: uuidv7() };
    if (modelId) params.modelId = modelId;
    if (approvalMode) params.approvalMode = approvalMode;
    if (workspaceRoot) params.workspaceRoot = workspaceRoot;
    if (providerId) params.providerId = providerId;
    if (sessionId) params.sessionId = sessionId;
    return this.request("session/start", params);
  }
  sessionList({ limit = 50, cursor = null } = {}) {
    return this.request("session/list", { limit, cursor });
  }
  sessionResume(sessionId) {
    return this.request("session/resume", { commandId: uuidv7(), sessionId });
  }
  turnStart(sessionId, text, { reasoningEffort, images = [] } = {}) {
    const parts = text ? [{ type: "text", text }] : [];
    for (const img of images) {
      const part = { type: "image", mediaType: img.mediaType, base64Data: img.base64Data };
      if (img.width && img.height) {
        part.width = img.width;
        part.height = img.height;
      }
      parts.push(part);
    }
    const base = text || `${images.length} image${images.length === 1 ? "" : "s"} attached`;
    const params = {
      commandId: uuidv7(),
      sessionId,
      displayText: text && images.length ? `${text} [+${images.length} image${images.length === 1 ? "" : "s"}]` : base,
      input: parts,
    };
    if (reasoningEffort) params.reasoningEffort = reasoningEffort;
    return this.request("turn/start", params);
  }
  turnInterrupt(sessionId, turnId) {
    const params = { commandId: uuidv7(), sessionId, retract: false };
    if (turnId) params.turnId = turnId;
    return this.request("turn/interrupt", params);
  }
  // Schema lists turn/cancel; the host implements it as turn/interrupt.
  turnCancel(sessionId, turnId) {
    return this.turnInterrupt(sessionId, turnId);
  }
  approvalDecide({ sessionId, approvalId, choiceId, requirementId, feedback = null }) {
    return this.request("approval/decide", {
      commandId: uuidv7(),
      sessionId,
      approvalId,
      choiceId,
      requirementId,
      feedback,
    });
  }
  modelList() {
    return this.request("model/list", {});
  }
  userInputAnswer({ sessionId, userInputId, answers }) {
    return this.request("userInput/answer", { commandId: uuidv7(), sessionId, userInputId, answers });
  }
  userInputCancel({ sessionId, userInputId }) {
    return this.request("userInput/cancel", { commandId: uuidv7(), sessionId, userInputId });
  }
  viewPage({ sessionId, cursor = null, limit = 200, timeoutMs } = {}) {
    const params = { sessionId, limit };
    if (cursor) params.cursor = cursor;
    return this.request("view/page", params, timeoutMs);
  }
  setModel(sessionId, modelId) {
    return this.request("session/setModel", { commandId: uuidv7(), sessionId, model: { modelId } });
  }
  setApprovalMode(sessionId, mode) {
    return this.request("session/setApprovalMode", { commandId: uuidv7(), sessionId, mode });
  }
  approvalListPending(sessionId) {
    return this.request("approval/listPending", { sessionId });
  }
  sessionRead(sessionId, { excludeItems = true } = {}) {
    return this.request("session/read", { sessionId, excludeItems });
  }
  sessionFork(sessionId, { cutPoint = null, excludeItems = true } = {}) {
    const params = { commandId: uuidv7(), sessionId, excludeItems };
    if (cutPoint) params.cutPoint = cutPoint;
    return this.request("session/fork", params);
  }
  sessionCompact(sessionId, { turnId = null } = {}) {
    const params = { commandId: uuidv7(), sessionId };
    if (turnId) params.turnId = turnId;
    return this.request("session/compact", params);
  }
  sessionUserShell(sessionId, commandText) {
    return this.request("session/userShell", { commandId: uuidv7(), sessionId, commandText });
  }
  turnSteer(sessionId, expectedTurnId, text, { reasoningEffort = null } = {}) {
    const params = { commandId: uuidv7(), sessionId, expectedTurnId, input: [{ type: "text", text }] };
    if (reasoningEffort) params.reasoningEffort = reasoningEffort;
    return this.request("turn/steer", params);
  }
  turnUnqueue(sessionId, turnId) {
    return this.request("turn/unqueue", { commandId: uuidv7(), sessionId, turnId });
  }
  userInputClarify({ sessionId, userInputId, text }) {
    return this.request("userInput/clarify", {
      commandId: uuidv7(),
      sessionId,
      userInputId,
      clarification: { format: "text", content: String(text || "").slice(0, 500) },
    });
  }
  viewUnsubscribe(sessionId) {
    return this.request("view/unsubscribe", { sessionId });
  }
  subagentSendMessage(sessionId, subagentId, body) {
    return this.request("subagent/sendMessage", { commandId: uuidv7(), sessionId, subagentId, body });
  }
  subagentFollowupTask(sessionId, subagentId, body) {
    return this.request("subagent/followupTask", { commandId: uuidv7(), sessionId, subagentId, body });
  }
  subagentReadResult(sessionId, subagentId) {
    return this.request("subagent/readResult", { commandId: uuidv7(), sessionId, subagentId });
  }
  subagentStop(sessionId, subagentId, reason = null) {
    const params = { commandId: uuidv7(), sessionId, subagentId };
    if (reason) params.reason = reason;
    return this.request("subagent/stop", params);
  }
  subagentClose(sessionId, subagentId, reason = null) {
    const params = { commandId: uuidv7(), sessionId, subagentId };
    if (reason) params.reason = reason;
    return this.request("subagent/close", params);
  }
  subagentInterrupt(sessionId, subagentId, reason = null) {
    const params = { commandId: uuidv7(), sessionId, subagentId };
    if (reason) params.reason = reason;
    return this.request("subagent/interrupt", params);
  }
  subagentReopen(sessionId, subagentId) {
    return this.request("subagent/reopen", { commandId: uuidv7(), sessionId, subagentId });
  }
  subagentResume(sessionId, subagentId) {
    return this.request("subagent/resume", { commandId: uuidv7(), sessionId, subagentId });
  }
}

module.exports = { MspHost, uuidv7 };
