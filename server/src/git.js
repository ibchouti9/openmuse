// Git ops for the workspace folder: status, commit, push, PR creation.
// Shells out to `git` (and `gh` for PRs) with an explicit cwd; no shell.
"use strict";

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MAX_FILES = 200;
const MAX_MESSAGE = 2000;

function resolveDir(workspace) {
  let dir = workspace != null ? String(workspace).trim() : "";
  if (!dir) dir = process.cwd();
  else if (dir.startsWith("~")) dir = path.join(os.homedir(), dir.slice(1));
  dir = path.resolve(dir);
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    throw new Error(`workspace not found: ${dir}`);
  }
  if (!st.isDirectory()) throw new Error(`not a directory: ${dir}`);
  return dir;
}

function run(bin, args, { cwd, timeout = 30000, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message).trim().slice(0, 2000);
        const e = new Error(detail || `${bin} failed`);
        e.code = err.code;
        reject(e);
        return;
      }
      resolve(String(stdout || ""));
    });
    if (input != null) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

function git(cwd, args, opts = {}) {
  return run("git", args, { cwd, ...opts });
}

async function toplevel(cwd) {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
}

function parseBranchLine(line) {
  let branch = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  const m = /^##\s+(?:No commits yet on\s+)?([^\s]+?)(?:\.\.\.([^\s\[]+))?(?:\s+\[(.*)\])?\s*$/.exec(line || "");
  if (m) {
    branch = m[1] || null;
    upstream = m[2] || null;
    const flags = m[3] || "";
    const a = /ahead (\d+)/.exec(flags);
    const b = /behind (\d+)/.exec(flags);
    if (a) ahead = Number(a[1]);
    if (b) behind = Number(b[1]);
  }
  return { branch, upstream, ahead, behind };
}

async function status(workspace) {
  const dir = resolveDir(workspace);
  const root = await toplevel(dir);
  if (!root) return { ok: true, repo: false, root: dir };
  const out = await git(root, ["status", "--porcelain=v1", "-b"]);
  const lines = out.split("\n");
  const head = parseBranchLine(lines[0]);
  const files = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const code = line.slice(0, 2);
    let p = line.slice(3);
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) {
      try {
        p = JSON.parse(p);
      } catch {
        /* keep the quoted form */
      }
    }
    const untracked = code === "??";
    const staged = !untracked && code[0] !== " " && code[0] !== "?";
    const unstaged = !untracked && code[1] !== " ";
    files.push({ path: p, code, staged, unstaged, untracked });
  }
  const remotes = (await git(root, ["remote"])).trim();
  return {
    ok: true,
    repo: true,
    root,
    branch: head.branch,
    upstream: head.upstream,
    ahead: head.ahead,
    behind: head.behind,
    hasRemote: remotes.length > 0,
    staged: files.filter((f) => f.staged).length,
    unstaged: files.filter((f) => f.unstaged).length,
    untracked: files.filter((f) => f.untracked).length,
    total: files.length,
    truncated: files.length > MAX_FILES,
    files: files.slice(0, MAX_FILES),
  };
}

async function currentBranch(root) {
  return (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

async function pushRepo(root) {
  try {
    return (await git(root, ["push"], { timeout: 120000 })).trim();
  } catch (e) {
    if (/no upstream|has no upstream|set.*upstream/i.test(e.message)) {
      const branch = await currentBranch(root);
      if (branch === "HEAD") throw new Error("detached HEAD; check out a branch to push");
      const remotes = (await git(root, ["remote"])).split("\n").map((s) => s.trim()).filter(Boolean);
      const remote = remotes.includes("origin") ? "origin" : remotes[0];
      if (!remote) throw new Error("no git remote configured; add one to push");
      return (await git(root, ["push", "-u", remote, branch], { timeout: 120000 })).trim();
    }
    throw e;
  }
}

async function commit(workspace, message, push = false) {
  const msg = String(message || "").trim();
  if (!msg) throw new Error("commit message required");
  if (msg.length > MAX_MESSAGE) throw new Error(`commit message over ${MAX_MESSAGE} characters`);
  const dir = resolveDir(workspace);
  const root = await toplevel(dir);
  if (!root) throw new Error(`not a git repository: ${dir}`);
  const before = await status(root);
  if (before.total === 0 && !push) throw new Error("nothing to commit");
  let hash = null;
  if (before.total > 0) {
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", msg]);
    hash = (await git(root, ["rev-parse", "--short", "HEAD"])).trim();
  }
  let pushed = false;
  let pushOutput = "";
  if (push) {
    pushOutput = await pushRepo(root);
    pushed = true;
  }
  return { ok: true, hash, pushed, pushOutput: pushOutput.slice(-2000), status: await status(root) };
}

async function push(workspace) {
  const dir = resolveDir(workspace);
  const root = await toplevel(dir);
  if (!root) throw new Error(`not a git repository: ${dir}`);
  const pushOutput = await pushRepo(root);
  return { ok: true, pushed: true, pushOutput: pushOutput.slice(-2000), status: await status(root) };
}

async function pr(workspace, { title, body = "", base = "", draft = false } = {}) {
  const t = String(title || "").trim();
  if (!t) throw new Error("PR title required");
  const dir = resolveDir(workspace);
  const root = await toplevel(dir);
  if (!root) throw new Error(`not a git repository: ${dir}`);
  const st = await status(root);
  if (st.total > 0) throw new Error("uncommitted changes present; commit or stash first");
  const args = ["pr", "create", "--title", t];
  if (String(base || "").trim()) args.push("--base", String(base).trim());
  if (draft) args.push("--draft");
  let out;
  try {
    out = await run("gh", [...args, "--body-file", "-"], { cwd: root, timeout: 120000, input: String(body || "") });
  } catch (e) {
    if (e.code === "ENOENT") throw new Error("gh CLI not found on the server; install it to create PRs");
    throw e;
  }
  const url = (out.match(/https?:\/\/\S+/) || [out.trim().split("\n").pop()])[0];
  return { ok: true, url };
}

module.exports = { status, commit, push, pr };
