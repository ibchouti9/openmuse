import { useEffect, useRef, useState, useMemo, useCallback, memo } from "react";
import { ThreadItem, thinkingLive } from "../threading";
import {
  CheckIcon,
  ChevronRightIcon,
  CodeIcon,
  CopyIcon,
  CpuIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  SearchIcon,
  SparklesIcon,
  TerminalIcon,
} from "./Icons";

export type ToolCategory =
  | "file-read"
  | "file-write"
  | "terminal"
  | "search"
  | "web"
  | "reasoning"
  | "other";

export interface HumanizedAction {
  category: ToolCategory;
  categoryLabel: string;
  actionTitle: string;
  target?: string;
  shortTarget?: string;
  headline: string;
  preview: string;
  commandSnippet?: string;
  codeSnippet?: string;
  output?: string;
}

function cleanPath(p?: string): string {
  if (!p) return "";
  let s = String(p).trim().replace(/^["']|["']$/g, "");
  const segments = s.split("/").filter(Boolean);
  if (segments.length > 3) {
    return segments.slice(-3).join("/");
  }
  return s;
}

function shortBaseName(p?: string): string {
  if (!p) return "";
  const s = String(p).trim().replace(/^["']|["']$/g, "");
  const segments = s.split("/").filter(Boolean);
  return segments[segments.length - 1] || s;
}

function safeParseArgs(raw?: string): Record<string, any> {
  if (!raw) return {};
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

export function humanizeAction(entry: ThreadItem): HumanizedAction {
  if (entry.kind === "reasoning") {
    const summaryParts = (entry.summary || []).filter((s) => s && s.trim());
    const thoughtText = summaryParts.length > 0 ? summaryParts.join(" ") : (entry.text || "");
    const clean = thoughtText.replace(/\s+/g, " ").trim();
    const firstSentence = clean.split(/[.!?]\s/)[0] || clean;
    const preview = firstSentence.length > 100 ? `${firstSentence.slice(0, 99)}…` : firstSentence;
    return {
      category: "reasoning",
      categoryLabel: "Reasoning",
      actionTitle: "Neural Reasoning",
      shortTarget: "Plan",
      headline: preview || "Reasoning through problem context...",
      preview: preview || "Analyzing context...",
      codeSnippet: summaryParts.length > 0 ? summaryParts.join("\n\n") : (entry.text || ""),
    };
  }

  if (entry.kind === "userShell") {
    const cmd = (entry.text || "").trim();
    const shortCmd = cmd.split(/\s+/).slice(0, 2).join(" ");
    return {
      category: "terminal",
      categoryLabel: "Shell",
      actionTitle: "User Shell",
      target: cmd,
      shortTarget: `$ ${shortCmd}`,
      headline: cmd ? `$ ${cmd}` : "Shell execution",
      preview: cmd ? `$ ${cmd}` : "Terminal execution",
      commandSnippet: cmd,
      output: (entry.visibleOutput || "").trim(),
    };
  }

  if (entry.kind === "toolCall") {
    const parsed = safeParseArgs(entry.args);
    const tool = (entry.tool || "").toLowerCase();
    const out = (entry.visibleOutput || "").trim();

    // 1. File Inspection / Reading
    if (
      tool === "read_file" ||
      tool === "view_file" ||
      tool === "readfile" ||
      tool === "cat" ||
      tool.includes("view") ||
      tool.includes("read")
    ) {
      const raw =
        parsed.path ||
        parsed.AbsolutePath ||
        parsed.TargetFile ||
        parsed.file ||
        parsed.filename ||
        parsed.uri ||
        "";
      const target = cleanPath(raw);
      const short = shortBaseName(raw) || "file";
      const headline = target ? `Read ${target}` : "Inspect file";
      return {
        category: "file-read",
        categoryLabel: "File Read",
        actionTitle: "Inspect File",
        target,
        shortTarget: short,
        headline,
        preview: headline,
        output: out,
      };
    }

    // 2. File Creation / Overwrite
    if (
      tool === "write_to_file" ||
      tool === "write_file" ||
      tool === "create_file" ||
      tool === "writefile"
    ) {
      const raw = parsed.TargetFile || parsed.path || parsed.file || parsed.filename || "";
      const target = cleanPath(raw);
      const short = shortBaseName(raw) || "file";
      const headline = target ? `Create ${target}` : "Create file";
      return {
        category: "file-write",
        categoryLabel: "File Create",
        actionTitle: "Create File",
        target,
        shortTarget: short,
        headline,
        preview: headline,
        codeSnippet: parsed.CodeContent || parsed.content || "",
        output: out,
      };
    }

    // 3. File Modification / Patch
    if (
      tool === "replace_file_content" ||
      tool === "edit_file" ||
      tool === "modify_file" ||
      tool === "patch_file" ||
      tool.includes("replace") ||
      tool.includes("edit")
    ) {
      const raw = parsed.TargetFile || parsed.path || parsed.file || parsed.filename || "";
      const target = cleanPath(raw);
      const short = shortBaseName(raw) || "file";
      const headline = target ? `Edit ${target}` : "Edit file";
      return {
        category: "file-write",
        categoryLabel: "File Edit",
        actionTitle: "Edit File",
        target,
        shortTarget: short,
        headline,
        preview: headline,
        codeSnippet: parsed.ReplacementContent || parsed.Instruction || parsed.content || "",
        output: out,
      };
    }

    // 4. Terminal Command Execution
    if (
      tool === "bash" ||
      tool === "sh" ||
      tool === "run_command" ||
      tool === "exec" ||
      tool === "execute_command" ||
      tool.includes("command") ||
      tool.includes("terminal")
    ) {
      const cmd = (parsed.CommandLine || parsed.command || parsed.cmd || parsed.raw || "").trim();
      const preview = cmd ? `$ ${cmd.length > 70 ? cmd.slice(0, 69) + "…" : cmd}` : "Run command";
      const shortCmd = cmd.split(/\s+/).slice(0, 2).join(" ");
      return {
        category: "terminal",
        categoryLabel: "Terminal",
        actionTitle: "Execute Command",
        target: cmd,
        shortTarget: `$ ${shortCmd || "cmd"}`,
        headline: cmd ? `$ ${cmd}` : "Execute command",
        preview,
        commandSnippet: cmd,
        output: out,
      };
    }

    // 5. Codebase Search
    if (
      tool === "grep_search" ||
      tool === "search_files" ||
      tool === "ripgrep" ||
      tool === "grep" ||
      tool.includes("grep")
    ) {
      const query = parsed.Query || parsed.query || parsed.pattern || "";
      const headline = query ? `Search for "${query}"` : "Search codebase";
      return {
        category: "search",
        categoryLabel: "Grep Search",
        actionTitle: "Search Codebase",
        target: query,
        shortTarget: query ? `"${query.slice(0, 14)}"` : "Search",
        headline,
        preview: headline,
        output: out,
      };
    }

    if (tool === "find_by_name" || tool === "find_files" || tool === "fd" || tool.includes("find")) {
      const pat = parsed.Pattern || parsed.pattern || "";
      const headline = pat ? `Find "${pat}"` : "Find files";
      return {
        category: "search",
        categoryLabel: "Find Files",
        actionTitle: "Find Files",
        target: pat,
        shortTarget: pat ? pat.slice(0, 14) : "Find",
        headline,
        preview: headline,
        output: out,
      };
    }

    if (tool === "list_dir" || tool === "ls" || tool.includes("list_dir")) {
      const raw = parsed.DirectoryPath || parsed.path || "";
      const target = cleanPath(raw);
      const short = shortBaseName(raw) || "dir";
      const headline = target ? `List ${target}` : "List directory";
      return {
        category: "search",
        categoryLabel: "Directory",
        actionTitle: "List Directory",
        target,
        shortTarget: short,
        headline,
        preview: headline,
        output: out,
      };
    }

    // 6. Web & Documentation
    if (tool.includes("web") || tool.includes("url") || tool.includes("browser") || tool.includes("fetch")) {
      const q = parsed.query || parsed.Url || parsed.url || "";
      const headline = q ? `Web: ${q}` : "Web search";
      return {
        category: "web",
        categoryLabel: "Web Research",
        actionTitle: "Web Search",
        target: q,
        shortTarget: "Web",
        headline,
        preview: headline,
        output: out,
      };
    }

    // Fallback tool call
    const desc = parsed.description || parsed.command || (typeof entry.args === "string" && entry.args.length < 60 ? entry.args : "");
    const headline = desc ? `${entry.tool}: ${desc}` : (entry.tool || "Tool execution");
    return {
      category: "other",
      categoryLabel: entry.tool || "Tool",
      actionTitle: entry.tool || "Tool Call",
      target: desc,
      shortTarget: entry.tool || "Tool",
      headline,
      preview: headline,
      output: out,
    };
  }

  // Generic intermediate items
  const clean = (entry.text || entry.fallbackText || "").replace(/\s+/g, " ").trim();
  const label = entry.kind || "Activity";
  return {
    category: "other",
    categoryLabel: label,
    actionTitle: label,
    shortTarget: label,
    headline: clean || label,
    preview: clean.length > 70 ? `${clean.slice(0, 69)}…` : (clean || label),
    output: (entry.visibleOutput || "").trim(),
  };
}

function CategoryIcon({ category }: { category: ToolCategory }) {
  switch (category) {
    case "file-read":
      return <FileTextIcon size={13} />;
    case "file-write":
      return <CodeIcon size={13} />;
    case "terminal":
      return <TerminalIcon size={13} />;
    case "search":
      return <SearchIcon size={13} />;
    case "web":
      return <GlobeIcon size={13} />;
    case "reasoning":
      return <SparklesIcon size={13} />;
    default:
      return <CpuIcon size={13} />;
  }
}

function TruncatedOutput({ text, maxLines = 5 }: { text: string; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => text.split("\n"), [text]);
  const isLong = lines.length > maxLines;

  const display = useMemo(() => {
    if (!isLong || expanded) return text;
    return lines.slice(0, maxLines).join("\n") + "\n…";
  }, [text, isLong, expanded, lines, maxLines]);

  return (
    <div className="step-output-container">
      <div className="step-output-label-bar">
        <span className="step-output-label">Output ({lines.length} lines)</span>
        {isLong && (
          <button
            type="button"
            className="step-output-toggle-btn"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            {expanded ? "Collapse" : `Show all (+${lines.length - maxLines} lines)`}
          </button>
        )}
      </div>
      <pre className={`step-output-text-3d font-mono ${expanded ? "is-expanded" : ""}`}>{display}</pre>
    </div>
  );
}

const ThinkingTimer = function ThinkingTimer({ live }: { live: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t0 = Date.now();
    setElapsed(0);
    const interval = setInterval(() => {
      setElapsed(Math.max(1, Math.round((Date.now() - t0) / 1000)));
    }, 1000);
    return () => clearInterval(interval);
  }, [live]);

  if (!live && elapsed === 0) return null;
  return <span className="thinking-duration font-mono">{elapsed}s</span>;
};

interface StepRowProps {
  entry: ThreadItem;
  index: number;
  isLast: boolean;
  onCopy: (id: string, text: string) => void;
  isCopied: boolean;
}

const CompletedStepRow = memo(function CompletedStepRow({
  entry,
  index,
  isLast,
  onCopy,
  isCopied,
}: StepRowProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const act = useMemo(() => humanizeAction(entry), [entry]);
  const copyContent = act.commandSnippet || act.codeSnippet || act.output || act.headline;

  return (
    <div className="vertical-step-row is-completed">
      <div className="step-gutter-col">
        <div className="step-bullet-node completed" title="Step completed">
          <CheckIcon size={10} />
        </div>
        {!isLast && <div className="step-gutter-line" />}
      </div>

      <div className="step-card-col">
        <div
          className="step-compact-header"
          onClick={() => setDetailOpen((v) => !v)}
          title="Click to toggle details"
        >
          <span className="step-index-badge font-mono">{String(index + 1).padStart(2, "0")}</span>
          <span className={`step-cat-pill cat-${act.category}`}>
            <CategoryIcon category={act.category} />
            <span>{act.categoryLabel}</span>
          </span>
          <span className="step-headline-text font-mono" title={act.headline}>
            {act.headline}
          </span>
          <div className="spacer" />
          {copyContent && (
            <button
              type="button"
              className="step-micro-copy-btn"
              onClick={(e) => {
                e.stopPropagation();
                onCopy(entry.itemId, copyContent);
              }}
              title="Copy output"
            >
              {isCopied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
            </button>
          )}
          <span className="step-chevron-icon">
            <ChevronRightIcon size={12} className={detailOpen ? "is-rotated" : ""} />
          </span>
        </div>

        {detailOpen && (
          <div className="step-details-drawer">
            {act.commandSnippet && (
              <div className="step-terminal-block-3d">
                <span className="terminal-prompt">$</span>
                <pre className="terminal-cmd-text font-mono">{act.commandSnippet}</pre>
              </div>
            )}
            {act.codeSnippet && !act.commandSnippet && (
              <pre className="step-code-snippet-3d font-mono">{act.codeSnippet}</pre>
            )}
            {act.output && <TruncatedOutput text={act.output} maxLines={4} />}
          </div>
        )}
      </div>
    </div>
  );
});

const HeroActiveStepCard = memo(function HeroActiveStepCard({
  entry,
  index,
  live,
  onCopy,
  isCopied,
}: {
  entry: ThreadItem;
  index: number;
  live: boolean;
  onCopy: (id: string, text: string) => void;
  isCopied: boolean;
}) {
  const act = useMemo(() => humanizeAction(entry), [entry]);
  const copyContent = act.commandSnippet || act.codeSnippet || act.output || act.headline;

  return (
    <div className={`vertical-step-row is-hero ${live ? "hero-live" : "hero-settled"}`}>
      <div className="step-gutter-col">
        <div className={`step-bullet-node hero ${live ? "pulse-active" : "node-done"}`}>
          {live ? (
            <span className="hero-bullet-glow-dot" />
          ) : (
            <CheckIcon size={11} />
          )}
        </div>
      </div>

      <div className="step-hero-card-3d">
        {/* Specular Edge Glow on Active Hero */}
        {live && <div className="hero-specular-edge-glow" />}

        <div className="hero-card-header-bar">
          <div className="hero-header-meta">
            <div className={`hero-category-chip cat-${act.category}`}>
              <CategoryIcon category={act.category} />
              <span>{act.categoryLabel}</span>
            </div>
            <span className="hero-step-counter-tag font-mono">
              {live ? `STEP ${String(index + 1).padStart(2, "0")} • ACTIVE` : `STEP ${String(index + 1).padStart(2, "0")}`}
            </span>
          </div>

          <div className="hero-header-controls">
            {live && (
              <div className="hero-audio-equalizer" aria-label="Running">
                <span className="hero-bar hb1" />
                <span className="hero-bar hb2" />
                <span className="hero-bar hb3" />
                <span className="hero-bar hb4" />
              </div>
            )}
            {copyContent && (
              <button
                type="button"
                className="step-copy-btn hero-copy-action"
                onClick={() => onCopy(entry.itemId, copyContent)}
                title="Copy step output"
              >
                {isCopied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                <span>{isCopied ? "Copied" : "Copy"}</span>
              </button>
            )}
          </div>
        </div>

        {/* Hero Title & Target */}
        <div className="hero-headline-block">
          <span className="hero-action-title">{act.actionTitle}</span>
          {act.target && (
            <span className="hero-target-badge font-mono" title={act.target}>
              {act.target}
            </span>
          )}
        </div>

        {/* Command Box if Terminal */}
        {act.commandSnippet && (
          <div className="step-terminal-block-3d hero-terminal-view">
            <span className="terminal-prompt">$</span>
            <pre className="terminal-cmd-text font-mono">{act.commandSnippet}</pre>
          </div>
        )}

        {/* Code Snippet if File Edit */}
        {act.codeSnippet && !act.commandSnippet && (
          <pre className="step-code-snippet-3d hero-code-view font-mono">{act.codeSnippet}</pre>
        )}

        {/* Output View with Line Cap */}
        {act.output && (
          <TruncatedOutput text={act.output} maxLines={5} />
        )}
      </div>
    </div>
  );
});

export default function ThinkingBlock({
  entries,
  streamingId,
  defaultOpen,
}: {
  entries: ThreadItem[];
  streamingId: string | null;
  defaultOpen?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultOpen === false);
  const [showAllEarlier, setShowAllEarlier] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const seenCount = useRef(entries.length);

  const live = thinkingLive(entries, streamingId);

  // Auto-scroll timeline smoothly when streaming new entries
  useEffect(() => {
    const el = bodyRef.current;
    if (collapsed || !el || entries.length === seenCount.current) return;
    seenCount.current = entries.length;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [entries.length, collapsed]);

  // Copy helper
  const copyText = useCallback((id: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1400);
    });
  }, []);

  const total = entries.length;
  const latestIndex = total - 1;
  const latestEntry = entries[latestIndex];

  // Previous completed entries
  const allPrevious = useMemo(() => {
    return total > 1 ? entries.slice(0, latestIndex) : [];
  }, [entries, latestIndex, total]);

  // Keep earlier ones clean if there are more than 3
  const hasHiddenEarlier = allPrevious.length > 3 && !showAllEarlier;
  const visiblePrevious = useMemo(() => {
    if (!hasHiddenEarlier) return allPrevious;
    return allPrevious.slice(allPrevious.length - 2);
  }, [allPrevious, hasHiddenEarlier]);

  const hiddenCount = hasHiddenEarlier ? allPrevious.length - 2 : 0;

  // Highlights summary for settled title
  const settledSummary = useMemo(() => {
    if (entries.length === 0) return "";
    const counts: Record<string, number> = {};
    for (const it of entries) {
      const act = humanizeAction(it);
      counts[act.category] = (counts[act.category] || 0) + 1;
    }
    const parts: string[] = [];
    if (counts["file-read"]) parts.push(`${counts["file-read"]} file${counts["file-read"] > 1 ? "s" : ""} read`);
    if (counts["file-write"]) parts.push(`${counts["file-write"]} file${counts["file-write"] > 1 ? "s" : ""} edited`);
    if (counts["terminal"]) parts.push(`${counts["terminal"]} command${counts["terminal"] > 1 ? "s" : ""}`);
    if (counts["search"]) parts.push(`${counts["search"]} search${counts["search"] > 1 ? "es" : ""}`);
    if (parts.length > 0) return parts.slice(0, 3).join(", ");
    return "Synthesized reasoning plan";
  }, [entries]);

  return (
    <div className={`thinking-card-3d ${live ? "is-live" : "is-settled"} ${collapsed ? "is-collapsed" : "is-open"}`}>
      {/* Specular Ambient Edge */}
      <div className="thinking-card-specular-edge" />

      {/* Header Bar */}
      <div className="thinking-header-row">
        <button
          type="button"
          className="thinking-header-main-btn"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
        >
          <div className="thinking-indicator-badge">
            {live ? (
              <div className="neural-frequency-rings" aria-label="Muse is reasoning">
                <span className="ring-pulse r1" />
                <span className="ring-pulse r2" />
                <span className="core-dot" />
              </div>
            ) : (
              <div className="thinking-done-badge-3d" title="Reasoning completed">
                <CheckIcon size={11} />
              </div>
            )}
          </div>

          <div className="thinking-summary-meta">
            <div className="thinking-headline">
              <span className="thinking-title">
                {live ? "Muse is reasoning..." : "Reasoned"}
              </span>

              <ThinkingTimer live={live} />

              <span className="thinking-step-count font-mono">
                ({entries.length} step{entries.length === 1 ? "" : "s"})
              </span>
            </div>

            {!live && (
              <span className="thinking-preview-text settled" title={settledSummary}>
                {settledSummary}
              </span>
            )}
          </div>

          <div className="thinking-header-right-actions">
            <span className="thinking-view-steps-hint">
              {collapsed ? "Show vertical flow" : "Collapse"}
            </span>
            <div className="thinking-expand-icon">
              <ChevronRightIcon size={14} className={collapsed ? "" : "is-expanded-rotate"} />
            </div>
          </div>
        </button>
      </div>

      {/* Vertical Steps Stream (Always visible vertically when open!) */}
      {!collapsed && (
        <div ref={bodyRef} className="vertical-thinking-timeline-flow">
          {/* Earlier steps notice toggle */}
          {hasHiddenEarlier && (
            <div className="earlier-steps-toggle-row">
              <button
                type="button"
                className="earlier-steps-toggle-btn"
                onClick={() => setShowAllEarlier(true)}
              >
                ▲ Show {hiddenCount} earlier completed step{hiddenCount > 1 ? "s" : ""}
              </button>
            </div>
          )}

          {/* Previous Completed Steps Rows */}
          {visiblePrevious.map((entry, idx) => {
            const actualIndex = hasHiddenEarlier ? hiddenCount + idx : idx;
            return (
              <CompletedStepRow
                key={entry.itemId}
                entry={entry}
                index={actualIndex}
                isLast={false}
                onCopy={copyText}
                isCopied={copiedId === entry.itemId}
              />
            );
          })}

          {/* HERO LATEST / ACTIVE STEP */}
          {latestEntry && (
            <HeroActiveStepCard
              key={latestEntry.itemId}
              entry={latestEntry}
              index={latestIndex}
              live={live}
              onCopy={copyText}
              isCopied={copiedId === latestEntry.itemId}
            />
          )}
        </div>
      )}
    </div>
  );
}
