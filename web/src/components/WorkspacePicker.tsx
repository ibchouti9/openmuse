import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import {
  CloseIcon,
  FolderIcon,
  SearchIcon,
  ChevronRightIcon,
  CheckIcon,
} from "./Icons";

export default function WorkspacePicker({
  initial,
  onPick,
  onClose,
}: {
  initial: string;
  onPick: (p: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState(initial);
  const [entries, setEntries] = useState<{ name: string; path: string }[]>([]);
  const [filter, setFilter] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (p: string) => {
    setErr(null);
    setLoading(true);
    try {
      const r = await api(`/api/dirs?path=${encodeURIComponent(p || "~")}`);
      setPath(r.path);
      setEntries(r.entries || []);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(initial || "~");
  }, [load, initial]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const crumbs = path.split("/").filter(Boolean);
  const shown = filter
    ? entries.filter((d) => d.name.toLowerCase().includes(filter.toLowerCase()))
    : entries;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-dialog-card workspace-picker-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-dialog-header">
          <div className="modal-header-info">
            <div className="modal-icon-badge">
              <FolderIcon size={18} />
            </div>
            <div>
              <h3 className="modal-dialog-title">Select Working Folder</h3>
              <p className="modal-dialog-subtitle">
                Muse reads, writes, and executes tools within this folder.
              </p>
            </div>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close modal">
            <CloseIcon size={16} />
          </button>
        </div>

        {/* Breadcrumbs */}
        <div className="workspace-breadcrumbs-bar">
          <button
            type="button"
            className={`breadcrumb-item root ${crumbs.length === 0 ? "active" : ""}`}
            onClick={() => load("/")}
          >
            /
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="breadcrumb-segment">
              <ChevronRightIcon size={12} className="breadcrumb-separator" />
              <button
                type="button"
                className={`breadcrumb-item ${i === crumbs.length - 1 ? "active" : ""}`}
                onClick={() => load("/" + crumbs.slice(0, i + 1).join("/"))}
              >
                {c}
              </button>
            </span>
          ))}
        </div>

        {/* Search input */}
        <div className="workspace-search-bar">
          <SearchIcon size={14} className="search-bar-icon" />
          <input
            className="workspace-filter-input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search subfolders..."
            autoFocus
          />
          {filter && (
            <button type="button" className="search-clear-btn" onClick={() => setFilter("")}>
              <CloseIcon size={12} />
            </button>
          )}
        </div>

        {err && <div className="modal-error-alert">{err}</div>}

        {/* Directory listing */}
        <div className="workspace-folder-list">
          {loading && (
            <div className="folder-list-loading">
              <div className="loading-spinner-ring" />
              <span>Scanning directories...</span>
            </div>
          )}
          {!loading &&
            shown.map((d) => (
              <button
                key={d.path}
                type="button"
                className="folder-entry-row"
                onClick={() => load(d.path)}
                title={d.path}
              >
                <FolderIcon size={16} className="folder-entry-icon" />
                <span className="folder-entry-name">{d.name}</span>
                <ChevronRightIcon size={13} className="folder-entry-arrow" />
              </button>
            ))}
          {!loading && shown.length === 0 && !err && (
            <div className="folder-empty-state">
              <FolderIcon size={24} />
              <span>No subfolders found</span>
            </div>
          )}
        </div>

        {/* Modal footer */}
        <div className="modal-dialog-footer">
          <div className="current-path-preview" title={path}>
            <span className="current-path-label">Selected:</span>
            <span className="current-path-value">{path || "..."}</span>
          </div>
          <div className="footer-action-buttons">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => onPick(path)}
            >
              <CheckIcon size={14} />
              <span>Select Folder</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
