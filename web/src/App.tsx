import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { api, exportSession, ops, subscribe, turnCancel } from "./api";
import BrowserPanel from "./BrowserPanel";
import { applyItemDelta, groupThread, ThreadItem } from "./threading";

import {
  CodeIcon,
  DownloadIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitForkIcon,
  GlobeIcon,
  MessageSquareIcon,
  Minimize2Icon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  SidebarIcon,
  SparklesIcon,
  UserIcon,
} from "./components/Icons";
import Composer, { Attachment } from "./components/Composer";
import ThinkingBlock from "./components/ThinkingBlock";
import ApprovalCard, { Approval } from "./components/ApprovalCard";
import QuestionCard, { InputPrompt } from "./components/QuestionCard";
import GitMenu, { GitStatus } from "./components/GitMenu";
import WorkspacePicker from "./components/WorkspacePicker";
import SettingsView from "./components/SettingsView";
import AccountView from "./components/AccountView";
import MusePrism3D from "./components/MusePrism3D";
import MessageActions from "./components/MessageActions";

interface Item extends ThreadItem {}

interface Session {
  sessionId: string;
  title?: string;
  updatedAt?: string;
  turnCount?: number;
  status?: string;
}

interface Todo {
  text: string;
  status: string;
  activeForm?: string;
}

const DEFAULT_MODEL = "muse-spark-1.3";

const APPROVAL_LABELS: Record<string, string> = {
  denyUnmatched: "Deny new",
  onRequest: "Ask",
  promptUnmatched: "Ask new",
  allowAll: "Auto-accept",
};

type Tab = "chat" | "settings" | "account";

const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "js", "jsx", "ts", "tsx",
  "py", "rb", "go", "rs", "java", "c", "h", "cpp", "hpp", "cs", "sh", "yml", "yaml",
  "toml", "ini", "css", "html", "xml", "sql", "swift", "kt", "scala", "php", "r", "vue",
]);

function readAsDataURL(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(f);
  });
}

function wireToItem(it: any): Item {
  return {
    itemId: it.itemId,
    kind: it.kind || "message",
    text: it.text || "",
    status: it.status || "",
    tool: it.tool,
    args: it.args,
    visibleOutput: it.visibleOutput,
    summary: Array.isArray(it.summary) ? it.summary.map((s: unknown) => String(s ?? "")) : undefined,
    fallbackText: typeof it.fallbackText === "string" ? it.fallbackText : undefined,
    turnId: typeof it.turnId === "string" ? it.turnId : undefined,
    revision: typeof it.revision === "number" ? it.revision : undefined,
    done: it.status !== "inProgress",
  };
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

marked.use({
  renderer: {
    code({ text, lang }: any) {
      return (
        `<div class="codeblock"><div class="codehead"><span>${escHtml(lang || "code")}</span>` +
        `<button type="button" data-code="${encodeURIComponent(text)}">Copy</button></div>` +
        `<pre><code>${escHtml(text)}</code></pre></div>`
      );
    },
    codespan({ text }: any) {
      return `<code class="inline">${escHtml(text)}</code>`;
    },
  },
});

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text || "", { async: false }) as string;
    return DOMPurify.sanitize(raw, { ADD_ATTR: ["data-code"] });
  }, [text]);

  function onClick(e: React.MouseEvent) {
    const el = (e.target as HTMLElement).closest("[data-code]");
    if (!el) return;
    const btn = el as HTMLButtonElement;
    navigator.clipboard?.writeText(decodeURIComponent(el.getAttribute("data-code") || "")).then(() => {
      btn.textContent = "✓ Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1400);
    });
  }

  return <div className="md-content" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

