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
app.use(express.json({ limit: "1mb" }));

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

app.get("/api/sessions", async (req, res) => {
  try {
    res.json(await host.sessionList({ limit: 50 }));
  } catch (e) {
    sendError(res, e);
  }
});

app.post("/api/session/start", async (req, res) => {
  try {
    const { modelId, approvalMode, workspaceRoot } = req.body || {};
    // workspaceRoot unlocks the host's file/shell tools; default to ours.
    const result = await host.sessionStart({
      modelId,
      approvalMode,
      workspaceRoot: workspaceRoot || host.workspace || process.cwd(),
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
    const { sessionId, text, reasoningEffort } = req.body || {};
    if (!sessionId || !text) return res.status(400).json({ error: "sessionId and text required" });
    res.json(await host.turnStart(sessionId, text, { reasoningEffort }));
  } catch (e) {
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
    res.json(await host.viewPage({ sessionId, cursor: cursor || null }));
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

async function collectTranscript(sessionId) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const r = await host.viewPage({ sessionId, cursor, limit: 500 });
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
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
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
