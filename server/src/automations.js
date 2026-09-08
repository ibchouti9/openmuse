// Automations ledger: append-only JSONL store for automation defs + run records.
// Crash-safe by construction: each record is one atomic append; readers skip
// malformed (partially written) lines. No new dependencies.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_LINES = 10000;
const ROTATE_BYTES = 2 * 1024 * 1024;
const ROTATE_KEEP_LINES = 5000;

function dataDir() {
  const base = process.env.OPENMUSE_DATA_DIR || path.join(os.homedir(), ".openmuse");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function storePath() {
  return path.join(dataDir(), "automations.jsonl");
}

// Append one record; creates the store on first use. Best-effort rotation
// keeps the file bounded (rotation failure never fails the append).
function appendRecord(rec) {
  const line = JSON.stringify({ ...rec, v: 1 }) + "\n";
  fs.appendFileSync(storePath(), line, "utf8");
  try {
    maybeRotate();
  } catch {
    /* bounded-store failure must not fail the write path */
  }
}

// Drop the oldest lines once the file passes maxBytes, keeping the newest
// keepLines. The latest record per automationId is always pinned: defs must
// survive rotation no matter how much run history piles up. Atomic swap
// (tmp + rename) so readers never see a half file.
function maybeRotate({ maxBytes = ROTATE_BYTES, keepLines = ROTATE_KEEP_LINES } = {}) {
  let st = null;
  try {
    st = fs.statSync(storePath());
  } catch {
    return { rotated: false };
  }
  if (!st || st.size <= maxBytes) return { rotated: false };
  const all = readRecords();
  const pinIdx = new Set();
  const lastSeen = new Map();
  all.forEach((r, i) => {
    if (r && r.type === "automation" && typeof r.automationId === "string") lastSeen.set(r.automationId, i);
  });
  for (const i of lastSeen.values()) pinIdx.add(i);
  const rest = all
    .map((_, i) => i)
    .filter((i) => !pinIdx.has(i))
    .slice(-Math.max(0, keepLines - pinIdx.size));
  const keepIdx = new Set([...pinIdx, ...rest]);
  const keep = all.filter((_, i) => keepIdx.has(i));
  const tmp = `${storePath()}.tmp`;
  fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  fs.renameSync(tmp, storePath());
  return { rotated: true, kept: keep.length, dropped: all.length - keep.length, pinned: pinIdx.size };
}

// Read all well-formed records, oldest first. Skips blank/corrupt lines so a
// torn tail from a crash never fails a list call.
function readRecords() {
  let text = "";
  try {
    text = fs.readFileSync(storePath(), "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip torn line */
    }
  }
  return out;
}

// Newest-first run history page. Lifecycle appends share one runId, so reads
// dedupe: latest record per runId wins, ordered by createdAt desc. Cursor is
// the runId to start after (exclusive); nextCursor is null at the end.
function listRuns({ limit = 50, cursor = null } = {}) {
  const n = Number.isFinite(Number(limit)) ? Math.min(100, Math.max(1, Math.floor(Number(limit)))) : 50;
  const latest = new Map();
  for (const r of readRecords()) {
    if (r && r.type === "run" && typeof r.runId === "string") latest.set(r.runId, r);
  }
  const runs = [...latest.values()].sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
  );
  let start = 0;
  if (cursor) {
    const i = runs.findIndex((r) => r.runId === cursor);
    if (i >= 0) start = i + 1;
  }
  const page = runs.slice(start, start + n);
  return { runs: page, nextCursor: start + n < runs.length ? page[page.length - 1].runId : null };
}

// Find the latest run carrying an idempotency key (for trigger dedupe).
function findRunByKey(idempotencyKey) {
  if (!idempotencyKey) return null;
  const all = readRecords().filter(
    (r) => r && r.type === "run" && r.idempotencyKey === idempotencyKey,
  );
  return all.length ? all[all.length - 1] : null;
}

// ---- automation definitions (collapsed from the same append-only log) ----
function saveAutomation(def) {
  appendRecord({ ...def, type: "automation", updatedAt: new Date().toISOString() });
}

function listAutomations() {
  const latest = new Map();
  for (const r of readRecords()) {
    if (r && r.type === "automation" && typeof r.automationId === "string") {
      latest.set(r.automationId, r);
    }
  }
  return [...latest.values()]
    .filter((d) => !d.deleted)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

function getAutomation(automationId) {
  return listAutomations().find((d) => d.automationId === automationId) || null;
}

function deleteAutomation(automationId) {
  const cur = getAutomation(automationId);
  if (!cur) return false;
  appendRecord({ type: "automation", automationId, deleted: true });
  return true;
}

module.exports = {
  appendRecord, readRecords, listRuns, findRunByKey,
  saveAutomation, listAutomations, getAutomation, deleteAutomation,
  maybeRotate, storePath, MAX_LINES,
};