function groupSessionsByDate(sessions: Session[]) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const last7DaysStart = todayStart - 6 * 86400000;

  const groups: { label: string; sessions: Session[] }[] = [
    { label: "Today", sessions: [] },
    { label: "Yesterday", sessions: [] },
    { label: "Previous 7 Days", sessions: [] },
    { label: "Older", sessions: [] },
  ];

  for (const s of sessions) {
    const time = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
    if (time >= todayStart) {
      groups[0].sessions.push(s);
    } else if (time >= yesterdayStart) {
      groups[1].sessions.push(s);
    } else if (time >= last7DaysStart) {
      groups[2].sessions.push(s);
    } else {
      groups[3].sessions.push(s);
    }
  }

  return groups.filter((g) => g.sessions.length > 0);
}

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");
  const [menuOpen, setMenuOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [chatFilter, setChatFilter] = useState("");
  const [transcriptFilter, setTranscriptFilter] = useState("");

  const daypart = (() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  })();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [prompts, setPrompts] = useState<InputPrompt[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ connected: boolean; lastError: string | null; mock?: boolean }>({
    connected: false,
    lastError: null,
  });
  const [usage, setUsage] = useState<{ inTok: number; outTok: number; model?: string } | null>(null);
  const [ctx, setCtx] = useState<{ used: number; window: number } | null>(null);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [approvalMode, setApprovalMode] = useState("allowAll");
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [workspace, setWorkspace] = useState(() => localStorage.getItem("openmuse.workspace") || "");
  const [picking, setPicking] = useState(false);
  const [effort, setEffort] = useState(() => localStorage.getItem("openmuse.effort") || "");
  const [git, setGit] = useState<GitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitAction, setGitAction] = useState<string | null>(null);
  const [gitNote, setGitNote] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const pendingDeltas = useRef<{ itemId: string; field: string; delta: string }[]>([]);

  function chooseEffort(e: string) {
    setEffort(e);
    localStorage.setItem("openmuse.effort", e);
  }

  function chooseWorkspace(p: string) {
    setWorkspace(p);
    localStorage.setItem("openmuse.workspace", p);
    setPicking(false);
  }

  const gitChanges = git?.total || 0;

  async function refreshGit() {
    setGitLoading(true);
    try {
      setGit((await ops.gitStatus(workspace)) as GitStatus);
    } catch (e: any) {
      setGitNote(e.message);
    } finally {
      setGitLoading(false);
    }
  }

  async function gitCommit(message: string, push: boolean) {
    setGitAction(push ? "commit&push" : "commit");
    setGitNote(null);
    try {
      const r = (await ops.gitCommit(workspace, message, push)) as { hash?: string; pushed?: boolean; status: GitStatus };
      setGit(r.status);
      setGitNote(`✓ committed ${r.hash || ""}${r.pushed ? " and pushed" : ""}`.trim());
    } catch (e: any) {
      setGitNote(e.message);
    } finally {
      setGitAction(null);
    }
  }

  async function gitPush() {
    setGitAction("push");
    setGitNote(null);
    try {
      const r = (await ops.gitPush(workspace)) as { status: GitStatus };
      setGit(r.status);
      setGitNote("✓ pushed");
    } catch (e: any) {
      setGitNote(e.message);
    } finally {
      setGitAction(null);
    }
  }

  async function gitCreatePr(title: string, body: string) {
    setGitAction("pr");
    setGitNote(null);
    try {
      const r = (await ops.gitPr(workspace, title, body)) as { url?: string };
      setGitNote(`✓ PR created${r.url ? `: ${r.url}` : ""}`);
    } catch (e: any) {
      setGitNote(e.message);
    } finally {
      setGitAction(null);
    }
  }

  useEffect(() => {
    refreshGit();
    const t = setInterval(refreshGit, 10000);
    return () => clearInterval(t);
  }, [workspace]);

  function removeAttachment(id: string) {
    setAttachments((xs) => xs.filter((a) => a.id !== id));
  }

  async function ingestFile(f: File) {
    const id = `att-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    if (f.type.startsWith("image/")) {
      if (f.size > 12 * 1024 * 1024) {
        setError(`${f.name || "Image"}: images over 12MB cannot be attached`);
        return;
      }
      setAttachments((xs) =>
        xs.length >= 8
          ? xs
          : [...xs, { id, kind: "image", name: f.name || "Pasted image", mime: f.type, size: f.size, ready: false }],
      );
      try {
        const dataUrl = await readAsDataURL(f);
        let width: number | undefined;
        let height: number | undefined;
        try {
          const bmp = await createImageBitmap(f);
          width = bmp.width;
          height = bmp.height;
          bmp.close();
        } catch {
          /* optional dimensions */
        }
        setAttachments((xs) => xs.map((a) => (a.id === id ? { ...a, dataUrl, width, height, ready: true } : a)));
      } catch {
        setAttachments((xs) => xs.map((a) => (a.id === id ? { ...a, error: "Unreadable" } : a)));
      }
      return;
    }
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    if (f.size <= 256 * 1024 && (f.type.startsWith("text/") || f.type === "application/json" || TEXT_EXTS.has(ext))) {
      setAttachments((xs) =>
        xs.length >= 8
          ? xs
          : [...xs, { id, kind: "text", name: f.name, mime: f.type, size: f.size, ready: false }],
      );
      try {
        const text = await f.text();
        setAttachments((xs) => xs.map((a) => (a.id === id ? { ...a, text, ready: true } : a)));
      } catch {
        setAttachments((xs) => xs.map((a) => (a.id === id ? { ...a, error: "Unreadable" } : a)));
      }
      return;
    }
    setError(`Cannot attach ${f.name || "file"}: images and text files under 256KB only.`);
  }

  function addFiles(files: File[]) {
    if (attachments.length >= 8) {
      setError("Maximum of 8 attachments per message");
      return;
    }
    setError(null);
    for (const f of files.slice(0, 8 - attachments.length)) void ingestFile(f);
  }

  async function attachScreenshot(dataUrl: string, name: string) {
    setError(null);
    if (attachments.length >= 8) {
      setError("Maximum of 8 attachments per message");
      return;
    }
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await ingestFile(new File([blob], name, { type: "image/png" }));
    } catch {
      setError("Could not attach screenshot");
    }
  }

  function cleanTitle(t: string): string {
    return t
      .replace(/[*_`#~>|[\]()]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 48);
  }

  function fmtDate(iso?: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function titleFor(s: Session): string {
    const dated = fmtDate(s.updatedAt);
    const fallback = dated ? `Chat · ${dated}` : `Chat ${s.sessionId.slice(0, 4)}…${s.sessionId.slice(-4)}`;
    return titles[s.sessionId] || s.title || fallback;
  }

  function metaFor(s: Session): string {
    const turns = s.turnCount != null ? `${s.turnCount} turn${s.turnCount === 1 ? "" : "s"}` : "";
    return [turns, fmtDate(s.updatedAt)].filter(Boolean).join(" · ");
  }

  function sortSessions(xs: Session[]): Session[] {
    return xs.slice().sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : NaN;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : NaN;
      if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
      return 0;
    });
  }

  function upsertSessionList(xs: Session[], s: Session): Session[] {
    if (!s || !s.sessionId) return xs;
    const i = xs.findIndex((x) => x.sessionId === s.sessionId);
    if (i >= 0) {
      const next = xs.slice();
      next[i] = { ...xs[i], ...s };
      return sortSessions(next);
    }
    return sortSessions([{ sessionId: s.sessionId, title: s.title, updatedAt: s.updatedAt }, ...xs]);
  }

  function titleFromItems(arr: Item[], sid: string) {
    const first = arr.find((w) => w.kind === "userMessage" && w.text.trim());
    if (first) {
      const t = cleanTitle(first.text);
      if (t) setTitles((ts) => (ts[sid] ? ts : { ...ts, [sid]: t }));
    }
  }

  useEffect(() => {
    if (!stickRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: streaming ? "auto" : "smooth", block: "end" });
  }, [items, approvals, prompts, streaming]);

  const upsertItem = useCallback((wire: any) => {
    if (!wire || !wire.itemId || typeof wire.kind !== "string") return;
    let it = wireToItem(wire);
    const buffered = pendingDeltas.current.filter((d) => d.itemId === it.itemId);
    if (buffered.length > 0) {
      pendingDeltas.current = pendingDeltas.current.filter((d) => d.itemId !== it.itemId);
      for (const d of buffered) it = applyItemDelta(it, d.field, d.delta);
    }
    setItems((xs) => {
      const i = xs.findIndex((x) => x.itemId === it.itemId);
      if (i >= 0) {
        const prev = xs[i];
        if (it.revision != null && prev.revision != null && it.revision < prev.revision) return xs;
        const next = xs.slice();
        next[i] = {
          ...it,
          text: it.text || prev.text,
          visibleOutput: it.visibleOutput || prev.visibleOutput,
          summary: it.summary && it.summary.length ? it.summary : prev.summary,
          fallbackText: it.fallbackText || prev.fallbackText,
        };
        return next;
      }
      if (it.kind === "userMessage") {
        const j = xs.findIndex((x) => x.itemId.startsWith("local-") && x.text === it.text);
        if (j >= 0) {
          const next = xs.slice();
          next[j] = it;
          return next;
        }
        const k = xs.findIndex((x) => x.itemId.startsWith("local-"));
        if (k >= 0) {
          const next = xs.slice();
          next[k] = it;
          return next;
        }
      }
      return [...xs, it];
    });
  }, []);

  const onEvent = useCallback(
    (method: string, p: any) => {
      if (method === "session/started" && p && p.session) {
        setSessions((xs) => upsertSessionList(xs, p.session));
        return;
      }
      if (p.sessionId && sessionId && p.sessionId !== sessionId) return;
      switch (method) {
        case "turn/started":
          setBusy(true);
          break;
        case "approval/updated":
          setApprovals((xs) => {
            const i = xs.findIndex((a) => a.approvalId === p.approvalId);
            if (i < 0) return xs;
            const next = xs.slice();
            next[i] = { ...next[i], availableChoices: p.availableChoices || next[i].availableChoices };
            return next;
          });
          break;
        case "session/approvalModeChanged":
          if (p.mode) setApprovalMode(p.mode);
          break;
        case "item/started":
        case "item/updated":
          upsertItem(p.item);
          setBusy(true);
          break;
        case "item/delta": {
          if (!p.itemId || typeof p.delta !== "string") break;
          const field = p.field || "text";
          const known = itemsRef.current.some((it) => it.itemId === p.itemId);
          if (!known) {
            if (!pendingDeltas.current.some((d) => d.itemId === p.itemId && d.field === field && d.delta === p.delta)) {
              pendingDeltas.current = [...pendingDeltas.current, { itemId: p.itemId, field, delta: p.delta }];
            }
          } else {
            setItems((xs) => {
              const i = xs.findIndex((it) => it.itemId === p.itemId);
              if (i < 0) return xs;
              const next = xs.slice();
              next[i] = applyItemDelta(next[i], field, p.delta);
              return next;
            });
          }
          setStreaming(p.itemId);
          break;
        }
        case "item/completed":
          upsertItem(p.item);
          setStreaming((s) => (p.item && s === p.item.itemId ? null : s));
          break;
        case "turn/completed":
        case "turn/cancelled":
        case "turn/retracted":
          setBusy(false);
          setStreaming(null);
          break;
        case "approval/requested":
          setApprovals((xs) => [
            ...xs.filter((a) => a.approvalId !== p.approvalId),
            {
              approvalId: p.approvalId,
              sessionId: p.sessionId,
              toolName: p.toolName || "tool",
              subject: p.subject,
              rawArgs: p.rawArgs,
              availableChoices: p.availableChoices || [],
              currentRequirementId: p.currentRequirementId,
            },
          ]);
          break;
        case "approval/resolved":
          setApprovals((xs) => xs.map((a) => (a.approvalId === p.approvalId ? { ...a, settled: true } : a)));
          break;
        case "userInput/requested":
          setPrompts((xs) => [
            ...xs.filter((q) => q.userInputId !== p.userInputId),
            { userInputId: p.userInputId, sessionId: p.sessionId, toolName: p.toolName || "tool", questions: p.questions || [] },
          ]);
          setBusy(true);
          break;
        case "userInput/settled":
          setPrompts((xs) => xs.map((q) => (q.userInputId === p.userInputId ? { ...q, settled: true } : q)));
          break;
        case "session/tokenUsage": {
          const u = p.usage || {};
          const c = p.cumulative || {};
          setUsage({ inTok: c.promptTokens ?? u.inputTokens ?? 0, outTok: c.outputTokens ?? u.outputTokens ?? 0, model: p.modelId });
          break;
        }
        case "session/contextUsage":
          if (p.usedTokens != null && p.windowTokens) setCtx({ used: p.usedTokens, window: p.windowTokens });
          break;
        case "session/todoListChanged":
          setTodos(p.items || []);
          break;
        default:
          break;
      }
    },
    [sessionId, upsertItem],
  );

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  useEffect(() => subscribe((method: string, params: any) => onEventRef.current(method, params), setStatus), []);

  const titleTried = useRef<Set<string>>(new Set());
  useEffect(() => {
    const missing = sessions
      .filter((s) => !titles[s.sessionId] && !s.title && !titleTried.current.has(s.sessionId))
      .slice(0, 25);
    if (missing.length === 0) return;
    missing.forEach((s) => titleTried.current.add(s.sessionId));
    let cancelled = false;
    (async () => {
      const queue = missing.slice();
      async function worker() {
        while (queue.length > 0 && !cancelled) {
          const s = queue.shift();
          if (!s) return;
          try {
            const r = await api(`/api/view?sessionId=${encodeURIComponent(s.sessionId)}`);
            const evts = r.events || [];
            const first = evts
              .map((e: any) => e.params && e.params.item)
              .find((w: any) => w && w.kind === "userMessage" && w.text && w.text.trim());
            if (first && !cancelled) {
              const t = cleanTitle(first.text);
              if (t) setTitles((ts) => (ts[s.sessionId] ? ts : { ...ts, [s.sessionId]: t }));
            }
          } catch {
            /* ignore */
          }
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()]);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessions, titles]);

  useEffect(() => {
    api("/api/health")
      .then((h) => setStatus(h.host))
      .catch((e) => setError(e.message));
    api("/api/sessions")
      .then((r) => {
        const arr = r.sessions || r || [];
        const seen = new Set<string>();
        const deduped = (Array.isArray(arr) ? arr : []).filter((s: Session) =>
          s && s.sessionId ? (seen.has(s.sessionId) ? false : (seen.add(s.sessionId), true)) : false,
        );
        setSessions(sortSessions(deduped));
      })
      .catch(() => {});
    api("/api/models")
      .then((r) => {
        const list = r.models || r || [];
        setModels(
          list.map((m: any) => (typeof m === "string" ? m : m.modelId || m.id || m.label || String(m))),
        );
      })
      .catch(() => {});
  }, []);

  function resetView() {
    setItems([]);
    setApprovals([]);
    setPrompts([]);
    setTodos([]);
    setUsage(null);
    setCtx(null);
    setBusy(false);
    setStreaming(null);
    pendingDeltas.current = [];
  }

  function keepWire(w: any) {
    return w && w.itemId && typeof w.kind === "string";
  }

  function applyHistory(r: any, sid: string) {
    const hist = r.history || {};
    const arr = hist.items || [];
    if (arr.length > 0) {
      const mapped = arr.filter(keepWire).map(wireToItem);
      setItems(mapped);
      titleFromItems(mapped, sid);
    }
  }

  async function loadTranscript(sid: string) {
    try {
      const r = await api(`/api/transcript?sessionId=${encodeURIComponent(sid)}`);
      const arr = r.items || [];
      if (arr.length > 0) {
        const mapped = arr.filter(keepWire).map(wireToItem);
        setItems(mapped);
        titleFromItems(mapped, sid);
      }
    } catch {
      /* ignore */
    }
  }

  const folderName = workspace ? workspace.split("/").filter(Boolean).pop() || workspace : "Folder";

  async function newSession(): Promise<string | null> {
    setError(null);
    try {
      const body: any = { approvalMode, modelId: model || DEFAULT_MODEL };
      if (workspace) body.workspaceRoot = workspace;
      const providerId = localStorage.getItem("openmuse.provider") || "";
      const fixedSid = localStorage.getItem("openmuse.sessionId") || "";
      if (providerId) body.providerId = providerId;
      if (fixedSid) body.sessionId = fixedSid;
      const r = await api("/api/session/start", { method: "POST", body: JSON.stringify(body) });
      const s = r.session;
      setSessions((xs) => upsertSessionList(xs, s));
      setSessionId(s.sessionId);
      resetView();
      return s.sessionId;
    } catch (e: any) {
      setError(e.message);
      return null;
    }
  }

  async function openSession(s: Session) {
    setError(null);
    try {
      const r = await api("/api/session/resume", { method: "POST", body: JSON.stringify({ sessionId: s.sessionId }) });
      setSessionId(s.sessionId);
      resetView();
      setSessions((xs) => upsertSessionList(xs, s));
      applyHistory(r, s.sessionId);
      await loadTranscript(s.sessionId);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function send(preset?: string) {
    const raw = (preset ?? input).trim();
    const ready = attachments.filter((a) => a.ready && !a.error);
    if ((!raw && ready.length === 0) || busy) return;
    setError(null);
    let sid = sessionId;
    if (!sid) {
      sid = await newSession();
      if (!sid) return;
    }
    let text = raw;
    for (const a of ready) {
      if (a.kind === "text") text += `\n\n[Attached file: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\``;
    }
    const images = ready
      .filter((a) => a.kind === "image" && a.dataUrl)
      .map((a) => ({
        mediaType: a.mime,
        base64Data: String(a.dataUrl).split(",", 2)[1],
        ...(a.width && a.height ? { width: a.width, height: a.height } : {}),
      }));
    setInput("");
    setAttachments([]);
    const echoText = raw || (images.length ? `[${images.length} image${images.length === 1 ? "" : "s"} attached]` : "");
    if (!titles[sid] && echoText) {
      const t = cleanTitle(echoText);
      if (t) setTitles((ts) => ({ ...ts, [sid as string]: t }));
    }
    const echoId = `local-${Date.now()}`;
    setItems((xs) => [...xs, { itemId: echoId, kind: "userMessage", text: echoText, status: "completed", done: true }]);
    try {
      const body: any = { sessionId: sid, text, images };
      if (effort) body.reasoningEffort = effort;
      await api("/api/turn", { method: "POST", body: JSON.stringify(body) });
      setBusy(true);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function stop() {
    if (!sessionId) return;
    try {
      await turnCancel(sessionId);
    } catch {
      try {
        await api("/api/interrupt", { method: "POST", body: JSON.stringify({ sessionId }) });
      } catch (e: any) {
        setError(e.message);
      }
    }
  }

  async function exportChat() {
    if (!sessionId) return;
    setError(null);
    try {
      const r = await exportSession(sessionId);
      const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `openmuse-${sessionId.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.message);
    }
  }

  const decideFlight = useRef(new Set<string>());
  async function decide(a: Approval, choiceId: string, feedback?: string) {
    if (decideFlight.current.has(a.approvalId)) return;
    decideFlight.current.add(a.approvalId);
    setError(null);
    try {
      await api("/api/approval/decide", {
        method: "POST",
        body: JSON.stringify({
          sessionId: a.sessionId,
          approvalId: a.approvalId,
          choiceId,
          requirementId: a.currentRequirementId,
          ...(feedback ? { feedback } : {}),
        }),
      });
      setApprovals((xs) => xs.map((x) => (x.approvalId === a.approvalId ? { ...x, settled: true } : x)));
    } catch (e: any) {
      setError(e.message);
      throw e;
    } finally {
      decideFlight.current.delete(a.approvalId);
    }
  }

  async function answerPrompt(q: InputPrompt, answers: any[]) {
    setError(null);
    try {
      await api("/api/input/answer", {
        method: "POST",
        body: JSON.stringify({ sessionId: q.sessionId, userInputId: q.userInputId, answers }),
      });
      setPrompts((xs) => xs.map((x) => (x.userInputId === q.userInputId ? { ...x, settled: true } : x)));
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function cancelPrompt(q: InputPrompt) {
    try {
      await api("/api/input/cancel", {
        method: "POST",
        body: JSON.stringify({ sessionId: q.sessionId, userInputId: q.userInputId }),
      });
    } catch (e: any) {
      setError(e.message);
    }
    setPrompts((xs) => xs.map((x) => (x.userInputId === q.userInputId ? { ...x, settled: true } : x)));
  }

  async function changeModel(modelId: string) {
    setModel(modelId);
    if (!sessionId || !modelId) return;
    try {
      await api("/api/session/model", { method: "POST", body: JSON.stringify({ sessionId, modelId }) });
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function changeApprovalMode(mode: string) {
    setApprovalMode(mode);
    if (!sessionId) return;
    try {
      await api("/api/session/approval-mode", { method: "POST", body: JSON.stringify({ sessionId, mode }) });
    } catch (e: any) {
      setError(e.message);
    }
  }

  const liveApprovals = approvals.filter((a) => !a.settled);
  const livePrompts = prompts.filter((q) => !q.settled);
  const ctxPct = ctx ? Math.min(100, Math.round((ctx.used / ctx.window) * 100)) : 0;
  const blocks = useMemo(() => groupThread(items), [items]);

  const needle = transcriptFilter.trim().toLowerCase();
  const visibleBlocks = useMemo(() => {
    if (!needle) return blocks;
    return blocks.filter((b) => {
      if (b.type === "thinking") {
        return b.entries.some((e) => `${e.kind} ${e.tool || ""} ${e.text || ""}`.toLowerCase().includes(needle));
      }
      return (b.item.text || "").toLowerCase().includes(needle);
    });
  }, [blocks, needle]);

  async function retryLast() {
    if (busy || !sessionId) return;
    const last = [...itemsRef.current].reverse().find((w) => w.kind === "userMessage" && w.text.trim());
    if (!last) {
      setError("Nothing to retry yet");
      return;
    }
    setError(null);
    try {
      const body: any = { sessionId, text: last.text };
      if (effort) body.reasoningEffort = effort;
      await api("/api/turn", { method: "POST", body: JSON.stringify(body) });
      setBusy(true);
    } catch (e: any) {
      setError(e.message);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const inField = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
      if (e.key === "Escape") {
        if (document.activeElement && document.activeElement.id === "transcript-search") {
          setTranscriptFilter("");
          (document.activeElement as HTMLElement).blur();
        }
        setGitOpen(false);
        setMenuOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.getElementById("composer-input")?.focus();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setTab("chat");
        newSession();
        return;
      }
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/" && sessionId) {
        e.preventDefault();
        document.getElementById("transcript-search")?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessionId]);

  const sessionGroups = useMemo(() => {
    const filtered = sortSessions(sessions).filter((s) =>
      titleFor(s).toLowerCase().includes(chatFilter.toLowerCase()),
    );
    return groupSessionsByDate(filtered);
  }, [sessions, titles, chatFilter]);

  const activeSessionObj = sessions.find((s) => s.sessionId === sessionId);

  return (
    <div className="app-shell">
      {/* ----------------- Left Sidebar ----------------- */}
      <aside className="app-sidebar">
        <div className="sidebar-header-drag">
          <div className="app-brand">
            <div className="brand-prism-wrap" aria-hidden>
              <MusePrism3D size={28} interactive={false} />
            </div>
            <span className="brand-name">OpenMuse</span>
            <span className="brand-version-tag">v0.1</span>
          </div>
        </div>

        <div className="sidebar-actions-area">
          <button
            type="button"
            className="btn-new-chat"
            onClick={() => {
              setTab("chat");
              newSession();
            }}
          >
            <div className="btn-new-chat-left">
              <PlusIcon size={16} />
              <span>New chat</span>
            </div>
            <span className="btn-new-chat-shortcut">⌘N</span>
          </button>

          <div className="sidebar-search-box">
            <SearchIcon size={14} className="sidebar-search-icon" />
            <input
              className="sidebar-search-input"
              value={chatFilter}
              onChange={(e) => setChatFilter(e.target.value)}
              placeholder="Search chats..."
            />
          </div>
        </div>

        {/* Temporal Session List */}
        <div className="sidebar-sessions-scroll">
          {sessionGroups.map((group) => (
            <div key={group.label} className="session-group">
              <span className="session-group-label">{group.label}</span>
              {group.sessions.map((s) => (
                <button
                  key={s.sessionId}
                  type="button"
                  className={`session-row-item ${s.sessionId === sessionId && tab === "chat" ? "active" : ""}`}
                  onClick={() => {
                    setTab("chat");
                    openSession(s);
                  }}
                  title={s.sessionId}
                >
                  <div className="session-row-info">
                    <span className="session-row-title">{titleFor(s)}</span>
                    {metaFor(s) && <span className="session-row-meta">{metaFor(s)}</span>}
                  </div>
                </button>
              ))}
            </div>
          ))}

          {sessions.length === 0 && (
            <p className="session-empty-hint">No chats yet. Start a new conversation.</p>
          )}
        </div>

        {/* Sidebar Footer */}
        <div className="sidebar-footer">
          {usage && (
            <div className="sidebar-usage-pill">
              <span>Tokens: {usage.inTok.toLocaleString()} in</span>
              <span>{usage.outTok.toLocaleString()} out</span>
            </div>
          )}

          <div className="popover-anchor">
            <button
              type="button"
              className="sidebar-profile-btn"
              onClick={() => setMenuOpen((v) => !v)}
            >
              <div className="profile-avatar-circle">
                <UserIcon size={16} />
              </div>
              <div className="profile-text-meta">
                <span className="profile-user-name">Muse Agent</span>
                <span className="profile-active-model">{model}</span>
              </div>
            </button>

            {menuOpen && (
              <>
                <div className="modal-backdrop-transparent" onClick={() => setMenuOpen(false)} />
                <div className="profile-menu-popover">
                  <button
                    type="button"
                    className="menu-item-btn"
                    onClick={() => {
                      setTab("account");
                      setMenuOpen(false);
                    }}
                  >
                    <UserIcon size={14} />
                    <span>Account Profile</span>
                  </button>
                  <button
                    type="button"
                    className="menu-item-btn"
                    onClick={() => {
                      setTab("settings");
                      setMenuOpen(false);
                    }}
                  >
                    <SettingsIcon size={14} />
                    <span>Preferences</span>
                  </button>
                  {sessionId && (
                    <button
                      type="button"
                      className="menu-item-btn"
                      onClick={() => {
                        exportChat();
                        setMenuOpen(false);
                      }}
                    >
                      <DownloadIcon size={14} />
                      <span>Export Chat JSON</span>
                    </button>
                  )}
                  <div className="menu-divider-line" />
                  <button
                    type="button"
                    className="menu-item-btn danger"
                    onClick={async () => {
                      setError(null);
                      try {
                        await ops.authLogout();
                      } catch (e: any) {
                        setError(e.message);
                      }
                      setMenuOpen(false);
                    }}
                  >
                    <span>Log Out</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </aside>

      {/* ----------------- Main Work Area ----------------- */}
      <div className="app-main-pane">
        <div className="main-content-flow">
          {/* Top Bar Header */}
          <header className="topbar-container">
            <div className="topbar-left">
              <span className={`connection-status-pill ${status.connected ? "connected" : ""}`}>
                <span className="status-dot" aria-hidden />
                <span>{status.mock ? "demo host" : status.connected ? "muse connected" : "muse unreachable"}</span>
              </span>

              {tab === "chat" && activeSessionObj && (
                <div className="topbar-title-meta">
                  <span>{titleFor(activeSessionObj)}</span>
                </div>
              )}
            </div>

            <div className="topbar-right">
              {/* Git Status Widget */}
              <div className="popover-anchor">
                <button
                  type="button"
                  className={`topbar-btn ${gitOpen ? "active" : ""} ${git && git.repo && gitChanges > 0 ? "git-dirty" : ""}`}
                  onClick={() => {
                    setGitOpen((v) => !v);
                    if (!gitOpen) refreshGit();
                  }}
                  title={git?.repo ? `${gitChanges} uncommitted changes on ${git.branch || "?"}` : "Git operations"}
                >
                  <GitBranchIcon size={14} />
                  <span>{git?.repo ? `${git.branch || "HEAD"}${gitChanges > 0 ? ` (${gitChanges})` : ""}` : "Git"}</span>
                </button>

                {gitOpen && (
                  <>
                    <div className="modal-backdrop-transparent" onClick={() => setGitOpen(false)} />
                    <GitMenu
                      status={git}
                      loading={gitLoading}
                      workspace={workspace}
                      onRefresh={refreshGit}
                      onCommit={gitCommit}
                      onPush={gitPush}
                      onPr={gitCreatePr}
                      busyAction={gitAction}
                      note={gitNote}
                    />
                  </>
                )}
              </div>

              {/* Chat Session Operations */}
              {tab === "chat" && sessionId && (
                <>
                  <button
                    type="button"
                    className="topbar-btn"
                    onClick={retryLast}
                    disabled={busy || !sessionId}
                    title="Retry last user prompt"
                  >
                    <RefreshCwIcon size={12} />
                    <span>Retry</span>
                  </button>

                  <button
                    type="button"
                    className="topbar-btn"
                    onClick={async () => {
                      if (!sessionId) return;
                      setError(null);
                      try {
                        const r = await ops.fork(sessionId);
                        const f = r.session;
                        if (f) setSessions((xs) => upsertSessionList(xs, f));
                      } catch (e: any) {
                        setError(e.message);
                      }
                    }}
                    title="Fork conversation to explore an alternative branch"
                  >
                    <GitForkIcon size={13} />
                    <span>Fork</span>
                  </button>

                  <button
                    type="button"
                    className="topbar-btn"
                    onClick={async () => {
                      if (!sessionId) return;
                      setError(null);
                      try {
                        await ops.compact(sessionId);
                      } catch (e: any) {
                        setError(e.message);
                      }
                    }}
                    title="Compact conversation history to conserve token context"
                  >
                    <Minimize2Icon size={13} />
                    <span>Compact</span>
                  </button>

                  <button
                    type="button"
                    className="topbar-btn"
                    onClick={exportChat}
                    title="Export session data as JSON"
                  >
                    <DownloadIcon size={13} />
                    <span>Export</span>
                  </button>
                </>
              )}

              {/* In-app Browser Inspector Toggle */}
              <button
                type="button"
                className={`topbar-btn ${browserOpen ? "active" : ""}`}
                onClick={() => setBrowserOpen((v) => !v)}
                title="Toggle Web Preview Pane"
              >
                <GlobeIcon size={14} />
                <span>{browserOpen ? "Hide Browser" : "Browser"}</span>
              </button>
            </div>

            {/* Context Token Usage Strip */}
            {ctx && (
              <div className="context-meter-strip" title={`${ctx.used} / ${ctx.window} tokens used`}>
                <div className="context-meter-fill" style={{ width: `${ctxPct}%` }} />
              </div>
            )}
          </header>

          {/* ----------------- Active View Content ----------------- */}
          {tab === "settings" ? (
            <SettingsView onClose={() => setTab("chat")} />
          ) : tab === "account" ? (
            <AccountView
              model={model}
              effort={effort}
              approvalMode={approvalMode}
              workspace={workspace}
              onClose={() => setTab("chat")}
            />
          ) : !sessionId ? (
            /* Hero / Empty State Screen */
            <div className="hero-empty-container">
              <div className="hero-prism-container" aria-hidden>
                <MusePrism3D size={160} interactive={true} />
              </div>
              <h1 className="hero-heading">{daypart}</h1>
              <p className="hero-subheading">
                How can Muse help you engineer software today? Ask architectural questions, write code, or review diffs.
              </p>

              <div className="hero-starter-grid">
                <div
                  className="hero-starter-card"
                  onClick={() => send("Explain this codebase to me: what does it do and where should I start?")}
                >
                  <div className="card-icon-pill">
                    <CodeIcon size={16} />
                  </div>
                  <span className="starter-card-title">Explore Codebase</span>
                  <span className="starter-card-desc">Map architecture and trace entrypoints.</span>
                </div>

                <div
                  className="hero-starter-card"
                  onClick={() => send("Write a small clean utility script that demonstrates this project's core functionality.")}
                >
                  <div className="card-icon-pill">
                    <SparklesIcon size={16} />
                  </div>
                  <span className="starter-card-title">Prototype a Script</span>
                  <span className="starter-card-desc">From concept to executed code in one turn.</span>
                </div>

                <div
                  className="hero-starter-card"
                  onClick={() => send("Review my latest git changes and suggest architectural improvements or bug fixes.")}
                >
                  <div className="card-icon-pill">
                    <GitBranchIcon size={16} />
                  </div>
                  <span className="starter-card-title">Review Git Diff</span>
                  <span className="starter-card-desc">Thorough code review and verification.</span>
                </div>
              </div>

              {status.lastError && <div className="modal-error-alert">{status.lastError}</div>}
              {error && <div className="modal-error-alert">{error}</div>}

              <div className="hero-composer-dock">
                <Composer
                  input={input}
                  setInput={setInput}
                  busy={false}
                  models={models}
                  model={model}
                  onModel={setModel}
                  effort={effort}
                  onEffort={chooseEffort}
                  approvalMode={approvalMode}
                  onApproval={setApprovalMode}
                  folderName={folderName}
                  folderPath={workspace}
                  onPickFolder={() => setPicking(true)}
                  onSend={() => send()}
                  onStop={stop}
                  attachments={attachments}
                  onAddFiles={addFiles}
                  onRemoveAttachment={removeAttachment}
                />
              </div>

              {picking && (
                <WorkspacePicker initial={workspace} onPick={chooseWorkspace} onClose={() => setPicking(false)} />
              )}
            </div>
          ) : (
            /* Conversation Thread Screen */
            <>
              <div
                ref={threadRef}
                className="conversation-thread-scroll"
                aria-live="polite"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
                }}
              >
                {/* Transcript Filter Search Bar */}
                <div className="transcript-filter-bar">
                  <SearchIcon size={13} className="sidebar-search-icon" />
                  <input
                    id="transcript-search"
                    className="transcript-filter-input"
                    value={transcriptFilter}
                    onChange={(e) => setTranscriptFilter(e.target.value)}
                    placeholder="Filter messages and tool calls in this session... ( / to focus )"
                  />
                  {needle && (
                    <>
                      <span className="filter-match-count">
                        {visibleBlocks.length} of {blocks.length} shown
                      </span>
                      <button
                        type="button"
                        className="filter-clear-btn"
                        onClick={() => setTranscriptFilter("")}
                      >
                        Clear
                      </button>
                    </>
                  )}
                </div>

                {visibleBlocks.map((b) =>
                  b.type === "thinking" ? (
                    <ThinkingBlock key={b.key} entries={b.entries} streamingId={streaming} />
                  ) : (
                    <div
                      key={b.item.itemId}
                      className={`chat-message-row ${b.type === "user" ? "user-message" : "agent-message"}`}
                    >
                      <div className="message-author-header">
                        {b.type === "agent" && (
                          <div className="agent-avatar-small" aria-hidden>
                            <MusePrism3D size={18} interactive={false} />
                          </div>
                        )}
                        <span className="message-author-label">{b.type === "user" ? "You" : "Muse"}</span>
                        <div className="spacer" />
                        <MessageActions
                          text={b.item.text || ""}
                          isUser={b.type === "user"}
                          onFork={() => {
                            setInput(b.item.text || "");
                          }}
                          onRetry={
                            b.type === "agent"
                              ? () => {
                                  const lastUser = [...visibleBlocks].reverse().find((x) => x.type === "user");
                                  if (lastUser && "item" in lastUser && lastUser.item.text) {
                                    send(lastUser.item.text);
                                  }
                                }
                              : undefined
                          }
                        />
                      </div>

                      {b.type === "user" ? (
                        <div className="user-bubble-box">
                          {b.item.text}
                        </div>
                      ) : (
                        <div className="agent-response-box">
                          <Markdown text={b.item.text || (b.item.done ? "" : "...")} />
                        </div>
                      )}
                    </div>
                  ),
                )}

                {/* Live Tool Approvals */}
                {liveApprovals.map((a) => (
                  <ApprovalCard key={a.approvalId} a={a} onDecide={decide} />
                ))}

                {/* Live Questions */}
                {livePrompts.map((q) => (
                  <QuestionCard
                    key={q.userInputId}
                    q={q}
                    onAnswer={(ans) => answerPrompt(q, ans)}
                    onCancel={() => cancelPrompt(q)}
                  />
                ))}

                {/* Thinking Dots Indicator */}
                {busy && !streaming && liveApprovals.length === 0 && livePrompts.length === 0 && (
                  <div className="agent-thinking-dots" aria-label="Muse is thinking">
                    <span />
                    <span />
                    <span />
                  </div>
                )}

                <div ref={bottomRef} />
              </div>

              {error && <div className="modal-error-alert">{error}</div>}

              {/* Bottom Floating Composer */}
              <div className="composer-dock-container">
                <Composer
                  input={input}
                  setInput={setInput}
                  busy={busy}
                  models={models}
                  model={model}
                  onModel={changeModel}
                  effort={effort}
                  onEffort={chooseEffort}
                  approvalMode={approvalMode}
                  onApproval={changeApprovalMode}
                  folderName={folderName}
                  folderPath={workspace}
                  onPickFolder={() => setPicking(true)}
                  onSend={() => send()}
                  onStop={stop}
                  attachments={attachments}
                  onAddFiles={addFiles}
                  onRemoveAttachment={removeAttachment}
                />
              </div>

              {picking && (
                <WorkspacePicker initial={workspace} onPick={chooseWorkspace} onClose={() => setPicking(false)} />
              )}
            </>
          )}
        </div>

        {/* ----------------- In-App Browser Panel ----------------- */}
        {browserOpen && (
          <div className="browser-pane-wrapper">
            <BrowserPanel onAttach={attachScreenshot} onClose={() => setBrowserOpen(false)} />
          </div>
        )}
      </div>
    </div>
  );
}
