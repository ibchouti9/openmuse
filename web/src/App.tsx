import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { api, exportSession, subscribe, turnCancel } from "./api";

interface Item {
  itemId: string;
  kind: string;
  text: string;
  status: string;
  tool?: string;
  args?: string;
  visibleOutput?: string;
  done: boolean;
}

interface Choice {
  choiceId: string;
  label: string;
  decision: string;
  scope: string;
  acceptsFeedback?: boolean;
  rulePreview?: string;
}

interface Approval {
  approvalId: string;
  sessionId: string;
  toolName: string;
  subject: any;
  rawArgs?: string;
  availableChoices: Choice[];
  currentRequirementId: unknown;
  settled?: boolean;
}

interface Question {
  id: string;
  header: string;
  question: string;
  selection: { mode: string; minSelections?: number; maxSelections?: number };
  options: { label: string; description?: string }[];
}

interface InputPrompt {
  userInputId: string;
  sessionId: string;
  toolName: string;
  questions: Question[];
  settled?: boolean;
}

interface Session {
  sessionId: string;
  title?: string;
  updatedAt?: string;
}

interface Todo {
  text: string;
  status: string;
  activeForm?: string;
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
    done: it.status === "completed",
  };
}

function renderSubject(subject: any): string {
  if (subject == null) return "";
  if (typeof subject === "string") return subject;
  if (subject.kind === "shell") {
    const stage = subject.stages && subject.stages[0];
    const argv = stage && stage.argv ? stage.argv.join(" ") : subject.command;
    return `$ ${argv || subject.command || ""}`;
  }
  try {
    return JSON.stringify(subject, null, 2);
  } catch {
    return String(subject);
  }
}

