import { useState } from "react";
import { CheckIcon, SparklesIcon } from "./Icons";

export interface Question {
  id: string;
  header: string;
  question: string;
  selection: { mode: string; minSelections?: number; maxSelections?: number };
  options: { label: string; description?: string }[];
}

export interface InputPrompt {
  userInputId: string;
  sessionId: string;
  toolName: string;
  questions: Question[];
  settled?: boolean;
}

function questionBounds(qq: Question): { min: number; max: number } {
  const multi = qq.selection.mode === "multiple";
  const min = qq.selection.minSelections ?? 1;
  const max = qq.selection.maxSelections ?? (multi ? qq.options.length : 1);
  return { min, max };
}

function questionReady(qq: Question, sel: string[], ft: string): boolean {
  if (ft.trim()) return true;
  const { min, max } = questionBounds(qq);
  return sel.length >= min && sel.length <= max;
}

function requirementText(qq: Question, count: number, overridden: boolean): string {
  if (overridden) return "Custom text response entered";
  const { min, max } = questionBounds(qq);
  if (min === max) return `${count} of ${max} selected`;
  return `${count} selected (${min}–${max} required)`;
}

export default function QuestionCard({
  q,
  onAnswer,
  onCancel,
}: {
  q: InputPrompt;
  onAnswer: (answers: any[]) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState<Record<string, string>>({});

  function toggle(qid: string, label: string, multi: boolean, max: number) {
    setPicked((p) => {
      const cur = p[qid] || [];
      if (cur.includes(label)) return { ...p, [qid]: cur.filter((l) => l !== label) };
      if (multi) {
        if (cur.length >= max) return p;
        return { ...p, [qid]: [...cur, label] };
      }
      return { ...p, [qid]: [label] };
    });
  }

  const allReady = q.questions.every((qq) =>
    questionReady(qq, picked[qq.id] || [], free[qq.id] || ""),
  );

  function submit() {
    if (!allReady) return;
    const answers = q.questions.map((qq) => {
      const ft = (free[qq.id] || "").trim();
      if (ft) return { questionId: qq.id, value: ft, mode: "freeText" };
      return { questionId: qq.id, values: picked[qq.id] || [], mode: "selection" };
    });
    onAnswer(answers);
  }

  return (
    <div className="question-card-3d">
      <div className="question-specular-edge" aria-hidden />
      <div className="question-card-header">
        <div className="question-badge-icon">
          <SparklesIcon size={16} />
        </div>
        <div className="question-header-text">
          <span className="question-title">Input Needed</span>
          <span className="question-subtitle">from {q.toolName || "Muse"}</span>
        </div>
      </div>

      <div className="questions-list">
        {q.questions.map((qq) => {
          const multi = qq.selection.mode === "multiple";
          const bounds = questionBounds(qq);
          const sel = picked[qq.id] || [];
          const ft = free[qq.id] || "";
          const hasFree = !!ft.trim();

          return (
            <div key={qq.id} className="question-block">
              <h4 className="question-text">{qq.question || qq.header}</h4>
              <p className="question-requirement-hint">{requirementText(qq, sel.length, hasFree)}</p>

              <div className="question-options-grid">
                {qq.options.map((opt) => {
                  const isSelected = sel.includes(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      className={`question-option-btn ${isSelected ? "selected" : ""} ${hasFree ? "disabled" : ""}`}
                      onClick={() => toggle(qq.id, opt.label, multi, bounds.max)}
                      disabled={hasFree}
                    >
                      <div className={`option-control-check ${multi ? "checkbox" : "radio"}`}>
                        {isSelected && <CheckIcon size={12} />}
                      </div>
                      <div className="option-label-wrapper">
                        <span className="option-label-text">{opt.label}</span>
                        {opt.description && <span className="option-desc-text">{opt.description}</span>}
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="question-freetext-wrapper">
                <input
                  className="question-freetext-input"
                  value={ft}
                  onChange={(e) => setFree((f) => ({ ...f, [qq.id]: e.target.value }))}
                  placeholder="Or type a custom answer..."
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="question-actions-row">
        <button
          type="button"
          className="question-submit-btn"
          disabled={!allReady}
          onClick={submit}
        >
          Submit Response
        </button>
        <button type="button" className="question-cancel-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
