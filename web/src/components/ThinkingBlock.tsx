import { useEffect, useRef, useState } from "react";
import { ThreadItem, thinkingLive } from "../threading";
import {
  CheckIcon,
  ChevronRightIcon,
  CodeIcon,
  CopyIcon,
  GlobeIcon,
  SparklesIcon,
  TerminalIcon,
} from "./Icons";

function parseArgs(args?: string): string {
  if (!args) return "";
  try {
    const o = JSON.parse(args);
    return o.command || o.description || args;
  } catch {
    return args;
  }
}

function thinkingLabel(entry: ThreadItem): string {
  switch (entry.kind) {
    case "reasoning":
      return "Reasoning";
    case "toolCall":
      return entry.tool || "Tool";
    case "userShell":
      return "Terminal";
    case "subagent":
      return "Subagent";
    case "workflow":
      return "Workflow";
    case "reminderChild":
      return "Reminder";
    case "compaction":
      return "Context compacted";
    default:
      return entry.kind || "Activity";
  }
}

function thinkingIcon(entry: ThreadItem) {
  switch (entry.kind) {
    case "reasoning":
      return <SparklesIcon size={14} />;
    case "userShell":
      return <TerminalIcon size={14} />;
    case "toolCall":
      if (entry.tool === "bash" || entry.tool === "sh") return <TerminalIcon size={14} />;
      if (entry.tool?.includes("web") || entry.tool?.includes("url") || entry.tool?.includes("browser")) return <GlobeIcon size={14} />;
      return <CodeIcon size={14} />;
    default:
      return <CodeIcon size={14} />;
  }
}

function thinkingDetail(entry: ThreadItem): string {
  if (entry.kind === "reasoning") {
    const parts = (entry.summary || []).filter((s) => s && s.trim());
    if (parts.length > 0) return parts.join("\n\n");
    return entry.text || "";
  }
  if (entry.kind === "toolCall") {
    const cmd = parseArgs(entry.args);
    const out = (entry.visibleOutput || "").trim();
    return [cmd, out].filter(Boolean).join(out && cmd ? "\n" : "");
  }
  if (entry.kind === "userShell") return entry.visibleOutput || entry.text || "";
  if (entry.kind === "subagent") return entry.text || entry.fallbackText || "";
  return (entry.text || "").trim();
}

function shortPreview(s: string, n = 120): string {
  const one = (s || "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export default function ThinkingBlock({
  entries,
  streamingId,
  defaultOpen,
}: {
  entries: ThreadItem[];
  streamingId: string | null;
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen ?? false);
  const live = thinkingLive(entries, streamingId);
  const [elapsed, setElapsed] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const seenCount = useRef(entries.length);

  useEffect(() => {
    if (!live) return;
    const t0 = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [live]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!expanded || !el || entries.length === seenCount.current) return;
    seenCount.current = entries.length;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [entries.length, expanded]);

  const latest = entries[entries.length - 1];
  const preview = latest ? shortPreview(thinkingDetail(latest)) : "";

  function copyText(id: string, text: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1400);
    });
  }

  return (
    <div className={`thinking-card ${live ? "is-live" : "is-completed"} ${expanded ? "is-expanded" : ""}`}>
      <button
        type="button"
        className="thinking-header-btn"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <div className="thinking-indicator-badge">
          {live ? (
            <div className="thinking-pulse-ring">
              <span className="pulse-inner" />
            </div>
          ) : (
            <div className="thinking-done-badge">
              <CheckIcon size={11} />
            </div>
          )}
        </div>

        <div className="thinking-summary-meta">
          <div className="thinking-headline">
            <span className="thinking-title">
              {live ? "Reasoning & Executing..." : "Thought for"}
            </span>
            {!live && elapsed > 0 && (
              <span className="thinking-duration">{elapsed}s</span>
            )}
            <span className="thinking-step-count">
              ({entries.length} step{entries.length === 1 ? "" : "s"})
            </span>
          </div>

          {preview && (
            <span
              key={live ? latest.itemId : `done-${entries.length}`}
              className={`thinking-preview-text ${live ? "" : "settled"}`}
              title={preview}
            >
              {preview}
            </span>
          )}
        </div>

        <div className="thinking-expand-icon">
          <ChevronRightIcon size={14} />
        </div>
      </button>

      {/* Collapsible Steps Timeline */}
      <div className={`thinking-content-collapse ${expanded ? "expanded" : ""}`}>
        <div ref={bodyRef} className="thinking-steps-timeline">
          {entries.map((entry, idx) => {
            const active = streamingId === entry.itemId || entry.status === "inProgress";
            const isTool = entry.kind === "toolCall";
            const cmd = isTool ? parseArgs(entry.args) : "";
            const out = isTool ? (entry.visibleOutput || "").trim() : "";
            const detail = thinkingDetail(entry);
            const copyContent = [cmd, out || detail].filter(Boolean).join("\n\n");

            return (
              <div key={entry.itemId} className={`timeline-step-row ${active ? "active-step" : ""}`}>
                <div className="step-gutter">
                  <span className="step-number">{String(idx + 1).padStart(2, "0")}</span>
                  {idx < entries.length - 1 && <div className="step-connector-line" />}
                </div>

                <div className="step-content-card">
                  <div className="step-header">
                    <div className="step-icon-badge">
                      {thinkingIcon(entry)}
                    </div>
                    <span className="step-label">{thinkingLabel(entry)}</span>
                    {active && <span className="step-active-pill">Running</span>}
                    <div className="spacer" />
                    {copyContent && (
                      <button
                        type="button"
                        className="step-copy-btn"
                        onClick={() => copyText(entry.itemId, copyContent)}
                        title="Copy step details"
                      >
                        {copiedId === entry.itemId ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                        <span>{copiedId === entry.itemId ? "Copied" : "Copy"}</span>
                      </button>
                    )}
                  </div>

                  {isTool ? (
                    <>
                      {cmd && (
                        <div className="step-code-block">
                          <span className="terminal-prompt">$</span>
                          <pre className="step-cmd-text">{cmd}</pre>
                        </div>
                      )}
                      {out && (
                        <pre className="step-output-text">{out}</pre>
                      )}
                      {!cmd && !out && detail && (
                        <pre className="step-detail-text">{detail}</pre>
                      )}
                    </>
                  ) : (
                    detail && <pre className="step-detail-text">{detail}</pre>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
