import { useState } from "react";
import { ShieldAlertIcon, TerminalIcon, ChevronRightIcon } from "./Icons";

export interface Choice {
  choiceId: string;
  label: string;
  decision: string;
  scope: string;
  acceptsFeedback?: boolean;
  rulePreview?: string;
}

export interface Approval {
  approvalId: string;
  sessionId: string;
  toolName: string;
  subject: any;
  rawArgs?: string;
  availableChoices: Choice[];
  currentRequirementId: unknown;
  settled?: boolean;
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

function choiceText(c: Choice): string {
  return `${c.decision || ""} ${c.choiceId || ""} ${c.label || ""}`.toLowerCase();
}

function isDestructiveChoice(c: Choice): boolean {
  return /abort|deny|denied|reject|revoke|never|stop|cancel/.test(choiceText(c));
}

function isAllowChoice(c: Choice): boolean {
  return /approv|allow|accept|always|once|confirm|proceed|continue/.test(choiceText(c));
}

export default function ApprovalCard({
  a,
  onDecide,
}: {
  a: Approval;
  onDecide: (a: Approval, choiceId: string, feedback?: string) => void | Promise<void>;
}) {
  const [feedback, setFeedback] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [showArgs, setShowArgs] = useState(false);

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

  const subjectText = renderSubject(a.subject);

  return (
    <div
      className="approval-card-3d"
      role="group"
      aria-label={`Approval request for ${a.toolName}`}
      aria-busy={busy}
      onKeyDown={onKeyDown}
    >
      <div className="approval-specular-edge" aria-hidden />
      <div className="approval-card-header">
        <div className="approval-badge-icon">
          <ShieldAlertIcon size={16} />
        </div>
        <div className="approval-header-text">
          <span className="approval-title">Action Approval Required</span>
          <span className="approval-subtitle">Tool: {a.toolName}</span>
        </div>
      </div>

      {subjectText && (
        <div className="approval-command-box">
          <div className="command-box-label">
            <TerminalIcon size={13} />
            <span>Command Preview</span>
          </div>
          <pre className="command-box-content">{subjectText}</pre>
        </div>
      )}

      {a.rawArgs && (
        <div className="approval-details-toggle">
          <button
            type="button"
            className="details-toggle-btn"
            onClick={() => setShowArgs((v) => !v)}
          >
            <ChevronRightIcon size={14} className={showArgs ? "rotated" : ""} />
            <span>Detailed Arguments</span>
          </button>
          {showArgs && <pre className="details-box-content">{a.rawArgs}</pre>}
        </div>
      )}

      {choices.map((c) => c.rulePreview).filter(Boolean)[0] && (
        <p className="approval-rule-note">{choices.map((c) => c.rulePreview).filter(Boolean)[0]}</p>
      )}

      {canFeedback && (
        <div className="approval-feedback-wrapper">
          <input
            className="approval-feedback-input"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={`Optional feedback / instructions for ${feedbackLabel}...`}
            aria-label="Feedback to the model"
            disabled={busy}
          />
        </div>
      )}

      <div className="approval-actions-row">
        {choices.map((c, i) => {
          const kind = isDestructiveChoice(c) ? "destructive" : isAllowChoice(c) ? "primary" : "secondary";
          return (
            <button
              key={c.choiceId}
              type="button"
              className={`approval-choice-btn ${kind}`}
              disabled={busy}
              aria-label={`${c.label || c.choiceId} (press ${i + 1} of ${choices.length})`}
              title={i < 9 ? `Press ${i + 1} on keyboard` : undefined}
              onClick={() => pick(i)}
            >
              {i < 9 && <kbd className="choice-kbd-key">{i + 1}</kbd>}
              <span>{c.label || c.choiceId}</span>
            </button>
          );
        })}
        {choices.length === 0 && <span className="approval-waiting-hint">Waiting for host decisions...</span>}
      </div>
    </div>
  );
}
