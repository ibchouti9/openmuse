import { useState } from "react";
import {
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  RefreshCwIcon,
  CheckIcon,
  SparklesIcon,
  ChevronRightIcon,
} from "./Icons";
import { ops } from "../api";

export interface GitStatus {
  repo: boolean;
  root?: string;
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  hasRemote?: boolean;
  staged?: number;
  unstaged?: number;
  untracked?: number;
  total?: number;
  truncated?: boolean;
  files?: { path: string; code: string; staged: boolean; unstaged: boolean; untracked: boolean }[];
}

type DiffLine =
  | { kind: "hunk"; text: string }
  | { kind: "add"; text: string }
  | { kind: "del"; text: string }
  | { kind: "ctx"; text: string };

// Minimal unified-diff parser: hunk headers, +/-/context. File headers
// (diff --git, +++/---) are dropped; the panel header shows the path.
export function parseUnifiedDiff(raw: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of String(raw || "").split("\n")) {
    if (line.startsWith("@@")) out.push({ kind: "hunk", text: line });
    else if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")) continue;
    else if (line.startsWith("+")) out.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line.slice(1) });
    else out.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
  }
  return out.filter((l) => !(l.kind === "ctx" && l.text === "" && out.indexOf(l) === out.length - 1));
}

const MOCK_DIFF = `@@ -12,7 +12,8 @@ export default function Composer({
   busy,
   models,
   model,
-  onModel,
+  onModel: onModelProp,
+  effort,
   onEffort,
   approvalMode,
   onApproval,`;

// Mock file diff (fallback proof + tests). App wires the real
// GET /api/git/diff through the diffLoader seam.
function loadMockDiff(path: string): Promise<{ diff: string; truncated: boolean }> {
  void path;
  return new Promise((resolve) => {
    setTimeout(() => resolve({ diff: MOCK_DIFF, truncated: false }), 300);
  });
}

