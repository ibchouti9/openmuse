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
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
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
          title="Fork session from this point"
        >
          <GitForkIcon size={12} />
          <span>Branch</span>
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
