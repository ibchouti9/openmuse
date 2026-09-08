import { useCallback, useEffect, useState } from "react";
import { CloseIcon, RefreshCwIcon } from "./Icons";

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

export default function AutomationsView({
  onClose,
  loader = loadMockAutomations,
}: {
  onClose: () => void;
  loader?: () => Promise<AutomationDef[]>;
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [defs, setDefs] = useState<AutomationDef[]>([]);
  const [attempt, setAttempt] = useState(0);

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
          <p className="automations-subtitle">Scheduled runs (mock data — step 1)</p>
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
          {defs.map((d) => (
            <div key={d.automationId} className="automation-row">
              <span className={`auto-status-pill ${outcomeClass(d)}`} title={outcomeLabel(d)}>
                <span className="auto-status-dot" aria-hidden="true" />
                <span>{outcomeLabel(d)}</span>
              </span>
              <div className="automation-main">
                <span className="automation-name">{d.name}</span>
                <span className="automation-meta font-mono">
                  every {d.everyMinutes}m · {d.enabled ? "enabled" : "disabled"}
                </span>
                <span className="automation-prompt">{d.prompt}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
