import { useState } from "react";
import { CheckIcon, CopyIcon, GitForkIcon, RefreshCwIcon } from "./Icons";

export default function MessageActions({
  text,
  isUser,
  onFork,
  onRetry,
}: {
  text: string;
  isUser: boolean;
  onFork?: () => void;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    };
    try {
      const p = navigator.clipboard?.writeText(text);
      if (p) {
        p.then(done).catch(() => setCopied(false));
        return;
      }
    } catch {
      /* fall through to legacy fallback */
    }
    // Fallback for contexts without the async clipboard API.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      if (document.execCommand("copy")) done();
      document.body.removeChild(ta);
    } catch {
      setCopied(false);
    }
  }

  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className={`message-actions-toolbar ${isUser ? "user" : "agent"}`}>
      {wordCount > 0 && (
        <span className="msg-word-count-badge font-mono" title={`${wordCount} words`}>
          {wordCount}w
        </span>
      )}

      <button
        type="button"
        className="msg-action-btn"
        onClick={handleCopy}
        title="Copy text to clipboard"
      >
        {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>

      {onFork && (
        <button
          type="button"
          className="msg-action-btn"
          onClick={onFork}
          title="Copy message text into composer"
        >
          <GitForkIcon size={12} />
          <span>Reuse</span>
        </button>
      )}

      {onRetry && (
        <button
          type="button"
          className="msg-action-btn"
          onClick={onRetry}
          title="Regenerate / retry prompt"
        >
          <RefreshCwIcon size={12} />
          <span>Retry</span>
        </button>
      )}
    </div>
  );
}
