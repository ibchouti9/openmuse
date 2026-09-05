import { useEffect, useRef, useState, useMemo } from "react";
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
    const preview = firstSentence.length > 110 ? `${firstSentence.slice(0, 109)}…` : firstSentence;
    return {
      category: "reasoning",
      categoryLabel: "Reasoning",
      actionTitle: "Neural Reasoning",
      headline: preview || "Reasoning through problem context...",
      preview: preview || "Analyzing context...",
      codeSnippet: summaryParts.length > 0 ? summaryParts.join("\n\n") : (entry.text || ""),
    };
  }

  if (entry.kind === "userShell") {
    const cmd = (entry.text || "").trim();
    return {
      category: "terminal",
      categoryLabel: "Shell",
      actionTitle: "User Shell",
      target: cmd,
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
      const headline = target ? `Read ${target}` : "Inspect file";
      return {
        category: "file-read",
        categoryLabel: "File Read",
        actionTitle: "Inspect File",
        target,
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
      const headline = target ? `Create ${target}` : "Create file";
      return {
        category: "file-write",
        categoryLabel: "File Create",
        actionTitle: "Create File",
        target,
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
      const headline = target ? `Edit ${target}` : "Edit file";
      return {
        category: "file-write",
        categoryLabel: "File Edit",
        actionTitle: "Edit File",
        target,
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
      return {
        category: "terminal",
        categoryLabel: "Terminal",
        actionTitle: "Execute Command",
        target: cmd,
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
        headline,
        preview: headline,
        output: out,
      };
    }

    if (tool === "list_dir" || tool === "ls" || tool.includes("list_dir")) {
      const raw = parsed.DirectoryPath || parsed.path || "";
      const target = cleanPath(raw);
      const headline = target ? `List ${target}` : "List directory";
      return {
        category: "search",
        categoryLabel: "Directory",
        actionTitle: "List Directory",
        target,
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

  // Timer for duration calculation
  useEffect(() => {
    if (!live) return;
    const t0 = Date.now();
    setElapsed(0);
    const interval = setInterval(() => {
      setElapsed(Math.max(1, Math.round((Date.now() - t0) / 1000)));
    }, 1000);
    return () => clearInterval(interval);
  }, [live]);

  // Auto-scroll timeline when expanded and streaming new items
  useEffect(() => {
    const el = bodyRef.current;
    if (!expanded || !el || entries.length === seenCount.current) return;
    seenCount.current = entries.length;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [entries.length, expanded]);

  // Humanize latest action for live preview
  const latestEntry = entries[entries.length - 1];
  const latestAction = useMemo(() => {
    return latestEntry ? humanizeAction(latestEntry) : null;
  }, [latestEntry]);

  // Generate an elegant settled highlights summary
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
    if (counts["web"]) parts.push(`${counts["web"]} web query`);
    if (parts.length > 0) return parts.slice(0, 3).join(", ");
    return "Analyzed workspace and synthesized response";
  }, [entries]);

  function copyText(id: string, text: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1400);
    });
  }

  return (
    <div className={`thinking-card-3d ${live ? "is-live" : "is-settled"} ${expanded ? "is-expanded" : ""}`}>
      {/* Dynamic Specular Edge Animation */}
      <div className="thinking-card-specular-edge" />

      {/* Interactive Collapsible Header */}
      <button
        type="button"
        className="thinking-header-btn"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
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

            {!live && elapsed > 0 && (
              <span className="thinking-duration font-mono">{elapsed}s</span>
            )}

            <span className="thinking-step-count font-mono">
              ({entries.length} step{entries.length === 1 ? "" : "s"})
            </span>

            {live && (
              <div className="neural-live-bars" aria-hidden>
                <span className="bar b1" />
                <span className="bar b2" />
                <span className="bar b3" />
                <span className="bar b4" />
              </div>
            )}
          </div>

          {/* Action preview: dynamic live stream or clean settled highlights */}
          <div className="thinking-preview-row">
            {live && latestAction ? (
              <span className="thinking-preview-text live-stream">
                <span className="pulse-lightning">⚡</span> {latestAction.preview}
              </span>
            ) : (
              <span className="thinking-preview-text settled" title={settledSummary}>
                {settledSummary}
              </span>
            )}
          </div>
        </div>

        <div className="thinking-expand-icon" title={expanded ? "Collapse steps" : "View steps"}>
          <ChevronRightIcon size={14} />
        </div>
      </button>

      {/* Expandable Step-by-Step Execution Timeline */}
      <div className={`thinking-content-collapse ${expanded ? "expanded" : ""}`}>
        <div ref={bodyRef} className="thinking-steps-timeline">
          {entries.map((entry, idx) => {
            const act = humanizeAction(entry);
            const active = streamingId === entry.itemId || entry.status === "inProgress";
            const copyContent = act.commandSnippet || act.codeSnippet || act.output || act.headline;

            return (
              <div
                key={entry.itemId}
                className={`timeline-step-row ${active ? "active-step" : "completed-step"}`}
              >
                <div className="step-gutter">
                  <span className="step-number font-mono">{String(idx + 1).padStart(2, "0")}</span>
                  {idx < entries.length - 1 && <div className="step-connector-line" />}
                </div>

                <div className="step-content-card-3d">
                  <div className="step-header">
                    <div className={`step-icon-badge cat-${act.category}`}>
                      <CategoryIcon category={act.category} />
                    </div>

                    <span className="step-label">{act.actionTitle}</span>

                    {act.target && (
                      <span className="step-target-pill font-mono" title={act.target}>
                        {act.target}
                      </span>
                    )}

                    {active && <span className="step-active-pill">Running</span>}

                    <div className="spacer" />

                    {copyContent && (
                      <button
                        type="button"
                        className="step-copy-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          copyText(entry.itemId, copyContent);
                        }}
                        title="Copy step content"
                      >
                        {copiedId === entry.itemId ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                        <span>{copiedId === entry.itemId ? "Copied" : "Copy"}</span>
                      </button>
                    )}
                  </div>

                  {/* Terminal Execution Snippet */}
                  {act.commandSnippet && (
                    <div className="step-terminal-block-3d">
                      <span className="terminal-prompt">$</span>
                      <pre className="terminal-cmd-text font-mono">{act.commandSnippet}</pre>
                    </div>
                  )}

                  {/* Code Modification Snippet */}
                  {act.codeSnippet && !act.commandSnippet && (
                    <pre className="step-code-snippet-3d font-mono">{act.codeSnippet}</pre>
                  )}

                  {/* Visible Tool / Terminal Output */}
                  {act.output && (
                    <div className="step-output-container">
                      <div className="step-output-label">Output</div>
                      <pre className="step-output-text-3d font-mono">{act.output}</pre>
                    </div>
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
