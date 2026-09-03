// CLI ops: shell out to the local `muse` binary for non-MSP surfaces.
// Allowlisted subcommands only; --json passthrough where supported.
"use strict";

const { execFile } = require("node:child_process");

const BIN = process.env.MUSE_BIN || "muse";
const TIMEOUT = 30000;

function run(args, { stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = execFile(BIN, args, { timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || "");
      const errText = String(stderr || "");
      // Prefer JSON when the CLI emits it, else return raw text.
      const trimmed = out.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          resolve({ ok: !err, json: JSON.parse(trimmed), text: out, stderr: errText });
          return;
        } catch {
          /* fall through to text */
        }
      }
      resolve({ ok: !err, text: out || errText, stderr: errText, error: err ? err.message : null });
    });
    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

async function skills(action, { skill = null, scope = null, workspace = null, json = true } = {}) {
  const args = ["skills", action];
  if (skill) args.push(skill);
  if (scope) args.push("--scope", scope);
  if (workspace) args.push("--workspace", workspace);
  if (json) args.push("--json");
  return run(args);
}

async function plugins(action, args2 = []) {
  return run(["plugins", action, ...args2, "--json"]);
}

module.exports = { run, skills, plugins, BIN };
