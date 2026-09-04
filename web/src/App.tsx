import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { api, exportSession, ops, subscribe, turnCancel } from "./api";
import BrowserPanel from "./BrowserPanel";
import { applyItemDelta, genericRowText, groupThread, thinkingLive, ThreadItem } from "./threading";

interface Item extends ThreadItem {}

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
  turnCount?: number;
  status?: string;
}

interface Todo {
  text: string;
  status: string;
  activeForm?: string;
}

interface Attachment {
  id: string;
  kind: "image" | "text";
  name: string;
  mime: string;
  size: number;
  dataUrl?: string;
  text?: string;
  width?: number;
  height?: number;
  ready: boolean;
  error?: string;
}

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

function choiceText(c: Choice): string {
  return `${c.decision || ""} ${c.choiceId || ""} ${c.label || ""}`.toLowerCase();
}

function isDestructiveChoice(c: Choice): boolean {
  return /abort|deny|denied|reject|revoke|never|stop|cancel/.test(choiceText(c));
}

function isAllowChoice(c: Choice): boolean {
  return /approv|allow|accept|always|once|confirm|proceed|continue/.test(choiceText(c));
}

function ApprovalCard({ a, onDecide }: { a: Approval; onDecide: (a: Approval, choiceId: string, feedback?: string) => void | Promise<void> }) {
  const [feedback, setFeedback] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const choices = a.availableChoices;
  const canFeedback = choices.some((c) => c.acceptsFeedback);
  const feedbackChoice = choices.find((c) => c.acceptsFeedback);
  const feedbackLabel = feedbackChoice ? feedbackChoice.label || feedbackChoice.choiceId : "Reject";
  const destructiveIndex = choices.findIndex(isDestructiveChoice);
  const safestIndex = destructiveIndex >= 0 ? destructiveIndex : 0;
  const busy = pendingId !== null;

  function pick(index: number) {
    const c = choices[index];
    if (!c || pendingId !== null) return;
    setPendingId(c.choiceId);
    Promise.resolve(onDecide(a, c.choiceId, c.acceptsFeedback ? feedback || undefined : undefined)).catch(() =>
      setPendingId(null),
    );
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    const inField = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
    if (e.key === "Enter" && inField) {
      e.preventDefault();
      const fb = choices.findIndex((c) => c.acceptsFeedback);
      pick(fb >= 0 ? fb : safestIndex);
      return;
    }
    if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length === 1) {
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= Math.min(choices.length, 9)) {
        e.preventDefault();
        pick(n - 1);
      }
    }
  }

  return (
    <div className="approval" role="group" aria-label={`Approval request for ${a.toolName}`} aria-busy={busy} onKeyDown={onKeyDown}>
      <div className="who">Needs approval · {a.toolName}</div>
      <pre className="body">{renderSubject(a.subject)}</pre>
      {choices.map((c) => c.rulePreview).filter(Boolean)[0] && (
        <p className="rule">{choices.map((c) => c.rulePreview).filter(Boolean)[0]}</p>
      )}
      <div className="row">
        {choices.map((c, i) => {
          const kind = isDestructiveChoice(c) ? "destructive" : isAllowChoice(c) ? "allow" : "";
          return (
            <button
              key={c.choiceId}
              className={kind ? `choice ${kind}` : "choice"}
              autoFocus={i === safestIndex}
              disabled={busy}
              aria-label={`${c.label || c.choiceId} (press ${i + 1} of ${choices.length})`}
              title={i < 9 ? `Press ${i + 1}` : undefined}
              onClick={() => pick(i)}
            >
              {i < 9 && (
                <kbd className="key" aria-hidden>
                  {i + 1}
                </kbd>
              )}
              {c.label || c.choiceId}
            </button>
          );
        })}
        {choices.length === 0 && <span className="hint">waiting on host…</span>}
      </div>
      {canFeedback && (
        <input
          className="feedback"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder={`Feedback to the model (sent with ${feedbackLabel})`}
          aria-label="Feedback to the model"
          disabled={busy}
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

// Default model when the user hasn't picked one (no "Auto" option;
// sessions always pin a concrete model).
const DEFAULT_MODEL = "muse-spark-1.3";

// Approval modes ranked least permissive → most permissive.
const APPROVAL_LABELS: Record<string, string> = {
  denyUnmatched: "Deny new",
  onRequest: "Ask",
  promptUnmatched: "Ask new",
  allowAll: "Auto-accept",
};

function SlidersIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <line x1="2" y1="5" x2="14" y2="5" />
      <circle cx="6" cy="5" r="2" fill="var(--card)" />
      <line x1="2" y1="11" x2="14" y2="11" />
      <circle cx="11" cy="11" r="2" fill="var(--card)" />
    </svg>
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
  attachments,
  onAddFiles,
  onRemoveAttachment,
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
  attachments: Attachment[];
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const readyCount = attachments.filter((a) => a.ready && !a.error).length;
  const canSend = !!input.trim() || readyCount > 0;
  const modelOptions = models.includes(DEFAULT_MODEL) ? models : [DEFAULT_MODEL, ...models];
  const summary = `${folderName} · ${model} · ${effort ? `Effort: ${effort}` : "Auto"} · ${APPROVAL_LABELS[approvalMode] || approvalMode}`;

  return (
    <div
      className={`composer-inner${dragOver ? " drag" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length > 0) onAddFiles(files);
      }}
    >
      {attachments.length > 0 && (
        <div className="attachrow">
          {attachments.map((a) => (
            <span key={a.id} className="chip" title={a.error || `${a.name} · ${Math.round(a.size / 1024)}KB`}>
              {a.kind === "image" ? (
                a.dataUrl ? (
                  <img className="chipimg" src={a.dataUrl} alt="" />
                ) : (
                  <span className="chipspin" aria-hidden />
                )
              ) : (
                <span className="fileglyph" aria-hidden>
                  ≡
                </span>
              )}
              <span className="chipname">{a.ready ? a.name : "Reading…"}</span>
              {a.error && <span className="chiperr">{a.error}</span>}
              <button className="chipx" onClick={() => onRemoveAttachment(a.id)} aria-label={`Remove ${a.name}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setSettingsOpen(false);
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            setSettingsOpen(false);
            onSend();
          }
        }}
        onPaste={(e) => {
          const files = [...(e.clipboardData?.files || [])];
          if (files.length > 0) {
            e.preventDefault();
            onAddFiles(files);
          }
        }}
        placeholder="How can Muse help you today? Paste images or drop files anywhere here."
        rows={2}
      />
      <div className="bar single">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,.txt,.md,.markdown,.json,.jsonl,.csv,.tsv,.log,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.hpp,.cs,.sh,.yml,.yaml,.toml,.ini,.css,.html,.xml,.sql,.swift,.kt,.scala,.php"
          style={{ display: "none" }}
          onChange={(e) => {
            const files = [...(e.target.files || [])];
            e.target.value = "";
            if (files.length > 0) onAddFiles(files);
          }}
        />
        <button className="iconbtn" onClick={() => fileRef.current?.click()} title="Attach images or text files">
          +
        </button>
        <button
          className="settingbtn"
          onClick={() => setSettingsOpen((v) => !v)}
          title="Session settings: folder, model, effort, approval"
        >
          <SlidersIcon />
          <span className="sum">{summary}</span>
          <span className="chev" aria-hidden>
            ▾
          </span>
        </button>
        <span className="spacer" />
        {busy ? (
          <button className="danger" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button
            className="send"
            onClick={() => {
              setSettingsOpen(false);
              onSend();
            }}
            disabled={!canSend}
            aria-label="Send"
          >
            ↑
          </button>
        )}
      </div>
      {settingsOpen && (
        <>
          <div className="menuveil" onClick={() => setSettingsOpen(false)} />
          <div className="settingspop">
            <div className="sprow">
              <span>Folder</span>
              <button className="mini" onClick={onPickFolder} title={folderPath || "Server default folder"}>
                {folderName}
              </button>
            </div>
            <div className="sprow">
              <span>Model</span>
              <select className="pill select" value={model} onChange={(e) => onModel(e.target.value)} title="Model">
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="sprow">
              <span>Effort</span>
              <select className="pill select" value={effort} onChange={(e) => onEffort(e.target.value)} title="Reasoning effort">
                <option value="">Auto</option>
                <option value="none">none</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
                <option value="ultra">ultra</option>
              </select>
            </div>
            <div className="sprow">
              <span>Approval</span>
              <select
                className="pill select"
                value={approvalMode}
                onChange={(e) => onApproval(e.target.value)}
                title="Approval enforcement"
              >
                <option value="denyUnmatched">Deny new</option>
                <option value="onRequest">Ask</option>
                <option value="promptUnmatched">Ask new</option>
                <option value="allowAll">Auto-accept</option>
              </select>
            </div>
          </div>
        </>
      )}
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

interface GitStatus {
  repo: boolean;
  root?: string;
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  hasRemote?: boolean;
  staged?: number;
  unstaged?: number;
  untracked?: number;
  total?: number;
  truncated?: boolean;
  files?: { path: string; code: string; staged: boolean; unstaged: boolean; untracked: boolean }[];
}

function GitMenu({
  status,
  loading,
  workspace,
  onRefresh,
  onCommit,
  onPush,
  onPr,
  busyAction,
  note,
}: {
  status: GitStatus | null;
  loading: boolean;
  workspace: string;
  onRefresh: () => void;
  onCommit: (message: string, push: boolean) => void;
  onPush: () => void;
  onPr: (title: string, body: string) => void;
  busyAction: string | null;
  note: string | null;
}) {
  const [message, setMessage] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [showPr, setShowPr] = useState(false);
  const busyAny = busyAction != null;
  const changes = status?.total || 0;

  return (
    <div className="gitmenu">
      <div className="githead">
        <span className="gittitle">
          {status == null
            ? "Git"
            : !status.repo
              ? "Not a git repo"
              : `${status.branch || "HEAD"}${changes > 0 ? ` · ${changes} change${changes === 1 ? "" : "s"}` : " · clean"}`}
        </span>
        <span className="spacer" />
        <button className="mini" onClick={onRefresh} disabled={loading} title="Refresh git status">
          {loading ? "…" : "Refresh"}
        </button>
      </div>
      {status?.repo && (
        <p className="gitsub" title={status.root || workspace}>
          {(status.root || workspace || "").split("/").filter(Boolean).pop() || status.root || workspace}
          {status.upstream ? ` → ${status.upstream}` : ""}
          {(status.ahead || 0) > 0 ? ` · ↑${status.ahead}` : ""}
          {(status.behind || 0) > 0 ? ` · ↓${status.behind}` : ""}
        </p>
      )}
      {status != null && !status.repo && <p className="hint gitnote">This workspace folder is not a git repository.</p>}
      {status?.repo && changes > 0 && (
        <div className="gitfiles">
          {(status.files || []).map((f) => (
            <div key={f.path} className="gitfile" title={f.path}>
              <span className={`gitcode${f.untracked ? " new" : f.staged ? " st" : ""}`}>{f.untracked ? "?" : f.code.trim() || "·"}</span>
              <span className="gitpath">{f.path}</span>
            </div>
          ))}
          {status.truncated && <p className="hint gitnote">Showing first {(status.files || []).length} of {changes} files.</p>}
          <p className="hint gitnote">
            {(status.staged || 0) > 0 ? `${status.staged} staged · ` : ""}
            {(status.unstaged || 0) > 0 ? `${status.unstaged} modified · ` : ""}
            {(status.untracked || 0) > 0 ? `${status.untracked} untracked` : ""}
          </p>
        </div>
      )}
      {status?.repo && changes === 0 && <p className="hint gitnote">Working tree clean.</p>}
      {note && <p className={note.startsWith("✓") ? "gitok" : "err"}>{note}</p>}
      {status?.repo && (
        <>
          <textarea
            className="feedback gitmsg"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message…"
            rows={2}
          />
          <div className="row gitrow">
            <button
              className="primary gitbtn"
              disabled={busyAny || !message.trim() || changes === 0}
              onClick={() => {
                onCommit(message.trim(), false);
                setMessage("");
              }}
            >
              {busyAction === "commit" ? "Committing…" : "Commit"}
            </button>
            <button
              className="primary gitbtn"
              disabled={busyAny || !message.trim() || changes === 0}
              onClick={() => {
                onCommit(message.trim(), true);
                setMessage("");
              }}
              title="Stage everything, commit, and push (sets upstream on first push)"
            >
              {busyAction === "commit&push" ? "Pushing…" : "Commit & push"}
            </button>
          </div>
          <div className="row gitrow">
            <button className="choice" disabled={busyAny} onClick={onPush} title="Push the current branch">
              {busyAction === "push" ? "Pushing…" : "Push"}
            </button>
            <button className="choice" onClick={() => setShowPr((v) => !v)} title="Create a pull request with gh">
              PR…
            </button>
          </div>
          {showPr && (
            <div className="gitpr">
              <input
                className="feedback"
                value={prTitle}
                onChange={(e) => setPrTitle(e.target.value)}
                placeholder="PR title (required)"
              />
              <textarea
                className="feedback gitmsg"
                value={prBody}
                onChange={(e) => setPrBody(e.target.value)}
                placeholder="PR description (optional)"
                rows={2}
              />
              <p className="hint gitnote">Requires a clean tree and the `gh` CLI on the server.</p>
              <div className="row gitrow">
                <button
                  className="primary gitbtn"
                  disabled={busyAny || !prTitle.trim()}
                  onClick={() => {
                    onPr(prTitle.trim(), prBody);
                    setPrTitle("");
                    setPrBody("");
                  }}
                >
                  {busyAction === "pr" ? "Creating…" : "Create PR"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function JsonOut({ value }: { value: unknown }) {
  if (value == null) return null;
  return <pre className="tbody out">{JSON.stringify(value, null, 2).slice(0, 8000)}</pre>;
}

function thinkingLabel(entry: Item): string {
  switch (entry.kind) {
    case "reasoning":
      return "Thinking";
    case "toolCall":
      return entry.tool || "Tool";
    case "userShell":
      return "Shell";
    case "subagent":
      return "Subagent";
    case "workflow":
      return "Workflow";
    case "reminderChild":
      return "Reminder";
    case "compaction":
      return "Compacted";
    default:
      return entry.kind || "Activity";
  }
}

function thinkingDetail(entry: Item): string {
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
  const text = (entry.text || "").trim();
  return text || genericRowText(entry);
}

function shortPreview(s: string, n = 140): string {
  const one = (s || "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

// One collapsible block per run of intermediate activity. The header always
// shows a single live line (the latest step, swapped in place with a soft
// fade); the full step history mounts once and only opens on click, so
// streaming deltas never remount or re-animate the container.
export function ThinkingBlock({
  entries,
  streamingId,
  defaultOpen,
}: {
  entries: Item[];
  streamingId: string | null;
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen ?? false);
  const live = thinkingLive(entries, streamingId);
  const [elapsed, setElapsed] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const seenCount = useRef(entries.length);

  useEffect(() => {
    if (!live) return;
    const t0 = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [live]);

  // Follow the newest step inside the expanded list only.
  useEffect(() => {
    const el = bodyRef.current;
    if (!expanded || !el || entries.length === seenCount.current) return;
    seenCount.current = entries.length;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [entries.length, expanded]);

  const latest = entries[entries.length - 1];
  const preview = latest ? shortPreview(thinkingDetail(latest)) : "";
  return (
    <div className={`think${live ? " live" : ""}${expanded ? " open" : ""}`}>
      <button className="thinkhead" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        {live ? <span className="thinkspin on" aria-hidden /> : <span className="thinkdone" aria-hidden>✓</span>}
        <span className="thinkstack">
          <span className="thinktopline">
            <span className="thinktitle">{live ? "Thinking" : "Thought"}</span>
            {live && elapsed > 0 && (
              <span className="thinkelapsed" aria-hidden>
                {elapsed}s
              </span>
            )}
            <span className="thinkcount" aria-hidden>
              {entries.length} step{entries.length === 1 ? "" : "s"}
            </span>
          </span>
          {preview && (
            <span
              key={live ? latest.itemId : `done-${entries.length}`}
              className={`thinkpreview${live ? "" : " settled"}`}
              title={preview}
            >
              {preview}
            </span>
          )}
        </span>
        <span className="thinkchev" aria-hidden>
          ▸
        </span>
      </button>
      <div className={`thinkwrap${expanded ? " open" : ""}`}>
        <div ref={bodyRef} className="thinkbody">
          {entries.map((entry, i) => {
            const active = streamingId === entry.itemId || entry.status === "inProgress";
            return (
              <div key={entry.itemId} className={`thinkrow${active ? " active" : ""}`}>
                <span className="thinkstep" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="thinkmain">
                  <div className="thinklabel">{thinkingLabel(entry)}</div>
                  {thinkingDetail(entry) && <pre className="thinktext">{thinkingDetail(entry)}</pre>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SelfUpdate() {
  const [repo, setRepo] = useStored("openmuse.repo", "");
  const [st, setSt] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    ops.devUpdateStatus().then(setSt).catch(() => {});
  }, []);

  useEffect(() => {
    if (!polling) return;
    const t = setInterval(async () => {
      try {
        const s = await ops.devUpdateStatus();
        setSt(s);
        if (s.phase === "done" || s.phase === "failed") setPolling(false);
      } catch {
        // Connection lost mid-update: the old app likely just quit for the
        // swap. Stop polling and say so instead of spinning forever.
        setPolling(false);
        setSt((prev: any) => ({ ...(prev || {}), phase: "restarting", ok: false }));
      }
    }, 2000);
    return () => clearInterval(t);
  }, [polling]);

  async function start() {
    if (
      !window.confirm(
        "Rebuild the desktop app from the local repo, replace /Applications/OpenMuse.app, and relaunch? The app will quit itself once the build finishes.",
      )
    ) {
      return;
    }
    setErr(null);
    setStarting(true);
    try {
      const r = await ops.devUpdate(repo || undefined);
      setSt(r);
      setPolling(true);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setStarting(false);
    }
  }

  const phase = st?.phase || "idle";
  const running = polling || starting || (phase !== "idle" && phase !== "done" && phase !== "failed" && phase !== "restarting" && st?.started !== false);
  return (
    <div>
      <div className="row">
        <input
          className="feedback"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="Repo checkout path (blank = auto-detect)"
          title="openmuse.repo"
          spellCheck={false}
        />
        <button className="primary" onClick={start} disabled={starting}>
          {starting ? "Starting…" : "Update app"}
        </button>
      </div>
      {err && <p className="err">{err}</p>}
      {(st || polling) && (
        <p className="hint">
          Status: {phase}
          {st?.repo ? ` · ${st.repo}` : ""}
          {phase === "restarting" ? " — connection lost, the app is likely relaunching now." : ""}
          {phase === "done" ? ` — ${st?.note || "finished"}` : ""}
          {st?.error ? ` — ${st.error}` : ""}
          {running && phase !== "restarting" ? " (build takes a few minutes; the app quits itself at the end)" : ""}
        </p>
      )}
      {!!st?.logTail && <pre className="tbody out">{String(st.logTail).slice(-4000)}</pre>}
    </div>
  );
}

function SettingsPanel() {
  const fields: [string, string][] = [
    ["openmuse.provider", "provider (echo|meta)"],
    ["openmuse.preset", "preset (native-basic|miniswe)"],
    ["openmuse.model", "model id"],
    ["openmuse.effort", "reasoning effort (none|minimal|low|medium|high|xhigh|ultra)"],
    ["openmuse.baseUrl", "provider base URL"],
    ["openmuse.image", "image path (repeatable; comma-separated)"],
    ["openmuse.workspace", "workspace path"],
    ["openmuse.worktree", "worktree (off|create|existing)"],
    ["openmuse.worktreeBase", "worktree base ref"],
    ["openmuse.worktreeExisting", "existing worktree path"],
    ["openmuse.parallelCalls", "parallel tool calls (on|off)"],
    ["openmuse.compaction", "compaction strategy id"],
    ["openmuse.compactionSoft", "compaction soft threshold"],
    ["openmuse.compactionHard", "compaction hard threshold"],
    ["openmuse.maxSteps", "max model steps"],
    ["openmuse.maxToolBytes", "max tool output bytes"],
    ["openmuse.sessionId", "session id (fixed)"],
    ["openmuse.permissionProfile", "permission profile id"],
    ["openmuse.approvalJudge", "approval judge (on|off)"],
    ["openmuse.sandboxNetwork", "sandbox network (restricted|enabled|proxy-only)"],
    ["openmuse.safety", "safety flags shown (yolo|trust-workspace|disable-approval|disable-sandbox|disable-write|disable-shell)"],
    ["openmuse.noSessionLog", "no session log (1)"],
    ["openmuse.agents", "ephemeral agent-definition overlay (JSON)"],
    ["openmuse.echoDelay", "echo delay ms"],
    ["openmuse.subagentIsolation", "subagent worktree isolation (1)"],
    ["openmuse.disableWeb", "disable web tools (1)"],
    ["openmuse.noForeignCtx", "exclude foreign personal context (1)"],
  ];
  return (
    <div className="thread">
      <div className="msg agent">
        <div className="who">Settings (mirrors `muse` startup args)</div>
        <p className="hint">Stored locally and applied to new sessions and exec runs. Dangerous flags are shown per workspace choice.</p>
        {fields.map(([key, label]) => (
          <SettingRow key={key} storageKey={key} label={label} />
        ))}
      </div>
      <div className="msg agent">
        <div className="who">Self-update (rebuild this app from local changes)</div>
        <p className="hint">
          Rebuilds the desktop bundle from a repo checkout, swaps /Applications/OpenMuse.app, and relaunches. For
          developing OpenMuse inside OpenMuse.
        </p>
        <SelfUpdate />
      </div>
    </div>
  );
}

function AuthPanel() {
  const [statusOut, setStatusOut] = useState<unknown>(null);
  const [actionOut, setActionOut] = useState<unknown>(null);
  const [key, setKey] = useState("");
  const [provider, setProvider] = useState("");
  return (
    <div>
      <div className="row">
        <button className="choice" onClick={() => ops.authStatus().then(setStatusOut).catch((e: Error) => setStatusOut({ error: e.message }))}>Status</button>
        <button className="choice" onClick={() => ops.authLogout().then(setActionOut).catch((e: Error) => setActionOut({ error: e.message }))}>Logout</button>
      </div>
      <div className="row">
        <input className="feedback" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key (sent via stdin)" />
        <input className="feedback" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="provider (optional)" />
        <button className="choice" onClick={() => ops.authSet(key, provider || undefined).then((r) => { setKey(""); return r; }).then(setActionOut).catch((e: Error) => setActionOut({ error: e.message }))}>Store key</button>
      </div>
      <JsonOut value={statusOut} />
      <JsonOut value={actionOut} />
    </div>
  );
}

function AccountPanel({ model, effort, approvalMode, workspace }: { model: string; effort: string; approvalMode: string; workspace: string }) {
  const [cfgOut, setCfgOut] = useState<unknown>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  useEffect(() => {
    ops.configStatus().then(setCfgOut).catch((e: Error) => setCfgErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const provider = localStorage.getItem("openmuse.provider") || "meta (default)";
  return (
    <div className="thread">
      <div className="msg agent">
        <div className="who">Account profile</div>
        <p className="hint">Who is OpenMuse acting as, and with what defaults. Keys stay on this machine; login itself happens in your terminal via `muse login`.</p>
        <pre className="tbody out">{`provider: ${provider}\nmodel: ${model}\neffort: ${effort || "auto"}\napproval: ${approvalMode}\nworkspace: ${workspace || "server default"}`}</pre>
        <JsonOut value={cfgOut} />
        {cfgErr && <p className="err">{cfgErr}</p>}
      </div>
      <div className="msg agent">
        <div className="who">Credentials (`muse login` / `logout` / `auth set`)</div>
        <AuthPanel />
      </div>
    </div>
  );
}

function SettingRow({ storageKey, label }: { storageKey: string; label: string }) {
  const [value, setValue] = useStored(storageKey, "");
  return (
    <div className="row">
      <input className="feedback" value={value} onChange={(e) => setValue(e.target.value)} placeholder={label} title={storageKey} />
    </div>
  );
}

// Only user/agent messages render as bubbles; every other item kind folds
// into a per-run thinking block (see threading.ts). Unknown kinds render
// generically per the MSP spec, so any wire item with an id + kind is kept.

type Tab = "chat" | "settings" | "account";

function useStored(key: string, initial: string) {
  const [value, setValue] = useState(() => localStorage.getItem(key) || initial);
  function set(v: string) {
    setValue(v);
    if (v) localStorage.setItem(key, v);
    else localStorage.removeItem(key);
  }
  return [value, set] as const;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");
  const [menuOpen, setMenuOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [chatFilter, setChatFilter] = useState("");
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

  // Poll git status every 10s; refresh immediately when the menu opens or
  // the workspace changes.
  useEffect(() => {
    refreshGit();
    const t = setInterval(refreshGit, 10000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  const [attachments, setAttachments] = useState<Attachment[]>([]);

  function removeAttachment(id: string) {
    setAttachments((xs) => xs.filter((a) => a.id !== id));
  }

  async function ingestFile(f: File) {
    const id = `att-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    if (f.type.startsWith("image/")) {
      if (f.size > 12 * 1024 * 1024) {
        setError(`${f.name || "Image"}: images over 12MB can't be attached`);
        return;
      }
      setAttachments((xs) =>
        xs.length >= 8
          ? xs
          : [...xs, { id, kind: "image", name: f.name || "pasted image", mime: f.type, size: f.size, ready: false }],
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
          /* dimensions stay unknown; the host accepts parts without them */
        }
        setAttachments((xs) => xs.map((a) => (a.id === id ? { ...a, dataUrl, width, height, ready: true } : a)));
      } catch {
        setAttachments((xs) => xs.map((a) => (a.id === id ? { ...a, error: "unreadable" } : a)));
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
        setAttachments((xs) => xs.map((a) => (a.id === id ? { ...a, error: "unreadable" } : a)));
      }
      return;
    }
    setError(
      f.type.startsWith("image/")
        ? `${f.name || "Image"}: images over 12MB can't be attached`
        : `Can't attach ${f.name || "that file"}: images and text files under 256KB only`,
    );
  }

  function addFiles(files: File[]) {
    if (attachments.length >= 8) {
      setError("At most 8 attachments per message");
      return;
    }
    setError(null);
    for (const f of files.slice(0, 8 - attachments.length)) void ingestFile(f);
  }

  async function attachScreenshot(dataUrl: string, name: string) {
    setError(null);
    if (attachments.length >= 8) {
      setError("At most 8 attachments per message");
      return;
    }
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await ingestFile(new File([blob], name, { type: "image/png" }));
    } catch {
      setError("Couldn't attach that screenshot");
    }
  }

  function cleanTitle(t: string): string {
    return t
      .replace(/[*_`#~>|[\]()]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 44);
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

  function titleFromItems(arr: Item[], sid: string) {
    const first = arr.find((w) => w.kind === "userMessage" && w.text.trim());
    if (first) {
      const t = cleanTitle(first.text);
      if (t) setTitles((ts) => (ts[sid] ? ts : { ...ts, [sid]: t }));
    }
  }
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  // True while the reader sits at the bottom; streaming deltas must not yank
  // them back down once they've scrolled up to read.
  const stickRef = useRef(true);
  // Deltas that arrive before their item's open event (ephemeral opens have
  // no durable record yet). Drained into the item when the open arrives.
  const pendingDeltas = useRef<{ itemId: string; field: string; delta: string }[]>([]);

  useEffect(() => {
    if (!stickRef.current) return;
    // Instant while deltas pour in (queuing a smooth scroll per character is
    // what made the thread stutter); smooth for settled updates.
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
        // item/updated + item/completed re-emit the full item at a higher
        // revision; replace iff higher so out-of-order delivery can't
        // clobber the final state with a stale revision.
        if (it.revision != null && prev.revision != null && it.revision < prev.revision) return xs;
        const next = xs.slice();
        next[i] = { ...it, text: it.text || prev.text, visibleOutput: it.visibleOutput || prev.visibleOutput };
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
        case "turn/started":
          setBusy(true);
          break;
        case "turn/retryScheduled":
        case "turn/unqueued":
        case "view/gap":
        case "session/goalChanged":
        case "session/branchChanged":
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
        case "session/modelChanged":
          // Leave the picker on the user's own choice ("Auto" unless they
          // picked a model). Adopting the host-reported name here would
          // re-pin the selector to a concrete model on its own.
          break;
        case "item/started":
        case "item/updated":
          upsertItem(p.item);
          setBusy(true);
          break;
        case "item/delta": {
          if (!p.itemId || typeof p.delta !== "string") break;
          const field = p.field || "text";
          // Buffer-or-append decision must read current state without side
          // effects (StrictMode double-invokes updaters). Check membership
          // from the last rendered items via a ref-synced lookup instead.
          const known = itemsRef.current.some((it) => it.itemId === p.itemId);
          if (!known) {
            // Delta before its open event (ephemeral opens have no durable
            // record yet): buffer it; upsertItem drains it when the item
            // arrives. Without this the delta would be dropped and the
            // thinking block would miss streamed reasoning/tool output.
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

  // One shared EventSource for the app lifetime: tearing it down on every
  // session switch dropped events (and briefly double-delivered them).
  // Filtering uses the latest handler via ref.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  useEffect(() => subscribe((method: string, params: any) => onEventRef.current(method, params), setStatus), []);

  // Resolve real titles for sessions that have none, from each session's
  // first user message (first view page only; failures keep the fallback).
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
            /* keep the fallback title */
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
      /* resume history (if any) still stands */
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
    // Optimistic echo so the message appears instantly; replaced by the
    // host's own userMessage record when it arrives (same text).
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
  // Collapse consecutive intermediate items into per-run thinking blocks;
  // only user/agent messages render as bubbles. Memoized so block identity
  // (and collapse state) survives unrelated re-renders.
  const blocks = useMemo(() => groupThread(items), [items]);

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="mark" aria-hidden>
            M
          </span>
          OpenMuse
        </div>
        <button className="newbtn" onClick={() => { setTab("chat"); newSession(); }}>
          <span aria-hidden>+</span> New chat
        </button>
        <nav className="sess chats">
          <div className="sess-h">Chats</div>
          <input
            className="chatfilter"
            value={chatFilter}
            onChange={(e) => setChatFilter(e.target.value)}
            placeholder="Search chats…"
          />
          {sessions
            .filter((s) => titleFor(s).toLowerCase().includes(chatFilter.toLowerCase()))
            .map((s) => (
              <button
                key={s.sessionId}
                className={s.sessionId === sessionId ? "active chatrow" : "chatrow"}
                onClick={() => { setTab("chat"); openSession(s); }}
                title={s.sessionId}
              >
                <span className="ct">{titleFor(s)}</span>
                {metaFor(s) && <span className="cd">{metaFor(s)}</span>}
              </button>
            ))}
          {sessions.length === 0 && <p className="hint">No chats yet — start one.</p>}
        </nav>
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
        <div className="profile">
          <button className="profilebtn" onClick={() => setMenuOpen((v) => !v)}>
            <span className="avatar" aria-hidden>
              O
            </span>
            <span className="pmeta">
              <span className="pname">Local</span>
              <span className="pplan">{model}</span>
            </span>
          </button>
          {menuOpen && (
            <>
              <div className="menuveil" onClick={() => setMenuOpen(false)} />
              <div className="menu">
                <button onClick={() => { setTab("account"); setMenuOpen(false); }}>Account</button>
                <button onClick={() => { setTab("settings"); setMenuOpen(false); }}>Settings</button>
                {sessionId && <button onClick={() => { exportChat(); setMenuOpen(false); }}>Export chat</button>}
                <button
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
                  Log out
                </button>
              </div>
            </>
          )}
        </div>
      </aside>
      <div className="work">
      <main className={`main tab-${tab}`}>
        <div className="topbar">
          <div className="topgroup">
            <span className="statuspill" data-ok={status.connected}>
              {status.mock ? "demo host" : status.connected ? "muse connected" : "muse unreachable"}
            </span>
            <button
              className={`mini gitbtn${git && git.repo && gitChanges > 0 ? " dirty" : ""}`}
              onClick={() => {
                setGitOpen((v) => !v);
                if (!gitOpen) refreshGit();
              }}
              title={git && git.repo ? `${gitChanges} uncommitted change${gitChanges === 1 ? "" : "s"} on ${git.branch || "?"}` : "Git actions: commit, push, PR"}
            >
              <span className="gitdot" aria-hidden />
              {git?.repo ? `${git.branch || "?"}${gitChanges > 0 ? ` · ${gitChanges}` : ""}` : "Git"}
            </button>
          </div>
          <button
            className="mini bbrowser"
            onClick={() => setBrowserOpen((v) => !v)}
            title="Open a browser pane on the right to view any URL and screenshot it"
          >
            {browserOpen ? "Hide browser" : "Browser"}
          </button>
        </div>
        {gitOpen && (
          <>
            <div className="menuveil" onClick={() => setGitOpen(false)} />
            <div className="gitpop">
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
            </div>
          </>
        )}
        {tab === "settings" ? (
          <SettingsPanel />
        ) : tab === "account" ? (
          <AccountPanel model={model} effort={effort} approvalMode={approvalMode} workspace={workspace} />
        ) : !sessionId ? (
          <div className="empty">
            <h1>{daypart}</h1>
            <p>How can Muse help?</p>
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
                attachments={attachments}
                onAddFiles={addFiles}
                onRemoveAttachment={removeAttachment}
              />
            </div>
            {picking && <WorkspacePicker initial={workspace} onPick={chooseWorkspace} onClose={() => setPicking(false)} />}
          </div>
        ) : (
          <>
            <div className="chead">
              <span className="chead-title">
                {(() => {
                  const s = sessions.find((x) => x.sessionId === sessionId);
                  return s ? titleFor(s) : "Chat";
                })()}
              </span>
              <span className="spacer" />
              <button
                className="mini"
                onClick={async () => {
                  if (!sessionId) return;
                  setError(null);
                  try {
                    const r = await ops.fork(sessionId);
                    const f = r.session;
                    if (f) setSessions((xs) => [{ sessionId: f.sessionId, title: f.title, updatedAt: f.updatedAt }, ...xs]);
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                Fork
              </button>
              <button
                className="mini"
                onClick={async () => {
                  if (!sessionId) return;
                  setError(null);
                  try {
                    await ops.compact(sessionId);
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                Compact
              </button>
              <button className="mini" onClick={exportChat}>
                Export
              </button>
            </div>
            {ctx && (
              <div className="ctxbar" title={`${ctx.used} / ${ctx.window} tokens`}>
                <div className="ctxfill" style={{ width: `${ctxPct}%` }} />
              </div>
            )}
            <div
              ref={threadRef}
              className="thread"
              aria-live="polite"
              onScroll={(e) => {
                const el = e.currentTarget;
                stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
              }}
            >
              {blocks.map((b) =>
                b.type === "thinking" ? (
                  <ThinkingBlock key={b.key} entries={b.entries} streamingId={streaming} />
                ) : (
                  <div
                    key={b.item.itemId}
                    className={`msg ${b.type === "user" ? "user" : "agent"}${streaming === b.item.itemId ? " streaming" : ""}`}
                  >
                    <div className="who">{b.type === "user" ? "You" : "Muse"}</div>
                    {b.type === "user" ? (
                      <pre className="body">{b.item.text}</pre>
                    ) : (
                      <Markdown text={b.item.text || (b.item.done ? "" : "…")} />
                    )}
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
                attachments={attachments}
                onAddFiles={addFiles}
                onRemoveAttachment={removeAttachment}
              />
            </div>
            {picking && <WorkspacePicker initial={workspace} onPick={chooseWorkspace} onClose={() => setPicking(false)} />}
          </>
        )}
      </main>
      {browserOpen && (
        <div className="browserwrap">
          <BrowserPanel onAttach={attachScreenshot} onClose={() => setBrowserOpen(false)} />
        </div>
      )}
      </div>
    </div>
  );
}
