import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpIcon,
  CloseIcon,
  FileTextIcon,
  FolderIcon,
  PaperclipIcon,
  SlidersIcon,
  StopIcon,
  ChevronDownIcon,
  ShieldAlertIcon,
} from "./Icons";

export interface Attachment {
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

const DEFAULT_MODEL = "muse-spark-1.3";

export interface ModelOption {
  id: string;
  label: string;
}

const APPROVAL_LABELS: Record<string, string> = {
  denyUnmatched: "Deny unmatched",
  onRequest: "On request",
  promptUnmatched: "Prompt unmatched",
  allowAll: "Allow all",
};

export default function Composer({
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
  models: ModelOption[];
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const [popPos, setPopPos] = useState<{ left: number; bottom: number } | null>(null);

  // The composer card clips overflow (3D glint), so the popover is portaled
  // to the body and pinned above the settings pill.
  useEffect(() => {
    if (!settingsOpen) {
      setPopPos(null);
      return;
    }
    function place() {
      const el = settingsBtnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPopPos({
        left: Math.max(8, Math.min(r.left, window.innerWidth - 308)),
        bottom: Math.max(8, window.innerHeight - r.top + 12),
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [settingsOpen]);

  const readyCount = attachments.filter((a) => a.ready && !a.error).length;
  const canSend = !!input.trim() || readyCount > 0;
  const currentId = model || DEFAULT_MODEL;
  const modelOptions: ModelOption[] = models.some((m) => m.id === currentId)
    ? models
    : [{ id: currentId, label: currentId }, ...models];
  const approvalLabel = APPROVAL_LABELS[approvalMode] || approvalMode;
  const effortLabel = effort || "Default (high)";

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      setSettingsOpen(false);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      setSettingsOpen(false);
      if (canSend && !busy) {
        onSend();
      }
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 260)}px`;
    }
  }

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    cardRef.current.style.setProperty("--cursor-x", `${x}px`);
    cardRef.current.style.setProperty("--cursor-y", `${y}px`);
  }

  return (
    <div
      ref={cardRef}
      className={`composer-card-3d ${dragOver ? "drag-active" : ""} ${effort ? `effort-${effort}` : ""}`}
      onMouseMove={handleMouseMove}
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
      {/* Dynamic Specular Light Glint */}
      <div className="composer-specular-light" aria-hidden />

      {/* Attachments preview tray */}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a) => (
            <div key={a.id} className="attachment-chip-3d" title={a.error || `${a.name} · ${Math.round(a.size / 1024)} KB`}>
              {a.kind === "image" ? (
                a.dataUrl ? (
                  <img className="chip-preview-img" src={a.dataUrl} alt="" />
                ) : (
                  <div className="chip-loading-spinner" />
                )
              ) : (
                <div className="chip-preview-icon">
                  <FileTextIcon size={16} />
                </div>
              )}
              <div className="chip-meta">
                <span className="chip-name">{a.ready ? a.name : "Reading..."}</span>
                {a.error ? (
                  <span className="chip-error">{a.error}</span>
                ) : (
                  <span className="chip-size">{Math.round(a.size / 1024)} KB</span>
                )}
              </div>
              <button
                type="button"
                className="chip-remove-btn"
                onClick={() => onRemoveAttachment(a.id)}
                aria-label={`Remove ${a.name}`}
              >
                <CloseIcon size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main Textarea */}
      <div className="composer-input-wrapper">
        <textarea
          ref={textareaRef}
          id="composer-input"
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.files || [])];
            if (files.length > 0) {
              e.preventDefault();
              onAddFiles(files);
            }
          }}
          placeholder="Ask Muse anything, describe code to write or refactor... (Paste or drag files)"
          rows={2}
        />
      </div>

      {/* Toolbar actions row */}
      <div className="composer-toolbar">
        <div className="toolbar-left">
          {/* File attachment button */}
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
          <button
            type="button"
            className="action-pill-btn-3d"
            onClick={() => fileRef.current?.click()}
            title="Attach images, documents or code files"
          >
            <PaperclipIcon size={14} />
            <span className="action-pill-text">Attach</span>
          </button>

          {/* Working directory picker */}
          <button
            type="button"
            className="action-pill-btn-3d"
            onClick={onPickFolder}
            title={`Working directory: ${folderPath || "Server default"}`}
          >
            <FolderIcon size={14} />
            <span className="action-pill-text font-mono">{folderName}</span>
          </button>

          {/* Model / Effort / Approval popover toggle */}
          <div className="popover-anchor">
            <button
              ref={settingsBtnRef}
              type="button"
              className={`action-pill-btn-3d ${settingsOpen ? "active" : ""}`}
              onClick={() => setSettingsOpen((v) => !v)}
              title="Configure model, effort level, and tool approvals"
            >
              <SlidersIcon size={12} />
              <span className="action-pill-text">{model}</span>
              {effort && <span className={`effort-badge effort-${effort}`}>{effortLabel}</span>}
              {approvalMode === "allowAll" && (
                <span className="approval-badge-warning" title="Allow-all mode is enabled: tools run without confirmation">
                  Allow all
                </span>
              )}
              <ChevronDownIcon size={12} className={`pill-chevron ${settingsOpen ? "open" : ""}`} />
            </button>

            {settingsOpen &&
              popPos &&
              createPortal(
                <>
                  <div className="modal-backdrop-transparent" onClick={() => setSettingsOpen(false)} />
                  <div
                    className="composer-popover-3d popover-portal"
                    style={{ left: popPos.left, bottom: popPos.bottom }}
                  >
                    <div className="popover-header">
                      <span className="popover-title">Execution Settings</span>
                    </div>

                    <div className="popover-field">
                      <div className="popover-field-label">
                        <span>Model</span>
                        <span className="popover-field-hint">
                          {models.length === 0 ? "Catalog unavailable — current only" : "Pinned for this session"}
                        </span>
                      </div>
                      <select
                        className="popover-select"
                        value={model}
                        onChange={(e) => onModel(e.target.value)}
                      >
                        {modelOptions.map((m) => (
                          <option key={m.id} value={m.id} title={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </div>

                  <div className="popover-field">
                    <div className="popover-field-label">
                      <span>Reasoning Effort</span>
                      <span className="popover-field-hint">Controls thinking depth</span>
                    </div>
                    <select
                      className="popover-select"
                      value={effort}
                      onChange={(e) => onEffort(e.target.value)}
                    >
                      <option value="">Default (high)</option>
                      <option value="none">None</option>
                      <option value="minimal">Minimal</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="xhigh">Extra High</option>
                      <option value="ultra">Ultra</option>
                    </select>
                  </div>

                  <div className="popover-field">
                    <div className="popover-field-label">
                      <span>Tool Approval</span>
                      <span className="popover-field-hint">Action confirmation policy</span>
                    </div>
                    <select
                      className="popover-select"
                      value={approvalMode}
                      onChange={(e) => onApproval(e.target.value)}
                    >
                      <option value="denyUnmatched">Deny unmatched</option>
                      <option value="onRequest">On request</option>
                      <option value="promptUnmatched">Prompt unmatched</option>
                      <option value="allowAll">Allow all</option>
                    </select>
                    {approvalMode === "allowAll" && (
                      <div className="popover-warning-note">
                        <ShieldAlertIcon size={13} />
                        <span>Tools execute automatically without prompting.</span>
                      </div>
                    )}
                    </div>
                  </div>
                </>,
                document.body,
              )}
          </div>
        </div>

        <div className="toolbar-right">
          <span className="keyboard-shortcut-hint">
            <kbd>↵</kbd> send · <kbd>⇧↵</kbd> newline
          </span>

          {busy ? (
            <button
              type="button"
              className="stop-execution-btn-3d"
              onClick={onStop}
              title="Interrupt and stop response generation"
            >
              <span className="stop-square-indicator" />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="button"
              className={`send-message-btn-3d ${canSend ? "ready" : ""}`}
              onClick={() => {
                setSettingsOpen(false);
                onSend();
              }}
              disabled={!canSend}
              aria-label="Send message"
              title={canSend ? "Send (Enter)" : "Enter a prompt or attach files"}
            >
              <ArrowUpIcon size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
