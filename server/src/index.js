// OpenMuse server: MSP host on stdin, SSE + REST for the web UI.
"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const express = require("express");
const cors = require("cors");
const { MspHost } = require("./msp");

const PORT = Number(process.env.PORT || 3101);
const MOCK = process.env.OPENMUSE_MOCK === "1";

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// ---- event hub (SSE) ----
const clients = new Set();
function broadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch {
      clients.delete(res);
    }
  }
}

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: hello\ndata: {"ok":true}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

// SSE heartbeat: comment frames keep idle phone/proxy connections alive.
// Native EventSource ignores comment lines, so subscribed UIs are unaffected.
const _heartbeatMs = Number(process.env.OPENMUSE_SSE_HEARTBEAT_MS || 25000);
const SSE_HEARTBEAT_MS = Number.isFinite(_heartbeatMs) && _heartbeatMs >= 1000 ? _heartbeatMs : 25000;
setInterval(() => {
  for (const res of clients) {
    try {
      res.write(`: ping\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}, SSE_HEARTBEAT_MS);

// ---- host (real or mock) ----
let host;
if (MOCK) {
  host = require("./mock");
  console.log("[openmuse] MOCK host enabled (no model calls)");
} else {
  const extra = (process.env.MUSE_EXTRA_ARGS || "").split(" ").filter(Boolean);
  host = new MspHost({ extraArgs: extra });
  host.on("host-log", (text) => broadcast("host-log", { text }));
  host.on("status", (s) => broadcast("status", s));
  host.start();
}
host.on("notification", (msg) => {
  const params = msg.params || msg;
  broadcast("msp", { method: msg.method || "message", params });
});

function sendError(res, err) {
  const msg = (err && err.message) || "request failed";
  const code = /not running|not connected/i.test(msg) ? 503 : 500;
  res.status(code).json({ error: msg });
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, mock: MOCK, host: host.status() });
});

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

app.get("/api/sessions", async (req, res) => {
  try {
    // Cursor is opaque: pass through verbatim, never parse as a number.
    const limit = clampInt(req.query.limit, 50, 1, 100);
    let cursor = req.query.cursor ?? null;
    if (cursor === "") cursor = null;
    res.json(await host.sessionList({ limit, cursor }));
  } catch (e) {
    sendError(res, e);
  }
});

app.post("/api/session/start", async (req, res) => {
  try {
    const { modelId, approvalMode, workspaceRoot, providerId, sessionId } = req.body || {};
    // workspaceRoot unlocks the host's file/shell tools; default to ours.
    const result = await host.sessionStart({
      modelId,
      approvalMode,
      workspaceRoot: workspaceRoot || host.workspace || process.cwd(),
      providerId: providerId || null,
      sessionId: sessionId || null,
    });
    if (result && result.session && result.session.sessionId) {
      broadcast("msp", { method: "session/started", params: { session: result.session } });
    }
    res.json(result);
  } catch (e) {
    sendError(res, e);
  }
});

app.post("/api/session/resume", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    res.json(await host.sessionResume(sessionId));
  } catch (e) {
    sendError(res, e);
  }
});

app.post("/api/turn", async (req, res) => {
  try {
    const { sessionId, text = "", reasoningEffort, images = [] } = req.body || {};
    if (!Array.isArray(images)) return res.status(400).json({ error: "images must be an array" });
    if (!sessionId || (typeof text !== "string" || (!text && images.length === 0))) {
      return res.status(400).json({ error: "sessionId and text (or images) required" });
    }
    if (images.length > 8) return res.status(400).json({ error: "at most 8 images per turn" });
    const clean = images.map((img) => {
      if (!img || img.type !== undefined && img.type !== "image") throw new Error("invalid image part");
      if (typeof img.mediaType !== "string" || !img.mediaType.startsWith("image/")) {
        throw new Error("image mediaType must start with image/");
      }
      if (typeof img.base64Data !== "string" || !img.base64Data) throw new Error("image base64Data required");
      const bytes = Buffer.from(img.base64Data, "base64");
      if (!bytes.length) throw new Error("invalid image base64");
      if (bytes.length > 12 * 1024 * 1024) throw new Error("image over 12MB decoded");
      const part = { mediaType: img.mediaType, base64Data: img.base64Data };
      if (Number.isInteger(img.width) && Number.isInteger(img.height)) {
        part.width = img.width;
        part.height = img.height;
      }
      return part;
    });
    res.json(await host.turnStart(sessionId, text, { reasoningEffort, images: clean }));
  } catch (e) {
    if (/^(invalid|image|at most)/.test(e.message)) return res.status(400).json({ error: e.message });
    sendError(res, e);
  }
});

app.post("/api/interrupt", async (req, res) => {
  try {
    const { sessionId, turnId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    res.json(await host.turnInterrupt(sessionId, turnId));
  } catch (e) {
    sendError(res, e);
  }
});

// turn/cancel alias (schema name); same host op as interrupt.
app.post("/api/turn/cancel", async (req, res) => {
  try {
    const { sessionId, turnId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const fn = typeof host.turnCancel === "function" ? host.turnCancel.bind(host) : host.turnInterrupt.bind(host);
    res.json(await fn(sessionId, turnId));
  } catch (e) {
    sendError(res, e);
  }
});

app.post("/api/approval/decide", async (req, res) => {
  try {
    const { sessionId, approvalId, choiceId, requirementId, feedback } = req.body || {};
    if (!sessionId || !approvalId || !choiceId || !requirementId) {
      return res.status(400).json({ error: "sessionId, approvalId, choiceId, requirementId required" });
    }
    res.json(await host.approvalDecide({ sessionId, approvalId, choiceId, requirementId, feedback: feedback ?? null }));
  } catch (e) {
    sendError(res, e);
  }
});

app.post("/api/input/answer", async (req, res) => {
  try {
    const { sessionId, userInputId, answers } = req.body || {};
    if (!sessionId || !userInputId || !Array.isArray(answers)) {
      return res.status(400).json({ error: "sessionId, userInputId, answers[] required" });
    }
    res.json(await host.userInputAnswer({ sessionId, userInputId, answers }));
  } catch (e) {
    sendError(res, e);
  }
});

app.post("/api/input/cancel", async (req, res) => {
  try {
    const { sessionId, userInputId } = req.body || {};
    if (!sessionId || !userInputId) return res.status(400).json({ error: "sessionId and userInputId required" });
    res.json(await host.userInputCancel({ sessionId, userInputId }));
  } catch (e) {
    sendError(res, e);
  }
});

app.get("/api/view", async (req, res) => {
  try {
    const { sessionId, cursor } = req.query;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const limit = clampInt(req.query.limit, 200, 1, 500);
    res.json(await host.viewPage({ sessionId, cursor: cursor || null, limit }));
  } catch (e) {
    sendError(res, e);
  }
});

app.get("/api/transcript", async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    res.json({ items: await collectTranscript(sessionId) });
  } catch (e) {
    sendError(res, e);
  }
});

// Bounded walk: small pages keep stdio frames small and each page fails
// fast (30s) instead of hanging export/transcript behind a 120s default.
const TRANSCRIPT_PAGE_LIMIT = 200;
const TRANSCRIPT_MAX_PAGES = 10;
const TRANSCRIPT_PAGE_TIMEOUT_MS = 30000;

async function collectTranscript(sessionId) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < TRANSCRIPT_MAX_PAGES; page++) {
    const r = await host.viewPage({ sessionId, cursor, limit: TRANSCRIPT_PAGE_LIMIT, timeoutMs: TRANSCRIPT_PAGE_TIMEOUT_MS });
    for (const e of r.events || []) {
      if (e.params && e.params.item && e.params.item.itemId) items.push(e.params.item);
    }
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  const latest = new Map();
  for (const it of items) latest.set(it.itemId, it);
  return [...latest.values()];
}

// Export/share: same transcript walk as /api/transcript, wrapped with metadata.
app.get("/api/session/export", async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      return res.status(400).json({ error: "sessionId required" });
    }
    const items = await collectTranscript(sessionId);
    res.json({ sessionId, exportedAt: new Date().toISOString(), items });
  } catch (e) {
    sendError(res, e);
  }
});

app.get("/api/dirs", (req, res) => {
  try {
    let p = req.query.path || os.homedir();
    if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
    p = path.resolve(p);
    const st = fs.statSync(p);
    if (!st.isDirectory()) return res.status(400).json({ error: "not a directory" });
    const entries = fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ path: p, parent: path.dirname(p) === p ? null : path.dirname(p), entries });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/models", async (req, res) => {
  try {
    res.json(await host.modelList());
  } catch (e) {
    sendError(res, e);
  }
});

app.post("/api/session/approval-mode", async (req, res) => {
  try {
    const { sessionId, mode } = req.body || {};
    if (!sessionId || !mode) return res.status(400).json({ error: "sessionId and mode required" });
    res.json(await host.setApprovalMode(sessionId, mode));
  } catch (e) {
    sendError(res, e);
  }
});

app.post("/api/session/model", async (req, res) => {
  try {
    const { sessionId, modelId } = req.body || {};
    if (!sessionId || !modelId) return res.status(400).json({ error: "sessionId and modelId required" });
    res.json(await host.setModel(sessionId, modelId));
  } catch (e) {
    sendError(res, e);
  }
});

// ---- full MSP parity ----
app.get("/api/approvals/pending", async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    res.json(await host.approvalListPending(sessionId));
  } catch (e) {
    sendError(res, e);
  }
});
app.get("/api/session/read", async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    res.json(await host.sessionRead(sessionId, { excludeItems: req.query.excludeItems !== "false" }));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/session/fork", async (req, res) => {
  try {
    const { sessionId, cutPoint } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    res.json(await host.sessionFork(sessionId, { cutPoint: cutPoint || null }));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/session/compact", async (req, res) => {
  try {
    const { sessionId, turnId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    res.json(await host.sessionCompact(sessionId, { turnId: turnId || null }));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/session/shell", async (req, res) => {
  try {
    const { sessionId, commandText } = req.body || {};
    if (!sessionId || !commandText) return res.status(400).json({ error: "sessionId and commandText required" });
    res.json(await host.sessionUserShell(sessionId, commandText));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/turn/steer", async (req, res) => {
  try {
    const { sessionId, expectedTurnId, text, reasoningEffort } = req.body || {};
    if (!sessionId || !expectedTurnId || !text) return res.status(400).json({ error: "sessionId, expectedTurnId and text required" });
    res.json(await host.turnSteer(sessionId, expectedTurnId, text, { reasoningEffort: reasoningEffort || null }));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/turn/unqueue", async (req, res) => {
  try {
    const { sessionId, turnId } = req.body || {};
    if (!sessionId || !turnId) return res.status(400).json({ error: "sessionId and turnId required" });
    res.json(await host.turnUnqueue(sessionId, turnId));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/input/clarify", async (req, res) => {
  try {
    const { sessionId, userInputId, text } = req.body || {};
    if (!sessionId || !userInputId || !text) return res.status(400).json({ error: "sessionId, userInputId and text required" });
    res.json(await host.userInputClarify({ sessionId, userInputId, text }));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/view/unsubscribe", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    res.json(await host.viewUnsubscribe(sessionId));
  } catch (e) {
    sendError(res, e);
  }
});
function subagentTarget(body) {
  const { sessionId, subagentId } = body || {};
  return sessionId && subagentId ? { sessionId, subagentId } : null;
}
for (const [route, method] of [
  ["/api/subagent/message", "subagentSendMessage"],
  ["/api/subagent/followup", "subagentFollowupTask"],
  ["/api/subagent/read", "subagentReadResult"],
  ["/api/subagent/stop", "subagentStop"],
  ["/api/subagent/close", "subagentClose"],
  ["/api/subagent/interrupt", "subagentInterrupt"],
  ["/api/subagent/reopen", "subagentReopen"],
  ["/api/subagent/resume", "subagentResume"],
]) {
  app.post(route, async (req, res) => {
    try {
      const t = subagentTarget(req.body);
      if (!t) return res.status(400).json({ error: "sessionId and subagentId required" });
      const { body, reason } = req.body || {};
      if (method === "subagentSendMessage" || method === "subagentFollowupTask") {
        if (!body) return res.status(400).json({ error: "body required" });
        res.json(await host[method](t.sessionId, t.subagentId, body));
      } else if (method === "subagentStop" || method === "subagentClose" || method === "subagentInterrupt") {
        res.json(await host[method](t.sessionId, t.subagentId, reason || null));
      } else {
        res.json(await host[method](t.sessionId, t.subagentId));
      }
    } catch (e) {
      sendError(res, e);
    }
  });
}

// ---- CLI-ops parity (shell out to local muse binary) ----
const cli = require("./cli");
app.get("/api/cli/version", async (req, res) => {
  try {
    res.json(await cli.run(["--version"]));
  } catch (e) {
    sendError(res, e);
  }
});
app.get("/api/skills", async (req, res) => {
  try {
    const { source = "all", workspace } = req.query;
    const args = ["skills", "list", "--source", String(source), ...(workspace ? ["--workspace", String(workspace)] : []), "--json"];
    res.json(await cli.run(args));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/skills/action", async (req, res) => {
  try {
    const { action, skill, scope, workspace, extra = [] } = req.body || {};
    if (!["enable", "disable", "inspect", "validate", "update", "uninstall", "install", "import", "user-only", "list"].includes(action)) {
      return res.status(400).json({ error: "unsupported skills action" });
    }
    if (action === "install" || action === "import") {
      const args = ["skills", action, ...(skill ? [skill] : []), ...extra, "--json"];
      res.json(await cli.run(args));
      return;
    }
    res.json(await cli.skills(action, { skill, scope, workspace }));
  } catch (e) {
    sendError(res, e);
  }
});
app.get("/api/plugins", async (req, res) => {
  try {
    res.json(await cli.run(["plugins", "list", "--json"]));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/plugins/action", async (req, res) => {
  try {
    const { action, id, extra = [] } = req.body || {};
    if (!["inspect", "enable", "disable", "update", "remove", "validate", "approve", "reject", "install", "list", "marketplace"].includes(action)) {
      return res.status(400).json({ error: "unsupported plugins action" });
    }
    if (action === "marketplace") {
      // extra: ["add", name, source] | ["list"] | ["update", name] | ["remove", name]
      res.json(await cli.run(["plugins", "marketplace", ...extra, "--json"]));
      return;
    }
    const args = id ? [id, ...extra] : extra;
    res.json(await cli.plugins(action, args));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/exec", async (req, res) => {
  try {
    const b = req.body || {};
    const { prompt } = b;
    if (!prompt) return res.status(400).json({ error: "prompt required" });
    const args = ["exec", "--json"];
    const push = (flag, val) => {
      if (val !== undefined && val !== null && String(val) !== "") args.push(flag, String(val));
    };
    push("--provider", b.provider);
    push("--preset", b.preset);
    push("--permission-profile", b.permissionProfile);
    push("--model", b.model);
    push("--reasoning-effort", b.reasoningEffort);
    push("--base-url", b.baseUrl);
    for (const img of String(b.image || "").split(",").map((s) => s.trim()).filter(Boolean)) args.push("--image", img);
    push("--workspace", b.workspace);
    if (b.worktree) args.push("--worktree", String(b.worktree));
    push("--worktree-base", b.worktreeBase);
    push("--worktree-existing", b.worktreeExisting);
    if (b.parallelCalls === "on") args.push("--parallel-tool-calls");
    if (b.parallelCalls === "off") args.push("--no-parallel-tool-calls");
    push("--context-compaction-strategy", b.compaction);
    push("--context-compaction-soft-threshold", b.compactionSoft);
    push("--context-compaction-hard-threshold", b.compactionHard);
    push("--max-model-steps", b.maxSteps);
    push("--max-tool-output-bytes", b.maxToolBytes);
    push("--session-id", b.sessionId);
    if (b.allowWorkspaceSwitch) args.push("--allow-workspace-switch");
    if (b.userInputAutoResolve) args.push("--user-input-auto-resolve");
    if (b.subagentIsolation) args.push("--subagent-worktree-isolation");
    if (b.disableWeb) args.push("--disable-web-tools");
    if (b.noForeignCtx) args.push("--no-foreign-personal-context");
    if (b.noSessionLog) args.push("--no-session-log");
    // CLI vocabulary only: untrusted|on-request|never. MSP wire values
    // (allowAll|promptUnmatched|onRequest|denyUnmatched) are chat-only.
    if (b.approvalMode !== undefined && b.approvalMode !== null && String(b.approvalMode) !== "") {
      if (!["untrusted", "on-request", "never"].includes(String(b.approvalMode))) {
        return res.status(400).json({ error: "approvalMode must be untrusted|on-request|never for exec (MSP values allowAll|promptUnmatched|onRequest|denyUnmatched are chat-only)" });
      }
      args.push("--approval-mode", String(b.approvalMode));
    }
    if (b.approvalJudge !== undefined && b.approvalJudge !== null && String(b.approvalJudge) !== "") {
      if (!["off", "on"].includes(String(b.approvalJudge))) {
        return res.status(400).json({ error: "approvalJudge must be off|on" });
      }
      args.push("--approval-judge", String(b.approvalJudge));
    }
    if (b.agents) push("--agents", b.agents);
    if (b.yolo) args.push("--yolo");
    if (b.trustWorkspace) args.push("--trust-workspace");
    if (b.disableApproval) args.push("--disable-approval");
    if (b.disableSandbox) args.push("--disable-sandbox");
    push("--sandbox-network", b.sandboxNetwork);
    if (b.disableWrite) args.push("--disable-write");
    if (b.disableShell) args.push("--disable-shell");
    if (b.enableShellTool) args.push("--enable-shell-tool");
    args.push(prompt);
    res.json(await cli.run(args));
  } catch (e) {
    sendError(res, e);
  }
});
app.get("/api/trace", async (req, res) => {
  try {
    const { sessionLog, fixture, runLog, taskLog, format = "text" } = req.query;
    const args = ["trace", "inspect", "--format", String(format)];
    if (fixture) args.push("--fixture", String(fixture));
    else if (sessionLog) args.push("--session-log", String(sessionLog));
    else if (runLog) args.push("--run-log", String(runLog));
    else if (taskLog) args.push("--task-log", String(taskLog));
    else return res.status(400).json({ error: "fixture, sessionLog, runLog or taskLog required" });
    res.json(await cli.run(args));
  } catch (e) {
    sendError(res, e);
  }
});
app.get("/api/export", async (req, res) => {
  try {
    const { session, redacted } = req.query;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openmuse-export-"));
    const out = path.join(dir, "export.json");
    const args = ["export"];
    if (session) args.push("--session", String(session));
    else args.push("--last");
    if (String(redacted) === "1") args.push("--redacted");
    args.push("--out", out);
    const r = await cli.run(args);
    let doc = null;
    try {
      doc = JSON.parse(fs.readFileSync(out, "utf8"));
    } catch {
      /* export writes the file; absence means the CLI reported the error */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    res.json({ ...r, doc });
  } catch (e) {
    sendError(res, e);
  }
});
app.get("/api/session-messages", async (req, res) => {
  try {
    res.json(await cli.run(["session-message", "list", "--json"]));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/session-messages/send", async (req, res) => {
  try {
    const { target, message, inReplyTo } = req.body || {};
    if (!target || !message) return res.status(400).json({ error: "target and message required" });
    const args = ["session-message", "send", "--target", target, ...(inReplyTo ? ["--in-reply-to", inReplyTo] : []), "--json"];
    res.json(await cli.run(args, { stdin: message }));
  } catch (e) {
    sendError(res, e);
  }
});
app.get("/api/sandbox", async (req, res) => {
  try {
    res.json(await cli.run(["sandbox", "windows", "check"]));
  } catch (e) {
    sendError(res, e);
  }
});
app.get("/api/schema", async (req, res) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openmuse-schema-"));
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync(cli.BIN, ["schema", "generate-json-schema", "--out", dir], { encoding: "utf8", timeout: 15000 });
    const methods = JSON.parse(fs.readFileSync(path.join(dir, "msp.schema.json"), "utf8"));
    res.json({ ok: true, out: String(out).slice(0, 500), methods: Object.keys(methods.methods || {}), notifications: Object.keys(methods.notifications || {}) });
  } catch (e) {
    sendError(res, e);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});
app.get("/api/config/status", async (req, res) => {
  try {
    res.json(await cli.run(["config", "status"]));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/init", async (req, res) => {
  try {
    const { force, dryRun } = req.body || {};
    const args = ["init", ...(dryRun ? ["--dry-run"] : []), ...(force ? ["--force"] : [])];
    res.json(await cli.run(args));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/config/validate", async (req, res) => {
  try {
    const { plane, file } = req.body || {};
    if (!plane || !file) return res.status(400).json({ error: "plane and file required" });
    if (!["defaults", "policy"].includes(plane)) return res.status(400).json({ error: "plane must be defaults|policy" });
    res.json(await cli.run(["config", "validate", "--plane", plane, "--file", file]));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/auth/logout", async (req, res) => {
  try {
    res.json(await cli.run(["logout"]));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/auth/set", async (req, res) => {
  try {
    const { apiKey, provider } = req.body || {};
    if (!apiKey) return res.status(400).json({ error: "apiKey required" });
    if (provider && String(provider) !== "meta") {
      return res.status(400).json({ error: "provider must be meta (the only value `muse auth set` accepts)" });
    }
    const args = ["auth", "set", ...(provider ? ["--provider", provider] : []), "--api-key-stdin"];
    res.json(await cli.run(args, { stdin: apiKey }));
  } catch (e) {
    sendError(res, e);
  }
});

// ---- git ops for the workspace folder ----
const gitops = require("./git");
app.get("/api/git/status", async (req, res) => {
  try {
    res.json(await gitops.status(req.query.workspace || ""));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/git/commit", async (req, res) => {
  try {
    const { workspace, message, push } = req.body || {};
    res.json(await gitops.commit(workspace || "", message, push === true));
  } catch (e) {
    if (/required|nothing to commit|not a git repository|over \d+ characters/i.test(e.message)) {
      return res.status(400).json({ error: e.message });
    }
    sendError(res, e);
  }
});
app.post("/api/git/message", async (req, res) => {
  try {
    const { workspace } = req.body || {};
    res.json(await gitops.generateMessage(workspace || ""));
  } catch (e) {
    if (/nothing to commit|not a git repository/i.test(e.message)) {
      return res.status(400).json({ error: e.message });
    }
    sendError(res, e);
  }
});
app.post("/api/git/push", async (req, res) => {
  try {
    const { workspace } = req.body || {};
    res.json(await gitops.push(workspace || ""));
  } catch (e) {
    sendError(res, e);
  }
});
app.post("/api/git/pr", async (req, res) => {
  try {
    const { workspace, title, body, base, draft } = req.body || {};
    res.json(await gitops.pr(workspace || "", { title, body, base, draft: draft === true }));
  } catch (e) {
    if (/required|uncommitted changes|not a git repository/i.test(e.message)) {
      return res.status(400).json({ error: e.message });
    }
    sendError(res, e);
  }
});

// ---- self-update: rebuild the desktop app from a local checkout ----
const updater = require("./updater");
app.post("/api/dev/update", (req, res) => {
  try {
    const { repo, dryRun } = req.body || {};
    if (dryRun) {
      const found = updater.resolveRepo(repo);
      if (found.error) return res.status(400).json({ error: found.error });
      return res.json({
        ok: true,
        repo: found.repo,
        plan: ["install-deps", "build (npm run dist)", "quit app", "swap bundle", "relaunch"],
      });
    }
    const r = updater.startUpdate({ repo });
    if (!r.started) return res.status(400).json({ error: r.error });
    res.status(202).json(r);
  } catch (e) {
    sendError(res, e);
  }
});
app.get("/api/dev/update-status", (req, res) => {
  try {
    res.json({ ...updater.readStatus(), logTail: updater.readLogTail() });
  } catch (e) {
    sendError(res, e);
  }
});

// ---- serve built web UI when present ----
const dist = process.env.OPENMUSE_WEB_DIR || path.join(__dirname, "..", "..", "web", "dist");
if (fs.existsSync(path.join(dist, "index.html"))) {
  app.use(express.static(dist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(dist, "index.html"));
  });
  console.log("[openmuse] serving web UI from", dist);
} else {
  app.get("/", (req, res) => res.json({ ok: true, ui: "run `npm run build` in web/ to serve the UI here" }));
}

const HOST = process.env.HOST || "127.0.0.1";
const server = app.listen(PORT, HOST, () => {
  const a = server.address();
  console.log(`[openmuse] listening on http://${a.address}:${a.port}`);
});
server.on("error", (err) => {
  console.error(`[openmuse] cannot listen on ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});
