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
  displayText?: string;
  turnId?: string;
  revision?: number;
  done: boolean;
}

export type Block =
  | { type: "user"; item: ThreadItem }
  | { type: "agent"; item: ThreadItem }
  | { type: "thinking"; key: string; entries: ThreadItem[]; isLive?: boolean };

export function isMessage(item: ThreadItem): boolean {
  return item.kind === "userMessage" || item.kind === "agentMessage";
}

export interface GroupThreadOptions {
  busy?: boolean;
  streamingId?: string | null;
}

// Collapse each consecutive run of intermediate items into one thinking
// block. Messages break runs, so an agent reply between two tool phases
// yields block → message → block, preserving chronological order.
export function groupThread(items: ThreadItem[], options?: GroupThreadOptions): Block[] {
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

  // If busy, determine whether the last thinking phase is active,
  // or synthesize an active planning block if the model is currently formulating
  if (options?.busy) {
    const lastBlock = blocks[blocks.length - 1];
    if (lastBlock && lastBlock.type === "user") {
      // User just sent message, model is formulating response
      blocks.push({
        type: "thinking",
        key: "think-live-active",
        entries: [
          {
            itemId: "live-planning-head",
            kind: "reasoning",
            text: "Formulating plan & synthesizing context...",
            status: "inProgress",
            summary: ["Formulating plan & synthesizing context..."],
            done: false,
          },
        ],
        isLive: true,
      });
    }
  }

  // Calculate isLive for each thinking block
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "thinking") {
      if (b.isLive !== undefined) continue;
      const hasInProgress = b.entries.some((e) => e.status === "inProgress");
      const isCurrentlyStreaming = !!(options?.streamingId && b.entries.some((e) => e.itemId === options.streamingId));

      let live = hasInProgress || isCurrentlyStreaming;

      // If session is busy, check if this thinking block has NOT been followed by an agent message that has delivered text
      if (!live && options?.busy) {
        const subsequent = blocks.slice(i + 1);
        const agentHasStarted = subsequent.some(
          (next) => next.type === "agent" && ((next.item.text && next.item.text.trim().length > 0) || next.item.done)
        );
        if (!agentHasStarted) {
          live = true;
        }
      }

      b.isLive = live;
    }
  }

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
