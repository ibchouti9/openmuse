import { useEffect, useState } from "react";
import { ops } from "../api";
import {
  CpuIcon,
  FolderIcon,
  RefreshCwIcon,
  SettingsIcon,
  SlidersIcon,
  CheckIcon,
} from "./Icons";

type SettingSpec =
  | { key: string; label: string; kind: "text"; desc?: string }
  | { key: string; label: string; kind: "select"; options: string[]; emptyLabel: string; desc?: string }
  | { key: string; label: string; kind: "toggle"; desc?: string }
  | { key: string; label: string; kind: "flag"; desc?: string }
  | { key: string; label: string; kind: "number"; min?: number; integer?: boolean; desc?: string };

const SETTINGS_CATEGORIES: {
  id: string;
  name: string;
  icon: typeof SlidersIcon;
  fields: SettingSpec[];
}[] = [
  {
    id: "model",
    name: "Model & Reasoning",
    icon: CpuIcon,
    fields: [
      { key: "openmuse.model", label: "Model ID", kind: "text", desc: "Explicit model name override for new sessions (e.g. muse-spark-1.3)." },
      { key: "openmuse.effort", label: "Reasoning Effort", kind: "select", options: ["none", "minimal", "low", "medium", "high", "xhigh", "ultra"], emptyLabel: "Auto", desc: "Allocates thinking token budget before emitting tool actions." },
      { key: "openmuse.maxSteps", label: "Max Model Steps", kind: "number", min: 1, integer: true, desc: "Maximum consecutive autonomous reasoning turns per prompt." },
      { key: "openmuse.maxToolBytes", label: "Max Tool Output (bytes)", kind: "number", min: 1, integer: true, desc: "Truncate oversized tool stdout/stderr to protect context window." },
      { key: "openmuse.compaction", label: "Compaction Strategy", kind: "text", desc: "Identifier for context summarizing strategy." },
      { key: "openmuse.compactionSoft", label: "Compaction Soft Threshold", kind: "number", min: 0, integer: true, desc: "Token threshold where gentle compaction starts." },
      { key: "openmuse.compactionHard", label: "Compaction Hard Threshold", kind: "number", min: 0, integer: true, desc: "Token threshold where aggressive trimming occurs." },
    ],
  },
  {
    id: "workspace",
    name: "Workspace & Safety",
    icon: FolderIcon,
    fields: [
      { key: "openmuse.workspace", label: "Default Workspace Path", kind: "text", desc: "Base local filesystem folder where commands and edits occur." },
      { key: "openmuse.worktree", label: "Git Worktree Isolation", kind: "select", options: ["off", "create", "existing"], emptyLabel: "(default)", desc: "Run agent in an isolated Git worktree to protect working tree." },
      { key: "openmuse.sandboxNetwork", label: "Sandbox Network Policy", kind: "select", options: ["restricted", "enabled", "proxy-only"], emptyLabel: "(default)", desc: "Network socket capabilities given to sandboxed tool runners." },
      { key: "openmuse.disableWeb", label: "Disable Web Tools", kind: "flag", desc: "Prevent agent from making external HTTP fetches or web searches." },
      { key: "openmuse.subagentIsolation", label: "Subagent Worktree Isolation", kind: "flag", desc: "Isolate parallel subagent turns in dedicated git branches." },
      { key: "openmuse.safety", label: "Safety Flags", kind: "text", desc: "Flags: yolo, trust-workspace, disable-approval, disable-sandbox." },
    ],
  },
  {
    id: "engine",
    name: "Engine & Protocol",
    icon: SettingsIcon,
    fields: [
      { key: "openmuse.provider", label: "Provider", kind: "select", options: ["echo", "meta"], emptyLabel: "(default)", desc: "Underlying agent runtime engine." },
      { key: "openmuse.preset", label: "Preset", kind: "select", options: ["native-basic", "miniswe"], emptyLabel: "(default)", desc: "Prompt template and persona configuration." },
      { key: "openmuse.baseUrl", label: "Provider Base URL", kind: "text", desc: "Custom API gateway endpoint URL." },
      { key: "openmuse.parallelCalls", label: "Parallel Tool Calls", kind: "toggle", desc: "Allow model to emit concurrent tool calls in a single turn." },
      { key: "openmuse.approvalJudge", label: "Approval Judge", kind: "toggle", desc: "Enable automated risk judge on tool execution." },
      { key: "openmuse.noSessionLog", label: "Disable Session Log", kind: "flag", desc: "Do not write durable session transcripts to disk." },
      { key: "openmuse.echoDelay", label: "Echo Delay (ms)", kind: "number", min: 0, integer: true, desc: "Artificial delay for testing streaming animations." },
    ],
  },
  {
    id: "updates",
    name: "Self-Update & Build",
    icon: RefreshCwIcon,
    fields: [],
  },
];

