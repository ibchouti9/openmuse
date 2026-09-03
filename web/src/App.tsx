import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { api, exportSession, ops, subscribe, turnCancel } from "./api";
import BrowserPanel from "./BrowserPanel";

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

const APPROVAL_LABELS: Record<string, string> = {
  onRequest: "Ask",
  promptUnmatched: "Ask new",
  allowAll: "Auto-accept",
  denyUnmatched: "Deny new",
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
  const summary = `${folderName} · ${model || "Auto"} · ${effort ? `Effort: ${effort}` : "Auto"} · ${APPROVAL_LABELS[approvalMode] || approvalMode}`;

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
                <option value="">Auto</option>
                {models.map((m) => (
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
                <option value="onRequest">Ask</option>
                <option value="promptUnmatched">Ask new</option>
                <option value="allowAll">Auto-accept</option>
                <option value="denyUnmatched">Deny new</option>
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

function JsonOut({ value }: { value: unknown }) {
  if (value == null) return null;
  return <pre className="tbody out">{JSON.stringify(value, null, 2).slice(0, 8000)}</pre>;
}

function usePanel<T>(fn: () => Promise<T>) {
  const [out, setOut] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function run() {
    setLoading(true);
    setErr(null);
    try {
      setOut(await fn());
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }
  return { out, err, loading, run, setOut };
}

function SessionsPanel({ sessionId }: { sessionId: string | null }) {
  const [sid, setSid] = useState(sessionId || "");
  const [cmd, setCmd] = useState("");
  const [subId, setSubId] = useState("");
  const [subBody, setSubBody] = useState("");
  const [turnId, setTurnId] = useState("");
  const [clarify, setClarify] = useState("");
  const p = usePanel(() => Promise.resolve(null as unknown));
  useEffect(() => {
    setSid(sessionId || "");
  }, [sessionId]);
  async function call(fn: () => Promise<unknown>) {
    try {
      p.setOut("running…" as unknown);
      p.setOut((await fn()) as never);
    } catch (e: any) {
      p.setOut({ error: e.message } as never);
    }
  }
  return (
    <div className="thread">
      <div className="msg agent">
        <div className="who">Sessions</div>
        <p className="hint">Full session controls: read, fork, compact, shell (!), pending approvals, steer, unqueue, clarify, unsubscribe, subagents.</p>
        <input className="feedback" value={sid} onChange={(e) => setSid(e.target.value)} placeholder="sessionId" />
        <div className="row">
          <button className="choice" onClick={() => call(() => ops.read(sid))}>Read</button>
          <button className="choice" onClick={() => call(() => ops.fork(sid))}>Fork</button>
          <button className="choice" onClick={() => call(() => ops.compact(sid))}>Compact</button>
          <button className="choice" onClick={() => call(() => ops.pending(sid))}>Pending</button>
          <button className="choice" onClick={() => call(() => ops.unsubscribe(sid))}>Unsubscribe</button>
        </div>
        <div className="row">
          <input className="feedback" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="! shell command (session/userShell)" />
          <button className="choice" onClick={() => call(() => ops.shell(sid, cmd))}>Run</button>
        </div>
        <div className="row">
          <input className="feedback" value={turnId} onChange={(e) => setTurnId(e.target.value)} placeholder="turnId (steer target / unqueue)" />
          <button className="choice" onClick={() => call(() => ops.unqueue(sid, turnId))}>Unqueue</button>
        </div>
        <div className="row">
          <input className="feedback" value={turnId} onChange={(e) => setTurnId(e.target.value)} placeholder="expectedTurnId" />
          <input className="feedback" value={clarify} onChange={(e) => setClarify(e.target.value)} placeholder="steer text / clarify text" />
          <button className="choice" onClick={() => call(() => ops.steer(sid, turnId, clarify))}>Steer</button>
        </div>
        <div className="row">
          <input className="feedback" value={subId} onChange={(e) => setSubId(e.target.value)} placeholder="subagentId" />
          <input className="feedback" value={subBody} onChange={(e) => setSubBody(e.target.value)} placeholder="message / followup body" />
        </div>
        <div className="row">
          <button className="choice" onClick={() => call(() => ops.subagent("message", sid, subId, { body: subBody }))}>Msg</button>
          <button className="choice" onClick={() => call(() => ops.subagent("followup", sid, subId, { body: subBody }))}>Followup</button>
          <button className="choice" onClick={() => call(() => ops.subagent("read", sid, subId))}>Read</button>
          <button className="choice" onClick={() => call(() => ops.subagent("stop", sid, subId))}>Stop</button>
          <button className="choice" onClick={() => call(() => ops.subagent("close", sid, subId))}>Close</button>
          <button className="choice" onClick={() => call(() => ops.subagent("interrupt", sid, subId))}>Interrupt</button>
          <button className="choice" onClick={() => call(() => ops.subagent("reopen", sid, subId))}>Reopen</button>
          <button className="choice" onClick={() => call(() => ops.subagent("resume", sid, subId))}>Resume</button>
        </div>
        <JsonOut value={p.out} />
      </div>
    </div>
  );
}

function ExecPanel({ workspace, model, effort }: { workspace: string; model: string; effort: string }) {
  const [prompt, setPrompt] = useState("");
  const [approvalMode, setApprovalMode] = useState("on-request");
  const p = usePanel(() => Promise.resolve(null as unknown));
  return (
    <div className="thread">
      <div className="msg agent">
        <div className="who">Exec (headless `muse exec`)</div>
        <p className="hint">One-shot non-interactive run with JSONL events. Same args as the CLI: model, reasoning effort, workspace, approval mode.</p>
        <textarea className="feedback" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="prompt" rows={3} />
        <div className="row">
          <input className="feedback" value={model} readOnly title="model (from chat composer)" placeholder="model" />
          <input className="feedback" value={effort} readOnly title="reasoning effort (from chat composer)" placeholder="effort" />
          <select className="pill select" value={approvalMode} onChange={(e) => setApprovalMode(e.target.value)}>
            <option value="on-request">on-request</option>
            <option value="untrusted">untrusted</option>
            <option value="never">never</option>
          </select>
          <button className="primary" onClick={() => p.run().then(() => ops.exec({
            prompt, model, reasoningEffort: effort, workspace, approvalMode,
            provider: localStorage.getItem("openmuse.provider") || "",
            preset: localStorage.getItem("openmuse.preset") || "",
            permissionProfile: localStorage.getItem("openmuse.permissionProfile") || "",
            baseUrl: localStorage.getItem("openmuse.baseUrl") || "",
            image: localStorage.getItem("openmuse.image") || "",
            worktree: localStorage.getItem("openmuse.worktree") || "",
            worktreeBase: localStorage.getItem("openmuse.worktreeBase") || "",
            worktreeExisting: localStorage.getItem("openmuse.worktreeExisting") || "",
            parallelCalls: localStorage.getItem("openmuse.parallelCalls") || "",
            compaction: localStorage.getItem("openmuse.compaction") || "",
            compactionSoft: localStorage.getItem("openmuse.compactionSoft") || "",
            compactionHard: localStorage.getItem("openmuse.compactionHard") || "",
            maxSteps: localStorage.getItem("openmuse.maxSteps") || "",
            maxToolBytes: localStorage.getItem("openmuse.maxToolBytes") || "",
            sessionId: localStorage.getItem("openmuse.sessionId") || "",
            approvalJudge: localStorage.getItem("openmuse.approvalJudge") || "",
            agents: localStorage.getItem("openmuse.agents") || "",
            sandboxNetwork: localStorage.getItem("openmuse.sandboxNetwork") || "",
            yolo: localStorage.getItem("openmuse.safety")?.includes("yolo") ? "1" : "",
            trustWorkspace: localStorage.getItem("openmuse.safety")?.includes("trust-workspace") ? "1" : "",
            disableApproval: localStorage.getItem("openmuse.safety")?.includes("disable-approval") ? "1" : "",
            disableSandbox: localStorage.getItem("openmuse.safety")?.includes("disable-sandbox") ? "1" : "",
            disableWrite: localStorage.getItem("openmuse.safety")?.includes("disable-write") ? "1" : "",
            disableShell: localStorage.getItem("openmuse.safety")?.includes("disable-shell") ? "1" : "",
            noSessionLog: localStorage.getItem("openmuse.noSessionLog") || "",
            subagentIsolation: localStorage.getItem("openmuse.subagentIsolation") || "",
            disableWeb: localStorage.getItem("openmuse.disableWeb") || "",
            noForeignCtx: localStorage.getItem("openmuse.noForeignCtx") || "",
          }).then(p.setOut as (v: any) => void).catch((e: Error) => p.setOut({ error: e.message } as never)))}>
            Run exec
          </button>
        </div>
        {p.loading && <p className="hint">running…</p>}
        {p.err && <p className="err">{p.err}</p>}
        <JsonOut value={p.out} />
      </div>
    </div>
  );
}

function SkillsPanel() {
  const list = usePanel(() => ops.skills());
  const [skill, setSkill] = useState("");
  const [scope, setScope] = useState("user");
  const act = usePanel(() => Promise.resolve(null as unknown));
  useEffect(() => {
    list.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="thread">
      <div className="msg agent">
        <div className="who">Skills (`muse skills`)</div>
        <div className="row">
          <button className="choice" onClick={list.run}>List</button>
          <input className="feedback" value={skill} onChange={(e) => setSkill(e.target.value)} placeholder="skill id or path" />
          <select className="pill select" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="user">user</option>
            <option value="project">project</option>
            <option value="built-in">built-in</option>
            <option value="plugin">plugin</option>
          </select>
        </div>
        <div className="row">
          {(["inspect", "enable", "disable", "update", "uninstall", "install", "import", "user-only"] as const).map((a) => (
            <button key={a} className="choice" onClick={() => act.run().then(() => ops.skillsAction(a, skill, scope).then(act.setOut as (v: any) => void).catch((e: Error) => act.setOut({ error: e.message } as never)))}>
              {a}
            </button>
          ))}
        </div>
        {list.err && <p className="err">{list.err}</p>}
        <JsonOut value={list.out} />
        <JsonOut value={act.out} />
      </div>
    </div>
  );
}

function PluginsPanel() {
  const list = usePanel(() => ops.plugins());
  const [id, setId] = useState("");
  const act = usePanel(() => Promise.resolve(null as unknown));
  useEffect(() => {
    list.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="thread">
      <div className="msg agent">
        <div className="who">Plugins (`muse plugins`)</div>
        <div className="row">
          <button className="choice" onClick={list.run}>List</button>
          <input className="feedback" value={id} onChange={(e) => setId(e.target.value)} placeholder="plugin id" />
        </div>
        <div className="row">
          {(["inspect", "enable", "disable", "update", "remove", "approve", "reject", "install"] as const).map((a) => (
            <button key={a} className="choice" onClick={() => act.run().then(() => ops.pluginsAction(a, id).then(act.setOut as (v: any) => void).catch((e: Error) => act.setOut({ error: e.message } as never)))}>
              {a}
            </button>
          ))}
        </div>
        <div className="row">
          <button className="choice" onClick={() => act.run().then(() => ops.pluginsAction("marketplace", undefined, ["list"]).then(act.setOut as (v: any) => void).catch((e: Error) => act.setOut({ error: e.message } as never)))}>marketplace list</button>
        </div>
        {list.err && <p className="err">{list.err}</p>}
        <JsonOut value={list.out} />
        <JsonOut value={act.out} />
      </div>
    </div>
  );
}

function OpsPanel() {
  const [log, setLog] = useState("");
  const trace = usePanel(() => Promise.resolve(null as unknown));
  const msgs = usePanel(() => ops.messages());
  const schema = usePanel(() => ops.schema());
  const sandbox = usePanel(() => ops.sandbox());
  const version = usePanel(() => ops.cliVersion());
  const config = usePanel(() => ops.configStatus());
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState("");
  const send = usePanel(() => Promise.resolve(null as unknown));
  const init = usePanel(() => Promise.resolve(null as unknown));
  const [expSession, setExpSession] = useState("");
  const exp = usePanel(() => Promise.resolve(null as unknown));
  return (
    <div className="thread">
      <div className="msg agent">
        <div className="who">Auth (`muse login` / `logout` / `auth set`)</div>
        <p className="hint">Login itself is interactive in a terminal; here you can check status, store a key via stdin (never as argv), or log out.</p>
        <AuthPanel />
      </div>
      <div className="msg agent">
        <div className="who">Config validate (`muse config validate`)</div>
        <ValidatePanel />
      </div>
      <div className="msg agent">
        <div className="who">Ops: trace · export · messages · sandbox · schema · auth/config · init</div>
        <div className="row">
          <button className="choice" onClick={() => version.run().then(() => ops.cliVersion().then(version.setOut as (v: any) => void))}>Version</button>
          <button className="choice" onClick={() => config.run().then(() => ops.configStatus().then(config.setOut as (v: any) => void))}>Config status</button>
          <button className="choice" onClick={() => sandbox.run().then(() => ops.sandbox().then(sandbox.setOut as (v: any) => void))}>Sandbox check</button>
          <button className="choice" onClick={() => schema.run().then(() => ops.schema().then(schema.setOut as (v: any) => void))}>Schema</button>
          <button className="choice" onClick={() => init.run().then(() => ops.init(true).then(init.setOut as (v: any) => void))}>Init --dry-run</button>
        </div>
        <JsonOut value={version.out} />
        <JsonOut value={config.out} />
        <JsonOut value={sandbox.out} />
        <JsonOut value={schema.out} />
        <JsonOut value={init.out} />
      </div>
      <div className="msg agent">
        <div className="who">Trace inspect</div>
        <div className="row">
          <input className="feedback" value={log} onChange={(e) => setLog(e.target.value)} placeholder="session-log .jsonl path" />
          <button className="choice" onClick={() => trace.run().then(() => ops.trace(log).then(trace.setOut as (v: any) => void).catch((e: Error) => trace.setOut({ error: e.message } as never)))}>Inspect</button>
        </div>
        <JsonOut value={trace.out} />
      </div>
      <div className="msg agent">
        <div className="who">Export session</div>
        <div className="row">
          <input className="feedback" value={expSession} onChange={(e) => setExpSession(e.target.value)} placeholder="session id" />
          <button className="choice" onClick={() => exp.run().then(() => ops.cliExport(expSession).then(exp.setOut as (v: any) => void).catch((e: Error) => exp.setOut({ error: e.message } as never)))}>Export --last fallback</button>
        </div>
        <JsonOut value={exp.out} />
      </div>
      <div className="msg agent">
        <div className="who">Cross-session messages</div>
        <div className="row">
          <button className="choice" onClick={() => msgs.run().then(() => ops.messages().then(msgs.setOut as (v: any) => void))}>List</button>
          <input className="feedback" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="target session uuid/name" />
          <input className="feedback" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="message" />
          <button className="choice" onClick={() => send.run().then(() => ops.messageSend(target, message).then(send.setOut as (v: any) => void).catch((e: Error) => send.setOut({ error: e.message } as never)))}>Send</button>
        </div>
        <JsonOut value={msgs.out} />
        <JsonOut value={send.out} />
      </div>
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
    </div>
  );
}

function AuthPanel() {
  const st = usePanel(() => ops.authStatus());
  const out = usePanel(() => Promise.resolve(null as unknown));
  const [key, setKey] = useState("");
  const [provider, setProvider] = useState("");
  return (
    <div>
      <div className="row">
        <button className="choice" onClick={() => st.run().then(() => ops.authStatus().then(st.setOut as (v: any) => void))}>Status</button>
        <button className="choice" onClick={() => out.run().then(() => ops.authLogout().then(out.setOut as (v: any) => void))}>Logout</button>
      </div>
      <div className="row">
        <input className="feedback" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key (sent via stdin)" />
        <input className="feedback" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="provider (optional)" />
        <button className="choice" onClick={() => out.run().then(() => ops.authSet(key, provider || undefined).then((r) => { setKey(""); return r; }).then(out.setOut as (v: any) => void).catch((e: Error) => out.setOut({ error: e.message } as never)))}>Store key</button>
      </div>
      <JsonOut value={st.out} />
      <JsonOut value={out.out} />
    </div>
  );
}

function ValidatePanel() {
  const [plane, setPlane] = useState("defaults");
  const [file, setFile] = useState("");
  const p = usePanel(() => Promise.resolve(null as unknown));
  return (
    <div>
      <div className="row">
        <select className="pill select" value={plane} onChange={(e) => setPlane(e.target.value)}>
          <option value="defaults">defaults</option>
          <option value="policy">policy</option>
        </select>
        <input className="feedback" value={file} onChange={(e) => setFile(e.target.value)} placeholder="config file path on server" />
        <button className="choice" onClick={() => p.run().then(() => ops.configValidate(plane, file).then(p.setOut as (v: any) => void).catch((e: Error) => p.setOut({ error: e.message } as never)))}>Validate</button>
      </div>
      <JsonOut value={p.out} />
    </div>
  );
}

function AccountPanel({ model, effort, approvalMode, workspace }: { model: string; effort: string; approvalMode: string; workspace: string }) {
  const cfg = usePanel(() => ops.configStatus());
  useEffect(() => {
    cfg.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const provider = localStorage.getItem("openmuse.provider") || "meta (default)";
  return (
    <div className="thread">
      <div className="msg agent">
        <div className="who">Account profile</div>
        <p className="hint">Who is OpenMuse acting as, and with what defaults. Keys stay on this machine; login itself happens in your terminal via `muse login`.</p>
        <pre className="tbody out">{`provider: ${provider}\nmodel: ${model || "auto"}\neffort: ${effort || "auto"}\napproval: ${approvalMode}\nworkspace: ${workspace || "server default"}`}</pre>
        <JsonOut value={cfg.out} />
        {cfg.err && <p className="err">{cfg.err}</p>}
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

const RENDERABLE = new Set(["userMessage", "agentMessage", "toolCall"]);

type Tab = "chat" | "sessions" | "exec" | "skills" | "plugins" | "ops" | "settings" | "account";

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
          if (p.modelId) setModel(p.modelId);
          break;
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
        <button className="newbtn" onClick={() => { setTab("chat"); newSession(); }}>
          <span aria-hidden>+</span> New chat
        </button>
        <nav className="navlist">
          {([["chat", "Chats"], ["sessions", "Sessions"], ["exec", "Exec"], ["skills", "Skills"], ["plugins", "Plugins"], ["ops", "System"]] as [Tab, string][]).map(([t, label]) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="conn" data-ok={status.connected}>
          {status.mock ? "demo host" : status.connected ? "muse connected" : "muse unreachable"}
        </div>
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
              <span className="pplan">{model || "auto"}</span>
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
          <span className="statuspill" data-ok={status.connected}>
            {status.mock ? "demo host" : status.connected ? "muse connected" : "muse unreachable"}
          </span>
          <button
            className="mini bbrowser"
            onClick={() => setBrowserOpen((v) => !v)}
            title="Open a browser pane on the right to view any URL and screenshot it"
          >
            {browserOpen ? "Hide browser" : "Browser"}
          </button>
        </div>
        {tab === "sessions" ? (
          <SessionsPanel sessionId={sessionId} />
        ) : tab === "exec" ? (
          <ExecPanel workspace={workspace} model={model} effort={effort} />
        ) : tab === "skills" ? (
          <SkillsPanel />
        ) : tab === "plugins" ? (
          <PluginsPanel />
        ) : tab === "ops" ? (
          <OpsPanel />
        ) : tab === "settings" ? (
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
