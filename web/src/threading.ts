// Pure thread-grouping helpers for the chat view.
//
// Contract: only `userMessage` and `agentMessage` render as message bubbles.
// Every other item kind (reasoning, toolCall, userShell, subagent,
// workflow, ...) is intermediate activity and folds into a single
// per-run "thinking" block that updates in place as its entries stream in.

export interface ThreadItem {
  itemId: string;
  kind: string;
  text: string;
  status: string;
  tool?: string;
  args?: string;
  visibleOutput?: string;
  summary?: string[];
  fallbackText?: string;
  turnId?: string;
  revision?: number;
  done: boolean;
}

export type Block =
  | { type: "user"; item: ThreadItem }
  | { type: "agent"; item: ThreadItem }
  | { type: "thinking"; key: string; entries: ThreadItem[] };

export function isMessage(item: ThreadItem): boolean {
  return item.kind === "userMessage" || item.kind === "agentMessage";
}

// Collapse each consecutive run of intermediate items into one thinking
// block. Messages break runs, so an agent reply between two tool phases
// yields block → message → block, preserving chronological order.
export function groupThread(items: ThreadItem[]): Block[] {
  const blocks: Block[] = [];
  let open: ThreadItem[] | null = null;
  let openKey = "";
  const flush = () => {
    if (open && open.length > 0) blocks.push({ type: "thinking", key: openKey, entries: open });
    open = null;
  };
  for (const it of items) {
    if (it.kind === "userMessage") {
      flush();
      blocks.push({ type: "user", item: it });
    } else if (it.kind === "agentMessage") {
      flush();
      blocks.push({ type: "agent", item: it });
    } else {
      if (!open) {
        open = [];
        openKey = `think-${it.itemId}`;
      }
      open.push(it);
    }
  }
  flush();
  return blocks;
}

// Route an item/delta frame to the field it targets. `field` is absent for
// agentMessage text, "output" for tool/userShell visible output, and
// "summary.N" for reasoning summary part N. Unknown fields are ignored so
// one new surface can't garble the transcript. Pure: returns a new object.
export function applyItemDelta(item: ThreadItem, field: string, delta: string): ThreadItem {
  const next: ThreadItem = { ...item };
  if (item.summary) next.summary = [...item.summary];
  if (!delta) return next;
  if (!field || field === "text") {
    next.text = (next.text || "") + delta;
  } else if (field === "output") {
    next.visibleOutput = (next.visibleOutput || "") + delta;
  } else {
    const m = /^summary\.(\d+)$/.exec(field);
    if (m) {
      const n = Number(m[1]);
      const s = next.summary ? [...next.summary] : [];
      while (s.length <= n) s.push("");
      s[n] += delta;
      next.summary = s;
    }
  }
  return next;
}

// A thinking block is live while any entry is still in progress or is the
// item currently receiving deltas.
export function thinkingLive(entries: ThreadItem[], streamingId: string | null): boolean {
  if (streamingId && entries.some((e) => e.itemId === streamingId)) return true;
  return entries.some((e) => e.status === "inProgress");
}

// One-line generic rendering for kinds without dedicated UI (schema: render
// unknown kinds generically from kind + status + fallback text).
export function genericRowText(entry: ThreadItem): string {
  if (entry.fallbackText) return entry.fallbackText;
  if (entry.text) return entry.text;
  const parts = [entry.kind || "activity", entry.status && entry.status !== "completed" ? entry.status : ""].filter(
    Boolean,
  );
  return parts.join(" · ");
}