function parseArgs(args?: string): string {
  if (!args) return "";
  try {
    const o = JSON.parse(args);
    return o.command || o.description || args;
  } catch {
    return args;
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

marked.use({
  renderer: {
    code({ text, lang }: any) {
      return (
        `<div class="codeblock"><div class="codehead"><span>${escHtml(lang || "code")}</span>` +
        `<button data-code="${encodeURIComponent(text)}">Copy</button></div>` +
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
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    });
  }
  return <div className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

function ApprovalCard({ a, onDecide }: { a: Approval; onDecide: (a: Approval, choiceId: string, feedback?: string) => void }) {
  const [feedback, setFeedback] = useState("");
  const canFeedback = a.availableChoices.some((c) => c.acceptsFeedback);
  return (
    <div className="approval">
      <div className="who">Needs approval · {a.toolName}</div>
      <pre className="body">{renderSubject(a.subject)}</pre>
      {a.availableChoices.map((c) => c.rulePreview).filter(Boolean)[0] && (
        <p className="rule">{a.availableChoices.map((c) => c.rulePreview).filter(Boolean)[0]}</p>
      )}
      <div className="row">
        {a.availableChoices.map((c) => (
          <button key={c.choiceId} className="choice" onClick={() => onDecide(a, c.choiceId, c.acceptsFeedback ? feedback || undefined : undefined)}>
            {c.label || c.choiceId}
          </button>
        ))}
        {a.availableChoices.length === 0 && <span className="hint">waiting on host…</span>}
      </div>
      {canFeedback && (
        <input
          className="feedback"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Feedback to the model (sent with Reject)"
        />
      )}
    </div>
  );
}

function QuestionCard({ q, onAnswer, onCancel }: { q: InputPrompt; onAnswer: (answers: any[]) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState<Record<string, string>>({});

  function toggle(qid: string, label: string, multi: boolean) {
    setPicked((p) => {
      const cur = p[qid] || [];
      if (multi) return { ...p, [qid]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      return { ...p, [qid]: [label] };
    });
  }

  function submit() {
    const answers = q.questions.map((qq) => {
      const sel = picked[qq.id] || [];
      const ft = (free[qq.id] || "").trim();
      if (ft) return { questionId: qq.id, freeText: ft.slice(0, 500) };
      if (qq.selection.mode === "multiple") return { questionId: qq.id, selectedLabels: sel };
      return { questionId: qq.id, selectedLabel: sel[0] || (qq.options[0] && qq.options[0].label) };
    });
    onAnswer(answers);
  }

  return (
    <div className="question">
      <div className="who">Question · {q.toolName}</div>
      {q.questions.map((qq) => (
        <div key={qq.id} className="qblock">
          <p className="qtext">
            <strong>{qq.header}:</strong> {qq.question}
          </p>
          <div className="row">
            {qq.options.map((o) => {
              const multi = qq.selection.mode === "multiple";
              const on = (picked[qq.id] || []).includes(o.label);
              return (
                <button key={o.label} className={on ? "choice on" : "choice"} onClick={() => toggle(qq.id, o.label, multi)} title={o.description}>
                  {o.label}
                </button>
              );
            })}
          </div>
          <input
            className="feedback"
            value={free[qq.id] || ""}
            onChange={(e) => setFree((f) => ({ ...f, [qq.id]: e.target.value }))}
            placeholder="Or type an answer instead"
          />
        </div>
      ))}
      <div className="row">
        <button className="primary" onClick={submit}>
          Answer
        </button>
        <button className="ghost" onClick={onCancel}>
          Skip
        </button>
      </div>
    </div>
  );
}

function Composer({
  input,
  setInput,
  busy,
  models,
  model,
  onModel,
  effort,
  onEffort,
  approvalMode,
  onApproval,
  folderName,
  folderPath,
  onPickFolder,
  onSend,
  onStop,
}: {
  input: string;
  setInput: (s: string) => void;
  busy: boolean;
  models: string[];
  model: string;
  onModel: (m: string) => void;
  effort: string;
  onEffort: (e: string) => void;
  approvalMode: string;
  onApproval: (m: string) => void;
  folderName: string;
  folderPath: string;
  onPickFolder: () => void;
  onSend: () => void;
  onStop: () => void;
}) {
  return (
    <div className="composer-inner">
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder="How can Muse help you today?"
        rows={2}
      />
      <div className="bar">
        <button className="pill" onClick={onPickFolder} title={folderPath || "Server default folder"}>
          {folderName}
        </button>
        <select className="pill select" value={model} onChange={(e) => onModel(e.target.value)} title="Model">
          <option value="">Auto</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select className="pill select" value={effort} onChange={(e) => onEffort(e.target.value)} title="Reasoning effort">
          <option value="">Effort: auto</option>
          <option value="none">Effort: none</option>
          <option value="minimal">Effort: minimal</option>
          <option value="low">Effort: low</option>
          <option value="medium">Effort: medium</option>
          <option value="high">Effort: high</option>
          <option value="xhigh">Effort: xhigh</option>
          <option value="ultra">Effort: ultra</option>
        </select>
        <select className="pill select" value={approvalMode} onChange={(e) => onApproval(e.target.value)} title="Approval enforcement">
          <option value="onRequest">Ask</option>
          <option value="promptUnmatched">Ask new</option>
          <option value="allowAll">Auto-accept</option>
          <option value="denyUnmatched">Deny new</option>
        </select>
        <span className="spacer" />
        {busy ? (
          <button className="danger" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="send" onClick={onSend} disabled={!input.trim()} aria-label="Send">
            ↑
          </button>
        )}
      </div>
    </div>
  );
}

function WorkspacePicker({ initial, onPick, onClose }: { initial: string; onPick: (p: string) => void; onClose: () => void }) {
  const [path, setPath] = useState(initial);
  const [entries, setEntries] = useState<{ name: string; path: string }[]>([]);
  const [filter, setFilter] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (p: string) => {
    setErr(null);
    try {
      const r = await api(`/api/dirs?path=${encodeURIComponent(p || "~")}`);
      setPath(r.path);
      setEntries(r.entries);
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => {
    load(initial || "~");
  }, [load, initial]);

  const crumbs = path.split("/").filter(Boolean);
  const shown = filter ? entries.filter((d) => d.name.toLowerCase().includes(filter.toLowerCase())) : entries;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-h">Choose working folder</div>
        <p className="hint">New chats run here. The model reads and edits files under this folder.</p>
        <div className="crumbs">
          <button className={crumbs.length === 0 ? "on" : ""} onClick={() => load("/")}>
            /
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="crumb">
              <span className="sep">›</span>
              <button
                className={i === crumbs.length - 1 ? "on" : ""}
                onClick={() => load("/" + crumbs.slice(0, i + 1).join("/"))}
              >
                {c}
              </button>
            </span>
          ))}
        </div>
        <input
          className="feedback filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter folders…"
        />
        {err && <p className="err">{err}</p>}
        <div className="dirlist">
          {shown.map((d) => (
            <button key={d.path} className="dir" onClick={() => load(d.path)} title={d.path}>
              <span className="dname">{d.name}</span>
            </button>
          ))}
          {shown.length === 0 && !err && <p className="hint">No subfolders.</p>}
        </div>
        <div className="row picker-foot">
          <span className="curpath" title={path}>
            {path || "…"}
          </span>
          <span className="spacer" />
          <button className="primary" onClick={() => onPick(path)}>
            Use this folder
          </button>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const RENDERABLE = new Set(["userMessage", "agentMessage", "toolCall"]);

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
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
  const [model, setModel] = useState("");
  const [approvalMode, setApprovalMode] = useState("onRequest");
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [workspace, setWorkspace] = useState(() => localStorage.getItem("openmuse.workspace") || "");
  const [picking, setPicking] = useState(false);
  const [effort, setEffort] = useState(() => localStorage.getItem("openmuse.effort") || "");

  function chooseEffort(e: string) {
    setEffort(e);
    localStorage.setItem("openmuse.effort", e);
  }

  function chooseWorkspace(p: string) {
    setWorkspace(p);
    localStorage.setItem("openmuse.workspace", p);
    setPicking(false);
  }

  function cleanTitle(t: string): string {
    return t
      .replace(/[*_`#~>|[\]()]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 44);
  }

  function titleFor(s: Session): string {
    return titles[s.sessionId] || s.title || `${s.sessionId.slice(0, 4)}…${s.sessionId.slice(-4)}`;
  }

  function titleFromItems(arr: Item[], sid: string) {
    const first = arr.find((w) => w.kind === "userMessage" && w.text.trim());
    if (first) {
      const t = cleanTitle(first.text);
      if (t) setTitles((ts) => (ts[sid] ? ts : { ...ts, [sid]: t }));
    }
  }
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items, approvals, prompts]);

  const upsertItem = useCallback((wire: any) => {
    if (!wire || !wire.itemId || !RENDERABLE.has(wire.kind)) return;
    const it = wireToItem(wire);
    setItems((xs) => {
      const i = xs.findIndex((x) => x.itemId === it.itemId);
      if (i >= 0) {
        const next = xs.slice();
        next[i] = { ...it, text: it.text || next[i].text };
        return next;
      }
      // Host echo of our optimistic message: adopt it instead of doubling.
      if (it.kind === "userMessage") {
        const j = xs.findIndex((x) => x.itemId.startsWith("local-") && x.text === it.text);
        if (j >= 0) {
          const next = xs.slice();
          next[j] = it;
          return next;
        }
      }
      return [...xs, it];
    });
  }, []);

  const onEvent = useCallback(
    (method: string, p: any) => {
      if (p.sessionId && sessionId && p.sessionId !== sessionId) return;
      switch (method) {
        case "item/started":
        case "item/updated":
          upsertItem(p.item);
          setBusy(true);
          break;
        case "item/delta":
          if (!p.itemId) break;
          setStreaming(p.itemId);
          setItems((xs) => xs.map((it) => (it.itemId === p.itemId ? { ...it, text: it.text + (p.delta || "") } : it)));
          break;
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
          if (p.modelId) setModel((m) => m || p.modelId);
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

  // One shared EventSource for the app lifetime: tearing it down on every
  // session switch dropped events (and briefly double-delivered them).
  // Filtering uses the latest handler via ref.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  useEffect(() => subscribe((method: string, params: any) => onEventRef.current(method, params), setStatus), []);

  useEffect(() => {
    api("/api/health")
      .then((h) => setStatus(h.host))
      .catch((e) => setError(e.message));
    api("/api/sessions")
      .then((r) => setSessions(r.sessions || r || []))
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
  }

  function applyHistory(r: any, sid: string) {
    const hist = r.history || {};
    const arr = hist.items || [];
    if (arr.length > 0) {
      const mapped = arr.filter((w: any) => w && RENDERABLE.has(w.kind)).map(wireToItem);
      setItems(mapped);
      titleFromItems(mapped, sid);
    }
  }

  async function loadTranscript(sid: string) {
    try {
      const r = await api(`/api/transcript?sessionId=${encodeURIComponent(sid)}`);
      const arr = r.items || [];
      if (arr.length > 0) {
        const mapped = arr.filter((w: any) => w && RENDERABLE.has(w.kind)).map(wireToItem);
        setItems(mapped);
        titleFromItems(mapped, sid);
      }
    } catch {
      /* resume history (if any) still stands */
    }
  }

  const folderName = workspace ? workspace.split("/").filter(Boolean).pop() || workspace : "Folder";

  async function newSession(): Promise<string | null> {
    setError(null);
    try {
      const body: any = { approvalMode };
      if (model) body.modelId = model;
      if (workspace) body.workspaceRoot = workspace;
      const r = await api("/api/session/start", { method: "POST", body: JSON.stringify(body) });
      const s = r.session;
      setSessions((xs) => [{ sessionId: s.sessionId, title: s.title, updatedAt: s.updatedAt }, ...xs]);
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
      applyHistory(r, s.sessionId);
      await loadTranscript(s.sessionId);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function send(preset?: string) {
    const text = (preset ?? input).trim();
    if (!text || busy) return;
    setError(null);
    let sid = sessionId;
    if (!sid) {
      sid = await newSession();
      if (!sid) return;
    }
    setInput("");
    if (!titles[sid]) {
      const t = cleanTitle(text);
      if (t) setTitles((ts) => ({ ...ts, [sid as string]: t }));
    }
    // Optimistic echo so the message appears instantly; replaced by the
    // host's own userMessage record when it arrives (same text).
    const echoId = `local-${Date.now()}`;
    setItems((xs) => [...xs, { itemId: echoId, kind: "userMessage", text, status: "completed", done: true }]);
    try {
      const body: any = { sessionId: sid, text };
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

  async function decide(a: Approval, choiceId: string, feedback?: string) {
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

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="mark" aria-hidden>
            M
          </span>
          OpenMuse
        </div>
        <button className="primary" onClick={() => newSession()}>
          + New chat
        </button>
        <div className="conn" data-ok={status.connected}>
          {status.mock ? "demo host" : status.connected ? "muse connected" : "muse unreachable"}
        </div>
        <nav className="sess">
          <div className="sess-h">Chats</div>
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              className={s.sessionId === sessionId ? "active" : ""}
              onClick={() => openSession(s)}
              title={s.sessionId}
            >
              {titleFor(s)}
            </button>
          ))}
          {sessions.length === 0 && <p className="hint">No chats yet — start one.</p>}
        </nav>
        {sessionId && (
          <button className="ghost" onClick={exportChat}>
            Export chat
          </button>
        )}
        {todos.length > 0 && (
          <div className="todos">
            <div className="todos-h">Tasks</div>
            {todos.map((t, i) => (
              <div key={i} className="todo" data-st={t.status}>
                <span className="box" aria-hidden />
                {t.text}
              </div>
            ))}
          </div>
        )}
        {usage && (
          <div className="usage">
            {usage.inTok} in · {usage.outTok} out{usage.model ? ` · ${usage.model}` : ""}
          </div>
        )}
      </aside>
      <main className="main">
        {!sessionId ? (
          <div className="empty">
            <h1>What should we build?</h1>
            <p>OpenMuse drives your local Muse Code install.</p>
            <div className="chips">
              <button onClick={() => send("Explain this codebase to me: what does it do and where do I start?")}>
                <span className="cdot" aria-hidden />
                <span className="ctitle">Explain a codebase</span>
                <span className="csub">Map the architecture and find where to start.</span>
              </button>
              <button onClick={() => send("Write a small script that fetches a random joke and prints it.")}>
                <span className="cdot" aria-hidden />
                <span className="ctitle">Write a script</span>
                <span className="csub">From idea to running code in one turn.</span>
              </button>
              <button onClick={() => send("Review my latest changes and suggest improvements.")}>
                <span className="cdot" aria-hidden />
                <span className="ctitle">Review changes</span>
                <span className="csub">A second pair of eyes on your diff.</span>
              </button>
            </div>
            {status.lastError && <p className="err">{status.lastError}</p>}
            {error && <p className="err">{error}</p>}
            <div className="composer">
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
              />
            </div>
            {picking && <WorkspacePicker initial={workspace} onPick={chooseWorkspace} onClose={() => setPicking(false)} />}
          </div>
        ) : (
          <>
            {ctx && (
              <div className="ctxbar" title={`${ctx.used} / ${ctx.window} tokens`}>
                <div className="ctxfill" style={{ width: `${ctxPct}%` }} />
              </div>
            )}
            <div className="thread" aria-live="polite">
              {items.map((it) =>
                it.kind === "toolCall" ? (
                  <div
                    key={it.itemId}
                    className={`tool${streaming === it.itemId ? " streaming" : ""}${it.done ? " done" : ""}`}
                  >
                    <span className="tic" aria-hidden>
                      {it.done ? "✓" : ""}
                    </span>
                    <div className="tbody">
                      <div>
                        {it.tool || "tool"} · {parseArgs(it.args)}
                      </div>
                      {it.visibleOutput && <pre className="tbody out">{it.visibleOutput}</pre>}
                    </div>
                  </div>
                ) : (
                  <div key={it.itemId} className={`msg ${it.kind === "userMessage" ? "user" : "agent"}${streaming === it.itemId ? " streaming" : ""}`}>
                    <div className="who">{it.kind === "userMessage" ? "You" : "Muse"}</div>
                    {it.kind === "userMessage" ? <pre className="body">{it.text}</pre> : <Markdown text={it.text || (it.done ? "" : "…")} />}
                  </div>
                ),
              )}
              {liveApprovals.map((a) => (
                <ApprovalCard key={a.approvalId} a={a} onDecide={decide} />
              ))}
              {livePrompts.map((q) => (
                <QuestionCard key={q.userInputId} q={q} onAnswer={(ans) => answerPrompt(q, ans)} onCancel={() => cancelPrompt(q)} />
              ))}
              {busy && !streaming && liveApprovals.length === 0 && livePrompts.length === 0 && (
                <div className="thinking" aria-label="Muse is thinking">
                  <span />
                  <span />
                  <span />
                </div>
              )}
              <div ref={bottomRef} />
            </div>
            {error && <p className="err">{error}</p>}
            <div className="composer">
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
              />
            </div>
            {picking && <WorkspacePicker initial={workspace} onPick={chooseWorkspace} onClose={() => setPicking(false)} />}
          </>
        )}
      </main>
    </div>
  );
}
