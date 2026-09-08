// Git ops for the workspace folder: status, commit, push, PR creation.
// Shells out to `git` (and `gh` for PRs) with an explicit cwd; no shell.
"use strict";

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MAX_FILES = 200;
const MAX_MESSAGE = 2000;
const MAX_DIFF_BYTES = 12000;
const MESSAGE_TIMEOUT_MS = 90000;
const MUSE_BIN = process.env.MUSE_BIN || "muse";

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

// git-diff-tolerant runner: `git diff` exits 1 when differences exist, so
// exit code 1 still resolves with stdout; anything else rejects.
function gitDiff(cwd, args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code !== 1) {
        const detail = String(stderr || stdout || err.message).trim().slice(0, 2000);
        const e = new Error(detail || "git diff failed");
        e.code = err.code;
        reject(e);
        return;
      }
      resolve(String(stdout || ""));
    });
  });
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

// One-line conventional-commit style fallback used when the model is
// unavailable. Picks a prefix from the touched paths and names a few files.
function heuristicMessage(st) {
  const files = (st.files || []).map((f) => f.path);
  const pick = files.slice(0, 3).join(", ");
  const extra = files.length > 3 ? ` (+${files.length - 3} more)` : "";
  let prefix = "chore";
  const dirs = files.join("\n");
  if (/web\/|\.tsx?$|\.jsx?$|\.css$|\.html$/.test(dirs)) prefix = "feat";
  else if (/server\/|electron\//.test(dirs)) prefix = "feat";
  else if (/README|\.md$/.test(dirs)) prefix = "docs";
  else if (/test|spec/.test(dirs)) prefix = "test";
  const names = (st.files || []).length;
  if (names === 0) return "chore: update working tree";
  return `${prefix}: update ${pick}${extra}`;
}

// Summarize unstaged+untracked work without failing when there is no HEAD yet.
async function describeChanges(root) {
  const st = await status(root);
  let stat = "";
  let diff = "";
  try {
    stat = await git(root, ["diff", "--stat", "--", "."]);
  } catch {
    stat = "";
  }
  try {
    diff = await git(root, ["diff", "--", ".", ":(exclude)package-lock.json", ":(exclude)yarn.lock"]);
  } catch {
    diff = "";
  }
  let untracked = "";
  try {
    const names = (await git(root, ["ls-files", "--others", "--exclude-standard"]))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (names.length) untracked = `Untracked files:\n${names.join("\n")}`;
  } catch {
    untracked = "";
  }
  if (diff.length > MAX_DIFF_BYTES) diff = `${diff.slice(0, MAX_DIFF_BYTES)}\n... (truncated)`;
  return { st, stat, diff, untracked };
}

function cleanModelMessage(text) {
  let msg = String(text || "").replace(/```[\s\S]*?```/g, " ").trim();
  msg = msg
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^["'`]+$/.test(l))[0] || "";
  msg = msg.replace(/^["'`]+|["'`.,;]+$/g, "").trim();
  if (/^(here is|here's|the commit message)/i.test(msg)) return "";
  if (msg.length > 100) msg = msg.slice(0, 100).trim();
  return msg;
}

// Ask the local `muse` CLI (same login, no extra API key) to write a
// conventional-commit style one-liner from the working-tree diff.
// Falls back to a heuristic summary when the model is unavailable.
async function generateMessage(workspace) {
  const dir = resolveDir(workspace);
  const root = await toplevel(dir);
  if (!root) throw new Error(`not a git repository: ${dir}`);
  const { st, stat, diff, untracked } = await describeChanges(root);
  if (st.total === 0) throw new Error("nothing to commit");
  try {
    const prompt =
      "Write a single git commit message (one line, under 72 chars, conventional-commit style like 'feat: ...' or 'fix: ...'). " +
      "Reply with ONLY the message, no quotes or explanation.\n\n" +
      `Changed files: ${(st.files || []).map((f) => f.path).join(", ")}\n` +
      (stat ? `Diff stat:\n${stat.slice(0, 2000)}\n` : "") +
      (diff ? `Diff:\n${diff}\n` : "") +
      (untracked ? `${untracked}\n` : "");
    const out = await run(
      MUSE_BIN,
      ["exec", "--workspace", root, "--max-model-steps", "4", "--max-tool-output-bytes", "8000", prompt],
      { cwd: root, timeout: MESSAGE_TIMEOUT_MS },
    );
    const msg = cleanModelMessage(out);
    if (msg) return { ok: true, message: msg.slice(0, MAX_MESSAGE), generated: true };
  } catch {
    /* fall through to the heuristic fallback */
  }
  return { ok: true, message: heuristicMessage(st).slice(0, MAX_MESSAGE), generated: true, fallback: true };
}

async function commit(workspace, message, push = false) {
  let msg = String(message || "").trim();
  const dir = resolveDir(workspace);
  const root = await toplevel(dir);
  if (!root) throw new Error(`not a git repository: ${dir}`);
  const before = await status(root);
  if (before.total === 0 && !push) throw new Error("nothing to commit");
  let generated = false;
  if (!msg) {
    const gen = await generateMessage(root);
    msg = gen.message;
    generated = true;
  }
  if (!msg) throw new Error("commit message required");
  if (msg.length > MAX_MESSAGE) throw new Error(`commit message over ${MAX_MESSAGE} characters`);
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
  return { ok: true, hash, pushed, message: msg, generated, pushOutput: pushOutput.slice(-2000), status: await status(root) };
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

// Single-file diff for the diffs view. Same exclusion list and byte cap as
// describeChanges; untracked files diff against /dev/null.
const DIFF_EXCLUDE = ["package-lock.json", "yarn.lock"];

async function diff(workspace, relPath) {
  const rel = String(relPath || "").trim();
  if (!rel) throw new Error("path required");
  const dir = resolveDir(workspace);
  const root = await toplevel(dir);
  if (!root) throw new Error(`not a git repository: ${dir}`);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("path outside repository");
  let st = null;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`no such path: ${rel}`);
  }
  if (!st.isFile()) throw new Error("not a file");
  const display = path.relative(root, abs) || rel;
  if (DIFF_EXCLUDE.some((n) => display === n || display.endsWith(`/${n}`))) {
    return { path: display, diff: "", truncated: false, excluded: true };
  }
  let out = await gitDiff(root, ["diff", "HEAD", "--", display]);
  if (!out.trim()) {
    const others = await git(root, ["ls-files", "--others", "--exclude-standard", "--", display]);
    if (others.split("\n").map((s) => s.trim()).includes(display)) {
      out = await gitDiff(root, ["diff", "--no-index", "--", "/dev/null", display]);
    }
  }
  let truncated = false;
  if (out.length > MAX_DIFF_BYTES) {
    out = `${out.slice(0, MAX_DIFF_BYTES)}\n... (truncated)`;
    truncated = true;
  }
  return { path: display, diff: out, truncated };
}

module.exports = { status, commit, push, pr, generateMessage, diff };