function useStored(key: string, initial: string) {
  const [val, setVal] = useState(() => localStorage.getItem(key) ?? initial);
  function set(v: string) {
    if (v) localStorage.setItem(key, v);
    else localStorage.removeItem(key);
    setVal(v);
  }
  return [val, set] as const;
}

function SettingSelect({ spec }: { spec: Extract<SettingSpec, { kind: "select" }> }) {
  const [val, setVal] = useStored(spec.key, "");
  return (
    <div className="settings-field-card">
      <div className="field-info">
        <label className="field-label">{spec.label}</label>
        {spec.desc && <p className="field-description">{spec.desc}</p>}
      </div>
      <div className="field-control">
        <select
          className="settings-select-input"
          value={val}
          onChange={(e) => setVal(e.target.value)}
        >
          <option value="">{spec.emptyLabel}</option>
          {spec.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function SettingToggle({ spec }: { spec: Extract<SettingSpec, { kind: "toggle" }> }) {
  const [val, setVal] = useStored(spec.key, "");
  const isOn = val === "1" || val === "true";
  return (
    <div className="settings-field-card">
      <div className="field-info">
        <label className="field-label">{spec.label}</label>
        {spec.desc && <p className="field-description">{spec.desc}</p>}
      </div>
      <div className="field-control">
        <button
          type="button"
          className={`settings-toggle-switch ${isOn ? "on" : "off"}`}
          onClick={() => setVal(isOn ? "" : "true")}
          aria-checked={isOn}
          role="switch"
        >
          <span className="toggle-thumb" />
        </button>
      </div>
    </div>
  );
}

function SettingFlag({ spec }: { spec: Extract<SettingSpec, { kind: "flag" }> }) {
  const [val, setVal] = useStored(spec.key, "");
  const isOn = val === "1" || val === "true";
  return (
    <div className="settings-field-card">
      <div className="field-info">
        <label className="field-label">{spec.label}</label>
        {spec.desc && <p className="field-description">{spec.desc}</p>}
      </div>
      <div className="field-control">
        <button
          type="button"
          className={`settings-toggle-switch ${isOn ? "on" : "off"}`}
          onClick={() => setVal(isOn ? "" : "true")}
          aria-checked={isOn}
          role="switch"
        >
          <span className="toggle-thumb" />
        </button>
      </div>
    </div>
  );
}

function SettingNumber({ spec }: { spec: Extract<SettingSpec, { kind: "number" }> }) {
  const [val, setVal] = useStored(spec.key, "");
  return (
    <div className="settings-field-card">
      <div className="field-info">
        <label className="field-label">{spec.label}</label>
        {spec.desc && <p className="field-description">{spec.desc}</p>}
      </div>
      <div className="field-control">
        <input
          type="number"
          className="settings-text-input number"
          value={val}
          min={spec.min}
          placeholder="Default"
          onChange={(e) => setVal(e.target.value)}
        />
      </div>
    </div>
  );
}

function SettingText({ spec }: { spec: Extract<SettingSpec, { kind: "text" }> }) {
  const [val, setVal] = useStored(spec.key, "");
  return (
    <div className="settings-field-card">
      <div className="field-info">
        <label className="field-label">{spec.label}</label>
        {spec.desc && <p className="field-description">{spec.desc}</p>}
      </div>
      <div className="field-control">
        <input
          type="text"
          className="settings-text-input"
          value={val}
          placeholder="None configured"
          onChange={(e) => setVal(e.target.value)}
        />
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
        setPolling(false);
        setSt((prev: any) => ({ ...(prev || {}), phase: "restarting", ok: false }));
      }
    }, 2000);
    return () => clearInterval(t);
  }, [polling]);

  async function start() {
    if (
      !window.confirm(
        "Rebuild desktop bundle from local repo, update /Applications/OpenMuse.app, and relaunch? The application will quit itself once the build completes.",
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
  const running =
    polling ||
    starting ||
    (phase !== "idle" && phase !== "done" && phase !== "failed" && phase !== "restarting" && st?.started !== false);

  return (
    <div className="settings-self-update-block">
      <div className="settings-field-card column">
        <div className="field-info">
          <label className="field-label">Repository Checkout Path</label>
          <p className="field-description">
            Path to the local source code repository. Leave blank to auto-detect.
          </p>
        </div>
        <div className="self-update-input-group">
          <input
            className="settings-text-input"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="Auto-detect current repository path"
            spellCheck={false}
          />
          <button
            type="button"
            className="btn-primary update"
            onClick={start}
            disabled={starting || running}
          >
            <RefreshCwIcon size={14} className={running ? "spin" : ""} />
            <span>{starting ? "Starting..." : running ? "Building..." : "Build & Update App"}</span>
          </button>
        </div>
      </div>

      {err && <div className="modal-error-alert">{err}</div>}

      {(st || polling) && (
        <div className="update-status-banner">
          <div className="update-status-header">
            <span className="status-label">Build Phase:</span>
            <span className={`phase-badge ${phase}`}>{phase}</span>
            {st?.repo && <span className="repo-tag font-mono">{st.repo}</span>}
          </div>
          {phase === "restarting" && (
            <p className="update-note">Connection lost — the app is relaunching with the new build.</p>
          )}
          {phase === "done" && <p className="update-note success">Build completed successfully.</p>}
          {st?.error && <p className="update-note error">{st.error}</p>}
        </div>
      )}

      {!!st?.logTail && (
        <div className="update-log-terminal">
          <div className="terminal-header">Build Log Output</div>
          <pre className="terminal-content">{String(st.logTail).slice(-4000)}</pre>
        </div>
      )}
    </div>
  );
}

export default function SettingsView({ onClose }: { onClose?: () => void }) {
  const [activeTab, setActiveTab] = useState("model");

  const currentCategory = SETTINGS_CATEGORIES.find((c) => c.id === activeTab) || SETTINGS_CATEGORIES[0];

  return (
    <div className="settings-view-container">
      <div className="settings-sidebar">
        <div className="settings-sidebar-header">
          <SettingsIcon size={18} />
          <span>Preferences</span>
        </div>
        <nav className="settings-nav-list">
          {SETTINGS_CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            const isActive = cat.id === activeTab;
            return (
              <button
                key={cat.id}
                type="button"
                className={`settings-nav-item ${isActive ? "active" : ""}`}
                onClick={() => setActiveTab(cat.id)}
              >
                <Icon size={16} />
                <span>{cat.name}</span>
              </button>
            );
          })}
        </nav>
        {onClose && (
          <button type="button" className="settings-back-btn" onClick={onClose}>
            ← Back to Chat
          </button>
        )}
      </div>

      <div className="settings-main-pane">
        <div className="settings-pane-header">
          <h2 className="settings-pane-title">{currentCategory.name}</h2>
          <p className="settings-pane-subtitle">
            Configure engine and execution behaviors. Preferences are persisted locally on this machine.
          </p>
        </div>

        <div className="settings-pane-content">
          {activeTab === "updates" ? (
            <SelfUpdate />
          ) : (
            <div className="settings-fields-grid">
              {currentCategory.fields.map((field) => {
                switch (field.kind) {
                  case "select":
                    return <SettingSelect key={field.key} spec={field} />;
                  case "toggle":
                    return <SettingToggle key={field.key} spec={field} />;
                  case "flag":
                    return <SettingFlag key={field.key} spec={field} />;
                  case "number":
                    return <SettingNumber key={field.key} spec={field} />;
                  case "text":
                  default:
                    return <SettingText key={field.key} spec={field} />;
                }
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
