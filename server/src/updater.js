// Self-update: rebuild the desktop app from a local repo checkout,
// replace /Applications/OpenMuse.app, and relaunch. The heavy work runs
// in a detached script (server/src/update-app.sh) that outlives the app
// server itself; here we only resolve inputs and spawn it.
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATUS_FILE = path.join(os.tmpdir(), "openmuse-update-status.json");

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
  } catch {
    return { phase: "idle", ok: false };
  }
}

function isRepoDir(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return (
      !!pkg &&
      pkg.name === "openmuse" &&
      fs.existsSync(path.join(dir, "electron", "package.json")) &&
      fs.existsSync(path.join(dir, "web", "package.json"))
    );
  } catch {
    return false;
  }
}

function resolveRepo(hint) {
  // An explicit path is authoritative: a bad one errors instead of silently
  // building some other checkout.
  if (hint) {
    try {
      const p = path.resolve(hint.startsWith("~") ? path.join(os.homedir(), hint.slice(1)) : hint);
      if (isRepoDir(p)) return { repo: p };
    } catch {
      /* fall through to the error below */
    }
    return { error: `not an openmuse checkout: ${hint}` };
  }
  const cands = [];
  if (process.env.OPENMUSE_REPO) cands.push(process.env.OPENMUSE_REPO);
  cands.push(process.cwd());
  for (const c of cands) {
    try {
      const p = path.resolve(c.startsWith("~") ? path.join(os.homedir(), c.slice(1)) : c);
      if (isRepoDir(p)) return { repo: p };
    } catch {
      /* try next candidate */
    }
  }
  return { error: "no openmuse repo found — enter the checkout path explicitly" };
}

function resolveBin(name) {
  const extra = (process.env.PATH || "").split(":").filter(Boolean);
  const home = os.homedir();
  const fallbacks = [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  for (const d of [...extra, ...fallbacks]) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* try next dir */
    }
  }
  return null;
}

function failStatus(message) {
  try {
    const cur = readStatus();
    fs.writeFileSync(
      STATUS_FILE,
      JSON.stringify({ ...cur, phase: "failed", ok: false, error: message }),
    );
  } catch {
    /* status unreadable; nothing more we can report */
  }
}

// The worker script ships inside server/src, but in the packaged app that
// directory lives inside the asar archive, which /bin/bash cannot execute
// directly. Stage a real copy into the temp dir first.
function stageScript() {
  const staged = path.join(os.tmpdir(), "openmuse-update-app.sh");
  const src = fs.readFileSync(path.join(__dirname, "update-app.sh"));
  fs.writeFileSync(staged, src, { mode: 0o755 });
  fs.chmodSync(staged, 0o755);
  return staged;
}

function startUpdate({ repo } = {}) {
  const found = resolveRepo(repo);
  if (found.error) return { started: false, error: found.error };
  const npm = resolveBin("npm");
  if (!npm) return { started: false, error: "npm not found on PATH" };
  let script;
  try {
    script = stageScript();
  } catch (e) {
    return { started: false, error: `could not stage updater script: ${e.message}` };
  }
  const log = path.join(os.tmpdir(), `openmuse-update-${Date.now()}.log`);
  fs.writeFileSync(STATUS_FILE, JSON.stringify({ phase: "starting", ok: false, repo: found.repo, log }));
  const child = spawn("/bin/bash", [script], {
    detached: true,
    stdio: "ignore",
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      REPO: found.repo,
      NPM_BIN: npm,
      STATUS_FILE,
      LOG_FILE: log,
      PORT: String(process.env.PORT || 3101),
    },
  });
  child.on("error", (err) => {
    failStatus(`could not launch updater: ${err.message}`);
  });
  child.on("exit", (code) => {
    // A healthy run takes minutes. An instant non-zero exit means the worker
    // died before reporting — surface that instead of "starting" forever.
    if (code === 0 || code === null) return;
    try {
      const cur = readStatus();
      if (cur.phase === "starting") {
        failStatus(`updater exited immediately (code ${code}); see log`);
      }
    } catch {
      /* ignore */
    }
  });
  child.unref();
  return { started: true, repo: found.repo, log, pid: child.pid };
}

function readLogTail(maxBytes = 4000) {
  const st = readStatus();
  if (!st.log) return "";
  try {
    const buf = fs.readFileSync(st.log);
    return buf.slice(Math.max(0, buf.length - maxBytes)).toString("utf8");
  } catch {
    return "";
  }
}

module.exports = { startUpdate, readStatus, readLogTail, resolveRepo };
