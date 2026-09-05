import { useState } from "react";
import {
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  RefreshCwIcon,
  CheckIcon,
} from "./Icons";

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
}) {
  const [message, setMessage] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [showPr, setShowPr] = useState(false);
  const busyAny = busyAction != null;
  const changes = status?.total || 0;

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

      {status?.repo && changes > 0 && (
        <div className="git-files-container">
          <div className="git-files-list">
            {(status.files || []).map((f) => (
              <div key={f.path} className="git-file-row" title={f.path}>
                <span
                  className={`git-file-badge ${
                    f.untracked ? "untracked" : f.staged ? "staged" : "modified"
                  }`}
                >
                  {f.untracked ? "?" : f.staged ? "S" : "M"}
                </span>
                <span className="git-file-path">{f.path}</span>
              </div>
            ))}
          </div>
          {status.truncated && (
            <p className="git-truncated-note">
              Showing first {(status.files || []).length} of {changes} changed files.
            </p>
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
            placeholder="Commit message (e.g. fix: update styling)..."
            rows={2}
          />

          <div className="git-button-grid">
            <button
              type="button"
              className="git-primary-btn"
              disabled={busyAny || !message.trim() || changes === 0}
              onClick={() => {
                onCommit(message.trim(), false);
                setMessage("");
              }}
            >
              <GitCommitIcon size={14} />
              <span>{busyAction === "commit" ? "Committing..." : "Commit"}</span>
            </button>

            <button
              type="button"
              className="git-primary-btn push"
              disabled={busyAny || !message.trim() || changes === 0}
              onClick={() => {
                onCommit(message.trim(), true);
                setMessage("");
              }}
              title="Stage all changes, commit, and push upstream"
            >
              <GitPullRequestIcon size={14} />
              <span>{busyAction === "commit&push" ? "Pushing..." : "Commit & Push"}</span>
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