export default function GitMenu({
  status,
  loading,
  workspace,
  onRefresh,
  onCommit,
  onPush,
  onPr,
  busyAction,
  note,
  diffLoader = loadMockDiff,
}: {
  status: GitStatus | null;
  loading: boolean;
  workspace: string;
  onRefresh: () => void;
  onCommit: (message: string, push: boolean) => void;
  onPush: () => void;
  onPr: (title: string, body: string) => void;
  busyAction: string | null;
  note: string | null;
  diffLoader?: (path: string) => Promise<{ diff: string; truncated: boolean }>;
}) {
  const [message, setMessage] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [showPr, setShowPr] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [diffPhase, setDiffPhase] = useState<"loading" | "ready" | "error">("ready");
  const [diffText, setDiffText] = useState("");
  const [diffTruncated, setDiffTruncated] = useState(false);
  const busyAny = busyAction != null || generating;
  const changes = status?.total || 0;

  async function openDiff(path: string, untracked: boolean) {
    setDiffPath(path);
    if (untracked) {
      // Ruling: untracked files are a graceful not-shown row, no endpoint.
      setDiffPhase("ready");
      setDiffText("");
      setDiffTruncated(false);
      return;
    }
    setDiffPhase("loading");
    try {
      const r = await diffLoader(path);
      setDiffText(r.diff);
      setDiffTruncated(r.truncated);
      setDiffPhase("ready");
    } catch {
      setDiffPhase("error");
    }
  }

  async function generateMessage() {
    if (generating || changes === 0) return;
    setGenerating(true);
    try {
      const r = (await ops.gitMessage(workspace)) as { message?: string };
      if (r.message) setMessage(r.message);
    } catch {
      /* on failure leave the box untouched */
    } finally {
      setGenerating(false);
    }
  }

  const repoName = (status?.root || workspace || "").split("/").filter(Boolean).pop() || status?.root || workspace;

  return (
    <div className="git-dropdown-card">
      <div className="git-dropdown-header">
        <div className="git-branch-info">
          <GitBranchIcon size={16} />
          <span className="git-branch-name">
            {status == null
              ? "Checking git..."
              : !status.repo
              ? "Not a git repo"
              : status.branch || "HEAD"}
          </span>
          {status?.repo && (
            <span className={`git-status-badge ${changes > 0 ? "dirty" : "clean"}`}>
              {changes > 0 ? `${changes} change${changes === 1 ? "" : "s"}` : "Clean"}
            </span>
          )}
        </div>
        <div className="spacer" />
        <button
          type="button"
          className="git-refresh-btn"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh Git status"
        >
          <RefreshCwIcon size={13} className={loading ? "spin" : ""} />
        </button>
      </div>

      {status?.repo && (
        <div className="git-repo-meta">
          <span className="git-repo-name" title={status.root || workspace}>
            {repoName}
          </span>
          {status.upstream && <span className="git-upstream-info">→ {status.upstream}</span>}
          {(status.ahead || 0) > 0 && <span className="git-sync-stat ahead">↑{status.ahead}</span>}
          {(status.behind || 0) > 0 && <span className="git-sync-stat behind">↓{status.behind}</span>}
        </div>
      )}

      {status != null && !status.repo && (
        <p className="git-empty-note">This workspace folder is not currently a git repository.</p>
      )}

      {status?.repo && changes > 0 && diffPath === null && (
        <div className="git-files-container">
          <div className="git-files-list">
            {(status.files || []).map((f) => (
              <button
                key={f.path}
                type="button"
                className="git-file-row as-button"
                title={`${f.path} — show diff`}
                onClick={() => void openDiff(f.path, f.untracked)}
              >
                <span
                  className={`git-file-badge ${
                    f.untracked ? "untracked" : f.staged ? "staged" : "modified"
                  }`}
                >
                  {f.untracked ? "?" : f.staged ? "S" : "M"}
                </span>
                <span className="git-file-path">{f.path}</span>
                <ChevronRightIcon size={13} className="git-file-chevron" />
              </button>
            ))}
          </div>
          {status.truncated && (
            <p className="git-truncated-note">
              Showing first {(status.files || []).length} of {changes} changed files.
            </p>
          )}
        </div>
      )}

      {status?.repo && changes > 0 && diffPath !== null && (
        <div className="git-diff-panel" aria-live="polite">
          <div className="git-diff-header">
            <button
              type="button"
              className="git-diff-back-btn"
              onClick={() => setDiffPath(null)}
              title="Back to changed files"
            >
              ← Files
            </button>
            <span className="git-diff-path font-mono" title={diffPath}>
              {diffPath}
            </span>
          </div>
          {diffPhase === "loading" && <p className="git-diff-loading">Loading diff…</p>}
          {diffPhase === "error" && (
            <div className="git-diff-empty">
              <p>Couldn&apos;t load this diff.</p>
              <button
                type="button"
                className="user-edit-btn primary"
                onClick={() => {
                  const f = (status.files || []).find((x) => x.path === diffPath);
                  void openDiff(diffPath, !!f?.untracked);
                }}
              >
                Retry
              </button>
            </div>
          )}
          {diffPhase === "ready" && diffText === "" && (
            <p className="git-diff-loading">Diff preview isn&apos;t shown for untracked files.</p>
          )}
          {diffPhase === "ready" && diffText !== "" && (
            <div className="git-diff-body" role="table" aria-label={`Diff for ${diffPath}`}>
              {parseUnifiedDiff(diffText).map((l, i) => (
                <div key={i} role="row" className={`git-diff-line is-${l.kind}`}>
                  <span className="git-diff-gutter" aria-hidden="true">
                    {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
                  </span>
                  <code>{l.text}</code>
                </div>
              ))}
              {diffTruncated && <p className="git-truncated-note">Diff truncated — showing the first part.</p>}
            </div>
          )}
        </div>
      )}

      {status?.repo && changes === 0 && (
        <div className="git-clean-state">
          <CheckIcon size={16} />
          <span>Working tree is clean. No uncommitted changes.</span>
        </div>
      )}

      {note && (
        <div className={`git-note-alert ${note.startsWith("✓") ? "success" : "error"}`}>
          {note}
        </div>
      )}

      {status?.repo && (
        <div className="git-actions-area">
          <textarea
            className="git-commit-input"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message (leave empty for AI message)..."
            rows={2}
          />

          <div className="git-button-grid">
            <button
              type="button"
              className="git-primary-btn"
              disabled={busyAny || changes === 0}
              onClick={() => {
                onCommit(message.trim(), false);
                setMessage("");
              }}
              title={message.trim() ? "Commit with this message" : "Commit with an AI-generated message"}
            >
              <GitCommitIcon size={14} />
              <span>{busyAction === "commit" ? "Committing..." : "Commit"}</span>
            </button>

            <button
              type="button"
              className="git-primary-btn push"
              disabled={busyAny || changes === 0}
              onClick={() => {
                onCommit(message.trim(), true);
                setMessage("");
              }}
              title={message.trim() ? "Stage all changes, commit, and push upstream" : "Generate an AI message, commit, and push upstream"}
            >
              <GitPullRequestIcon size={14} />
              <span>{busyAction === "commit&push" ? "Pushing..." : "Commit & Push"}</span>
            </button>
          </div>

          <div className="git-button-row">
            <button
              type="button"
              className="git-secondary-btn"
              disabled={busyAny || changes === 0}
              onClick={generateMessage}
              title="Generate an AI commit message from your changes"
            >
              <span className="git-generate-label">
                <SparklesIcon size={13} />
                {generating ? "Generating..." : "Generate message"}
              </span>
            </button>
          </div>

          <div className="git-button-row">
            <button
              type="button"
              className="git-secondary-btn"
              disabled={busyAny}
              onClick={onPush}
              title="Push committed changes to remote repository"
            >
              <span>{busyAction === "push" ? "Pushing..." : "Push"}</span>
            </button>

            <button
              type="button"
              className={`git-secondary-btn ${showPr ? "active" : ""}`}
              onClick={() => setShowPr((v) => !v)}
              title="Create a Pull Request via GitHub CLI"
            >
              <span>{showPr ? "Close PR Form" : "New PR..."}</span>
            </button>
          </div>

          {showPr && (
            <div className="git-pr-form">
              <input
                className="git-pr-input"
                value={prTitle}
                onChange={(e) => setPrTitle(e.target.value)}
                placeholder="Pull Request title (required)"
              />
              <textarea
                className="git-pr-textarea"
                value={prBody}
                onChange={(e) => setPrBody(e.target.value)}
                placeholder="Pull Request description (optional)"
                rows={2}
              />
              <button
                type="button"
                className="git-pr-submit-btn"
                disabled={busyAny || !prTitle.trim()}
                onClick={() => {
                  onPr(prTitle.trim(), prBody);
                  setPrTitle("");
                  setPrBody("");
                  setShowPr(false);
                }}
              >
                {busyAction === "pr" ? "Creating PR..." : "Open Pull Request"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
