// Automations ledger: append-only JSONL store for automation defs + run records.
// Crash-safe by construction: each record is one atomic append; readers skip
// malformed (partially written) lines. No new dependencies.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_LINES = 10000;

function dataDir() {
  const base = process.env.OPENMUSE_DATA_DIR || path.join(os.homedir(), ".openmuse");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function storePath() {
  return path.join(dataDir(), "automations.jsonl");
}

// Append one record; creates the store on first use.
function appendRecord(rec) {
  const line = JSON.stringify({ ...rec, v: 1 }) + "\n";
  fs.appendFileSync(storePath(), line, "utf8");
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

// Newest-first run history page. Cursor is the runId to start after
// (exclusive); nextCursor is null when the page reaches the end.
function listRuns({ limit = 50, cursor = null } = {}) {
  const n = Number.isFinite(Number(limit)) ? Math.min(100, Math.max(1, Math.floor(Number(limit)))) : 50;
  const runs = readRecords()
    .filter((r) => r && r.type === "run")
    .reverse();
  let start = 0;
  if (cursor) {
    const i = runs.findIndex((r) => r.runId === cursor);
    if (i >= 0) start = i + 1;
  }
  const page = runs.slice(start, start + n);
  return { runs: page, nextCursor: start + n < runs.length ? page[page.length - 1].runId : null };
}

module.exports = { appendRecord, readRecords, listRuns, storePath, MAX_LINES };
