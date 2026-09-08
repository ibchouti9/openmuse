import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon, CloseIcon, RefreshCwIcon } from "./Icons";

// Subset of Kernel's server contracts (PRs #10-13). Step 1 is read-only and
// mock-first: the default loader returns sample defs; step 2 swaps in the
// real GET /api/automations + GET /api/automations/runs join.
export interface AutomationDef {
  automationId: string;
  name: string;
  everyMinutes: number;
  sessionId: string;
  prompt: string;
  enabled: boolean;
  webhookUrl?: string | null;
  lastOutcome?: "completed" | "failed" | "cancelled" | "skipped" | "started" | null;
}

const MOCK_DEFS: AutomationDef[] = [
  {
    automationId: "auto-morning-digest",
    name: "Morning digest",
    everyMinutes: 1440,
    sessionId: "new",
    prompt: "Summarize overnight commits and open PRs.",
    enabled: true,
    lastOutcome: "completed",
  },
  {
    automationId: "auto-flaky-watch",
    name: "Flaky test watch",
    everyMinutes: 30,
    sessionId: "new",
    prompt: "Run the unit suite and report new failures.",
    enabled: true,
    lastOutcome: "failed",
  },
  {
    automationId: "auto-changelog-draft",
    name: "Changelog draft",
    everyMinutes: 60,
    sessionId: "new",
    prompt: "Draft changelog entries from today's diff.",
    enabled: false,
    lastOutcome: null,
  },
];

function loadMockAutomations(): Promise<AutomationDef[]> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(MOCK_DEFS), 400);
  });
}

export interface AutomationRun {
  runId: string;
  automationId: string;
  createdAt: string;
  durationMs?: number | null;
  outcome: "completed" | "failed" | "cancelled" | "skipped" | "started";
  sessionId?: string | null;
  error?: string | null;
}

const now = Date.now();

const MOCK_RUNS: AutomationRun[] = [
  {
    runId: "run-morning-3",
    automationId: "auto-morning-digest",
    createdAt: new Date(now - 5 * 3600 * 1000).toISOString(),
    durationMs: 42000,
    outcome: "completed",
    sessionId: "mock-session-9",
  },
  {
    runId: "run-morning-2",
    automationId: "auto-morning-digest",
    createdAt: new Date(now - 29 * 3600 * 1000).toISOString(),
    durationMs: 51000,
    outcome: "completed",
    sessionId: "mock-session-4",
  },
  {
    runId: "run-flaky-7",
    automationId: "auto-flaky-watch",
    createdAt: new Date(now - 22 * 60 * 1000).toISOString(),
    durationMs: 180000,
    outcome: "failed",
    sessionId: "mock-session-7",
    error: "3 new failures in auth suite",
  },
  {
    runId: "run-flaky-6",
    automationId: "auto-flaky-watch",
    createdAt: new Date(now - 52 * 60 * 1000).toISOString(),
    durationMs: 9000,
    outcome: "skipped",
    sessionId: null,
    error: "previous run still live",
  },
];

function loadMockRuns(automationId: string): Promise<AutomationRun[]> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(MOCK_RUNS.filter((r) => r.automationId === automationId)), 300);
  });
}

// Mock toggle: resolves after a beat. Real PATCH /api/automations/:id
// integration follows once Kernel PR #13 lands on main.
function mockToggleAutomation(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 300);
  });
}

function runOutcomeClass(outcome: AutomationRun["outcome"]): string {
  if (outcome === "completed") return "is-ok";
  if (outcome === "failed") return "is-failed";
  if (outcome === "started") return "is-running";
  return "";
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(ms?: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function outcomeClass(d: AutomationDef): string {
  if (!d.enabled) return "";
  if (d.lastOutcome === "completed") return "is-ok";
  if (d.lastOutcome === "failed") return "is-failed";
  if (d.lastOutcome === "started") return "is-running";
  return "";
}

function outcomeLabel(d: AutomationDef): string {
  if (!d.enabled) return "Disabled";
  if (d.lastOutcome === "completed") return "Last run ok";
  if (d.lastOutcome === "failed") return "Last run failed";
  if (d.lastOutcome === "cancelled") return "Last run cancelled";
  if (d.lastOutcome === "skipped") return "Last run skipped";
  if (d.lastOutcome === "started") return "Running";
  return "Never run";
}

function cadenceLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "Manual";
  if (minutes < 60) return `Every ${minutes} min`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) {
    if (hours === 1) return "Hourly";
    if (hours === 24) return "Daily";
    return `Every ${hours} hours`;
  }
  return `Every ${minutes} min`;
}

