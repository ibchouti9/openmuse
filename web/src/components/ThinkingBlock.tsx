import React, { useState, useMemo, useEffect, useRef } from "react";
import { ThreadItem, thinkingLive } from "../threading";
import { ChevronDownIcon, ChevronRightIcon, StopIcon } from "./Icons";

export function safeStr(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(safeStr).join(" ");
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function safeParseArgs(raw?: any): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : { raw };
  } catch {
    return { raw };
  }
}

function shortBaseName(p?: string): string {
  if (!p) return "";
  const s = safeStr(p).trim().replace(/^[\"']|[\"']$/g, "");
  const segments = s.split("/").filter(Boolean);
  return segments[segments.length - 1] || s;
}

function cleanRelativePath(p?: string): string {
  if (!p) return "";
  const s = safeStr(p).trim().replace(/^[\"']|[\"']$/g, "");
  const segments = s.split("/").filter(Boolean);
  if (segments.length > 3) {
    return segments.slice(-3).join("/");
  }
  return s;
}

export type ActivityItem =
  | {
      id: string;
      kind: "explore";
      fileCount: number;
      folderCount: number;
      searchCount: number;
      details: { type: "file" | "folder" | "search"; target: string; output?: string }[];
    }
  | {
      id: string;
      kind: "command";
      command: string;
      count: number;
      commands: { cmd: string; output?: string }[];
      isLive?: boolean;
    }
  | {
      id: string;
      kind: "edit";
      count: number;
      files: string[];
      details: { target: string; output?: string }[];
    }
  | {
      id: string;
      kind: "thought";
      text: string;
      isLive?: boolean;
    }
  | {
      id: string;
      kind: "other";
      label: string;
      output?: string;
    };

function groupEntries(entries: ThreadItem[], live: boolean): ActivityItem[] {
  const result: ActivityItem[] = [];

  let currentExplore: {
    id: string;
    files: Set<string>;
    folders: Set<string>;
    searches: Set<string>;
    details: { type: "file" | "folder" | "search"; target: string; output?: string }[];
  } | null = null;

  let currentCommands: {
    id: string;
    commands: { cmd: string; output?: string }[];
  } | null = null;

  const flushExplore = () => {
    if (currentExplore && (currentExplore.files.size > 0 || currentExplore.folders.size > 0 || currentExplore.searches.size > 0)) {
      result.push({
        id: currentExplore.id,
        kind: "explore",
        fileCount: currentExplore.files.size,
        folderCount: currentExplore.folders.size,
        searchCount: currentExplore.searches.size,
        details: currentExplore.details,
      });
    }
    currentExplore = null;
  };

  const flushCommands = () => {
    if (currentCommands && currentCommands.commands.length > 0) {
      const cmds = currentCommands.commands;
      result.push({
        id: currentCommands.id,
        kind: "command",
        command: cmds[cmds.length - 1].cmd,
        count: cmds.length,
        commands: cmds,
      });
    }
    currentCommands = null;
  };

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    const isLatest = idx === entries.length - 1;
    const isLiveStep = live && isLatest;

    // 1. Reasoning / Thought Text
    if (entry.kind === "reasoning") {
      flushExplore();
      flushCommands();
      const parts = (entry.summary || []).filter((s) => s && safeStr(s).trim());
      const rawText = parts.length > 0 ? parts.join("\n\n") : safeStr(entry.text);
      const text = rawText.trim();
      if (text) {
        result.push({
          id: entry.itemId ? `${entry.itemId}-${idx}` : `thought-${idx}`,
          kind: "thought",
          text,
          isLive: isLiveStep,
        });
      }
      continue;
    }

    // 2. Shell Execution via userShell
    if (entry.kind === "userShell") {
      flushExplore();
      const cmd = safeStr(entry.text).trim();
      if (!currentCommands) {
        currentCommands = {
          id: entry.itemId ? `${entry.itemId}-${idx}` : `cmd-${idx}`,
          commands: [],
        };
      }
      currentCommands.commands.push({ cmd: cmd || "command", output: safeStr(entry.visibleOutput) });
      continue;
    }

    // 3. Tool Calls
    if (entry.kind === "toolCall") {
      const tool = safeStr(entry.tool).toLowerCase();
      const parsed = safeParseArgs(entry.args);
      const out = safeStr(entry.visibleOutput);

      // A. Terminal commands
      if (
        tool === "bash" ||
        tool === "sh" ||
        tool === "run_command" ||
        tool === "exec" ||
        tool === "execute_command" ||
        tool.includes("terminal") ||
        tool.includes("command")
      ) {
        flushExplore();
        const cmd = safeStr(parsed.CommandLine || parsed.command || parsed.cmd || parsed.raw).trim();
        if (!currentCommands) {
          currentCommands = {
            id: entry.itemId ? `${entry.itemId}-${idx}` : `cmd-${idx}`,
            commands: [],
          };
        }
        currentCommands.commands.push({ cmd: cmd || tool, output: out });
        continue;
      }

      // B. File reads / inspections
      if (
        tool === "read_file" ||
        tool === "view_file" ||
        tool === "readfile" ||
        tool === "cat" ||
        tool.includes("view") ||
        tool.includes("read")
      ) {
        flushCommands();
        const raw = safeStr(parsed.path || parsed.AbsolutePath || parsed.TargetFile || parsed.file || parsed.filename || parsed.uri);
        const target = cleanRelativePath(raw) || "file";
        if (!currentExplore) {
          currentExplore = {
            id: entry.itemId ? `${entry.itemId}-${idx}` : `explore-${idx}`,
            files: new Set(),
            folders: new Set(),
            searches: new Set(),
            details: [],
          };
        }
        currentExplore.files.add(target);
        currentExplore.details.push({ type: "file", target, output: out });
        continue;
      }

      // C. Directory listings
      if (tool === "list_dir" || tool === "ls" || tool.includes("list_dir")) {
        flushCommands();
        const raw = safeStr(parsed.DirectoryPath || parsed.path);
        const target = cleanRelativePath(raw) || "folder";
        if (!currentExplore) {
          currentExplore = {
            id: entry.itemId ? `${entry.itemId}-${idx}` : `explore-${idx}`,
            files: new Set(),
            folders: new Set(),
            searches: new Set(),
            details: [],
          };
        }
        currentExplore.folders.add(target);
        currentExplore.details.push({ type: "folder", target, output: out });
        continue;
      }

      // D. Grep / Find / Codebase Search
      if (
        tool === "grep_search" ||
        tool === "search_files" ||
        tool === "ripgrep" ||
        tool === "grep" ||
        tool === "find_by_name" ||
        tool === "find_files" ||
        tool === "fd" ||
        tool.includes("grep") ||
        tool.includes("find") ||
        tool.includes("search")
      ) {
        flushCommands();
        const q = safeStr(parsed.Query || parsed.query || parsed.pattern || parsed.Pattern || "search");
        if (!currentExplore) {
          currentExplore = {
            id: entry.itemId ? `${entry.itemId}-${idx}` : `explore-${idx}`,
            files: new Set(),
            folders: new Set(),
            searches: new Set(),
            details: [],
          };
        }
        currentExplore.searches.add(q);
        currentExplore.details.push({ type: "search", target: q, output: out });
        continue;
      }

      // E. File writes / Edits
      if (
        tool === "write_to_file" ||
        tool === "write_file" ||
        tool === "replace_file_content" ||
        tool === "edit_file" ||
        tool.includes("edit") ||
        tool.includes("write")
      ) {
        flushExplore();
        flushCommands();
        const raw = safeStr(parsed.TargetFile || parsed.path || parsed.file);
        const short = shortBaseName(raw) || "file";
        result.push({
          id: entry.itemId ? `${entry.itemId}-${idx}` : `edit-${idx}`,
          kind: "edit",
          count: 1,
          files: [short],
          details: [{ target: short, output: out }],
        });
        continue;
      }

      // F. Generic / other tools
      flushExplore();
      flushCommands();
      result.push({
        id: entry.itemId ? `${entry.itemId}-${idx}` : `tool-${idx}`,
        kind: "other",
        label: tool || "Action",
        output: out,
      });
      continue;
    }

    // 4. Other general items
    flushExplore();
    flushCommands();
    const clean = safeStr(entry.text || entry.fallbackText).trim();
    if (clean) {
      result.push({
        id: entry.itemId ? `${entry.itemId}-${idx}` : `item-${idx}`,
        kind: "other",
        label: clean,
        output: safeStr(entry.visibleOutput),
      });
    }
  }

  flushExplore();
  flushCommands();

  return result;
}

interface ThinkingBlockProps {
  entries: ThreadItem[];
  streamingId: string | null;
  isLive?: boolean;
  onStop?: () => void;
}

export default function ThinkingBlock({
  entries,
  streamingId,
  isLive,
  onStop,
}: ThinkingBlockProps) {
  const live = isLive !== undefined ? isLive : thinkingLive(entries, streamingId);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});

  // Duration timer
  const [seconds, setSeconds] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (live) {
      if (!startRef.current) startRef.current = Date.now();
      const id = setInterval(() => {
        if (startRef.current) {
          setSeconds(Math.max(1, Math.round((Date.now() - startRef.current) / 1000)));
        }
      }, 1000);
      return () => clearInterval(id);
    }
  }, [live]);

  // While live: expand by default so user sees activity.
  // When done: collapse into one clean line unless user opened it.
  const isExpanded = live ? (userExpanded !== false) : (userExpanded === true);

  const activities = useMemo(() => groupEntries(entries, live), [entries, live]);

  const toggleItem = (id: string) => {
    setExpandedItems((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  if (!entries || entries.length === 0) return null;

  // Format elapsed time string like Antigravity: "Worked for 8m" or "Thought for 12s"
  const timeLabel = useMemo(() => {
    const s = Math.max(1, seconds);
    const timeFormatted = s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`;
    if (live) {
      return `Thinking for ${timeFormatted}...`;
    }
    return s >= 60 ? `Worked for ${timeFormatted}` : `Thought for ${timeFormatted}`;
  }, [live, seconds]);

  return (
    <div className="antigravity-thinking-block">
      {/* Top Main Header Line: "Worked for 8m ⌄" or "Thinking for 12s... ⌄" */}
      <div className="antigravity-header-row">
        <button
          type="button"
          className="antigravity-thinking-header"
          onClick={() => setUserExpanded((prev) => (prev === null ? !isExpanded : !prev))}
          aria-expanded={isExpanded}
        >
          {live && <span className="antigravity-live-dot" />}
          <span className="antigravity-header-label">{timeLabel}</span>
          {isExpanded ? (
            <ChevronDownIcon size={12} className="antigravity-header-chevron" />
          ) : (
            <ChevronRightIcon size={12} className="antigravity-header-chevron" />
          )}
        </button>

        {live && onStop && (
          <button
            type="button"
            className="antigravity-stop-btn"
            onClick={onStop}
            title="Interrupt reasoning"
          >
            <StopIcon size={10} />
            <span>Stop</span>
          </button>
        )}
      </div>

      {/* Expanded Activity List */}
      {isExpanded && (
        <div className="antigravity-thinking-content">
          {activities.map((act, index) => {
            const isLast = index === activities.length - 1;
            // Auto-expand last command if live
            const itemOpen = expandedItems[act.id] ?? (live && isLast && act.kind === "command");

            if (act.kind === "thought") {
              return (
                <div key={act.id} className="antigravity-thought-paragraph">
                  <span>{act.text}</span>
                  {act.isLive && <span className="antigravity-thought-cursor">▍</span>}
                </div>
              );
            }

            if (act.kind === "explore") {
              const parts: React.ReactNode[] = [];
              if (act.fileCount > 0) {
                parts.push(
                  <span key="f">
                    <strong className="count-bold">{act.fileCount}</strong> file{act.fileCount > 1 ? "s" : ""}
                  </span>
                );
              }
              if (act.folderCount > 0) {
                parts.push(
                  <span key="d">
                    <strong className="count-bold">{act.folderCount}</strong> folder{act.folderCount > 1 ? "s" : ""}
                  </span>
                );
              }
              if (act.searchCount > 0) {
                parts.push(
                  <span key="s">
                    <strong className="count-bold">{act.searchCount}</strong> search{act.searchCount > 1 ? "es" : ""}
                  </span>
                );
              }

              return (
                <div key={act.id} className="antigravity-activity-item">
                  <div
                    className="antigravity-activity-row"
                    onClick={() => toggleItem(act.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") toggleItem(act.id);
                    }}
                  >
                    <span>Explored </span>
                    {parts.map((p, i) => (
                      <React.Fragment key={i}>
                        {i > 0 && <span>, </span>}
                        {p}
                      </React.Fragment>
                    ))}
                    {itemOpen ? (
                      <ChevronDownIcon size={11} className="row-chevron" />
                    ) : (
                      <ChevronRightIcon size={11} className="row-chevron" />
                    )}
                  </div>

                  {itemOpen && (
                    <div className="antigravity-explore-box">
                      {act.details.map((d, i) => (
                        <div key={i} className="antigravity-explore-item">
                          <span className="antigravity-explore-type">{d.type}</span>
                          <span className="antigravity-explore-path">{d.target}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            }

            if (act.kind === "command") {
              const isSingle = act.count === 1;
              const cmdLabel = isSingle ? act.command : `${act.count} commands`;

              return (
                <div key={act.id} className="antigravity-activity-item">
                  <div
                    className="antigravity-activity-row"
                    onClick={() => toggleItem(act.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") toggleItem(act.id);
                    }}
                  >
                    <span>Ran </span>
                    {isSingle ? (
                      <code className="cmd-name">{cmdLabel}</code>
                    ) : (
                      <span className="count-bold">{cmdLabel}</span>
                    )}
                    {itemOpen ? (
                      <ChevronDownIcon size={11} className="row-chevron" />
                    ) : (
                      <ChevronRightIcon size={11} className="row-chevron" />
                    )}
                  </div>

                  {itemOpen && (
                    <div className="antigravity-cmd-group">
                      {act.commands.map((c, i) => (
                        <div key={i} className="antigravity-cmd-box">
                          <div className="antigravity-cmd-line">
                            <span className="antigravity-prompt-path">~/.../openmuse</span>
                            <span className="antigravity-dollar">$</span>
                            <span className="antigravity-cmd-text">{c.cmd}</span>
                          </div>
                          {c.output && (
                            <pre className="antigravity-output-pre">{c.output}</pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            }

            if (act.kind === "edit") {
              const editLabel = act.count === 1 ? act.files[0] : `${act.count} files`;
              return (
                <div key={act.id} className="antigravity-activity-item">
                  <div
                    className="antigravity-activity-row"
                    onClick={() => toggleItem(act.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <span>Edited </span>
                    <strong className="count-bold">{editLabel}</strong>
                    {itemOpen ? (
                      <ChevronDownIcon size={11} className="row-chevron" />
                    ) : (
                      <ChevronRightIcon size={11} className="row-chevron" />
                    )}
                  </div>
                  {itemOpen && (
                    <div className="antigravity-explore-box">
                      {act.details.map((d, i) => (
                        <div key={i} className="antigravity-explore-item">
                          <span className="antigravity-explore-type">file</span>
                          <span className="antigravity-explore-path">{d.target}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            }

            // Other fallback
            return (
              <div key={act.id} className="antigravity-activity-item">
                <div
                  className="antigravity-activity-row"
                  onClick={() => toggleItem(act.id)}
                  role="button"
                  tabIndex={0}
                >
                  <span>{act.label}</span>
                  {act.output && (
                    itemOpen ? (
                      <ChevronDownIcon size={11} className="row-chevron" />
                    ) : (
                      <ChevronRightIcon size={11} className="row-chevron" />
                    )
                  )}
                </div>
                {itemOpen && act.output && (
                  <pre className="antigravity-output-pre">{act.output}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