export default function AutomationsView({
  onClose,
  loader = loadMockAutomations,
  onToggle = mockToggleAutomation,
  runsLoader = loadMockRuns,
}: {
  onClose: () => void;
  loader?: () => Promise<AutomationDef[]>;
  onToggle?: (automationId: string, enabled: boolean) => Promise<void>;
  runsLoader?: (automationId: string) => Promise<AutomationRun[]>;
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [defs, setDefs] = useState<AutomationDef[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runsById, setRunsById] = useState<Record<string, AutomationRun[]>>({});
  const [runsPendingId, setRunsPendingId] = useState<string | null>(null);

  async function toggleHistory(d: AutomationDef) {
    if (expandedId === d.automationId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(d.automationId);
    if (runsById[d.automationId]) return;
    setRunsPendingId(d.automationId);
    try {
      const runs = await runsLoader(d.automationId);
      setRunsById((m) => ({ ...m, [d.automationId]: runs }));
    } catch {
      setRunsById((m) => ({ ...m, [d.automationId]: [] }));
    } finally {
      setRunsPendingId(null);
    }
  }

  async function flip(d: AutomationDef) {
    if (pendingId !== null) return;
    setToggleError(null);
    setPendingId(d.automationId);
    setDefs((xs) => xs.map((x) => (x.automationId === d.automationId ? { ...x, enabled: !x.enabled } : x)));
    try {
      await onToggle(d.automationId, !d.enabled);
    } catch {
      // Revert the optimistic flip so the row never lies about server state.
      setDefs((xs) => xs.map((x) => (x.automationId === d.automationId ? { ...x, enabled: d.enabled } : x)));
      setToggleError(`Couldn't ${d.enabled ? "disable" : "enable"} "${d.name}" — try again.`);
    } finally {
      setPendingId(null);
    }
  }

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      setDefs(await loader());
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, [loader, attempt]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="automations-view" role="region" aria-label="Automations">
      <div className="automations-header">
        <div>
          <h2 className="automations-title">Automations</h2>
          <p className="automations-subtitle">Scheduled prompts that run on their own</p>
        </div>
        <button type="button" className="topbar-icon-btn" onClick={onClose} title="Back to chat" aria-label="Back to chat">
          <CloseIcon size={14} />
        </button>
      </div>

      {phase === "loading" && (
        <div className="automations-list" aria-live="polite" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="automation-row is-skeleton" aria-hidden="true">
              <div className="skeleton-line short" />
              <div className="skeleton-line" />
            </div>
          ))}
        </div>
      )}

      {phase === "error" && (
        <div className="automations-empty" role="alert">
          <p className="automations-empty-title">Couldn&apos;t load automations</p>
          <p className="automations-empty-desc">Check the server and try again.</p>
          <button
            type="button"
            className="user-edit-btn primary"
            onClick={() => setAttempt((a) => a + 1)}
          >
            <RefreshCwIcon size={13} /> Retry
          </button>
        </div>
      )}

      {phase === "ready" && defs.length === 0 && (
        <div className="automations-empty">
          <p className="automations-empty-title">No automations yet</p>
          <p className="automations-empty-desc">
            Schedule a prompt to run on its own — the builder lands in a later step.
          </p>
        </div>
      )}

      {phase === "ready" && defs.length > 0 && (
        <div className="automations-list" aria-live="polite">
          {toggleError && (
            <p className="automations-note-error" role="alert">
              {toggleError}
            </p>
          )}
          {defs.map((d) => {
            const expanded = expandedId === d.automationId;
            const runs = runsById[d.automationId];
            return (
            <div key={d.automationId} className="automation-row-wrap">
            <div className="automation-row">
              <span className={`auto-status-pill ${outcomeClass(d)}`} title={outcomeLabel(d)}>
                <span className="auto-status-dot" aria-hidden="true" />
                <span>{outcomeLabel(d)}</span>
              </span>
              <div className="automation-main">
                <span className="automation-name">{d.name}</span>
                <span className="automation-meta font-mono">
                  {cadenceLabel(d.everyMinutes)} · {d.enabled ? "enabled" : "disabled"}
                </span>
                <span className="automation-prompt">{d.prompt}</span>
              </div>
              <button
                type="button"
                className={`automation-history-btn ${expanded ? "open" : ""}`}
                aria-expanded={expanded}
                aria-label={`${expanded ? "Hide" : "Show"} run history for ${d.name}`}
                title={`${expanded ? "Hide" : "Show"} run history`}
                onClick={() => void toggleHistory(d)}
              >
                <ChevronDownIcon size={14} />
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={d.enabled}
                aria-label={`${d.enabled ? "Disable" : "Enable"} ${d.name}`}
                className={`automation-switch ${d.enabled ? "on" : "off"}`}
                disabled={pendingId !== null}
                onClick={() => void flip(d)}
              >
                <span className="automation-switch-thumb" aria-hidden="true" />
              </button>
            </div>
            {expanded && (
              <div className="automation-history" aria-live="polite">
                {runsPendingId === d.automationId || runs === undefined ? (
                  <p className="automation-history-loading">Loading runs…</p>
                ) : runs.length === 0 ? (
                  <p className="automation-history-loading">No runs yet for this automation.</p>
                ) : (
                  runs.map((r) => (
                    <div key={r.runId} className="automation-run-row">
                      <span className={`auto-status-pill ${runOutcomeClass(r.outcome)}`} title={`Run ${r.outcome}`}>
                        <span className="auto-status-dot" aria-hidden="true" />
                        <span>{r.outcome}</span>
                      </span>
                      <span className="automation-run-meta font-mono">
                        {fmtTime(r.createdAt)} · {fmtDuration(r.durationMs)}
                        {r.sessionId ? ` · ${r.sessionId.slice(0, 13)}` : ""}
                      </span>
                      {r.error && <span className="automation-run-error">{r.error}</span>}
                    </div>
                  ))
                )}
              </div>
            )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
