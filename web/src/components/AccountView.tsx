import { useEffect, useState } from "react";
import { ops } from "../api";
import {
  CpuIcon,
  FolderIcon,
  ShieldAlertIcon,
  SlidersIcon,
  UserIcon,
} from "./Icons";

export default function AccountView({
  model,
  effort,
  approvalMode,
  workspace,
  onClose,
}: {
  model: string;
  effort: string;
  approvalMode: string;
  workspace: string;
  onClose?: () => void;
}) {
  const [cfgOut, setCfgOut] = useState<any>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);

  // Auth form states
  const [actionOut, setActionOut] = useState<any>(null);
  const [key, setKey] = useState("");
  const [provider, setProvider] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  useEffect(() => {
    ops.configStatus().then(setCfgOut).catch((e: Error) => setCfgErr(e.message));
  }, []);

  const storedProvider = localStorage.getItem("openmuse.provider") || "meta (default)";

  async function handleStoreKey() {
    if (!key.trim()) return;
    setAuthBusy(true);
    setActionOut(null);
    try {
      const res = await ops.authSet(key.trim(), provider.trim() || undefined);
      setKey("");
      setActionOut(res);
    } catch (e: any) {
      setActionOut({ error: e.message });
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    if (!window.confirm("Log out of the current provider session?")) return;
    setAuthBusy(true);
    try {
      const res = await ops.authLogout();
      setActionOut(res);
    } catch (e: any) {
      setActionOut({ error: e.message });
    } finally {
      setAuthBusy(false);
    }
  }

  return (
    <div className="account-view-container">
      <div className="account-header-bar">
        <div className="account-header-info">
          <div className="account-avatar-large">
            <UserIcon size={24} />
          </div>
          <div>
            <h2 className="account-view-title">Account & Credentials</h2>
            <p className="account-view-subtitle">
              Manage your local Muse profile, environment defaults, and provider API keys.
            </p>
          </div>
        </div>
        {onClose && (
          <button type="button" className="settings-back-btn" onClick={onClose}>
            ← Back to Chat
          </button>
        )}
      </div>

      <div className="account-content-sections">
        {/* Profile Card */}
        <div className="account-section-card">
          <h3 className="section-card-title">Active Profile Defaults</h3>
          <p className="section-card-desc">Current session runtime configuration.</p>

          <div className="profile-stats-grid">
            <div className="profile-stat-box">
              <div className="stat-label">
                <SlidersIcon size={14} />
                <span>Provider</span>
              </div>
              <span className="stat-value font-mono">{storedProvider}</span>
            </div>

            <div className="profile-stat-box">
              <div className="stat-label">
                <CpuIcon size={14} />
                <span>Default Model</span>
              </div>
              <span className="stat-value font-mono">{model}</span>
            </div>

            <div className="profile-stat-box">
              <div className="stat-label">
                <SlidersIcon size={14} />
                <span>Reasoning Effort</span>
              </div>
              <span className="stat-value font-mono">{effort || "Default (high)"}</span>
            </div>

            <div className="profile-stat-box">
              <div className="stat-label">
                <ShieldAlertIcon size={14} />
                <span>Approval Mode</span>
              </div>
              <span className="stat-value font-mono">{approvalMode}</span>
            </div>

            <div className="profile-stat-box full-width">
              <div className="stat-label">
                <FolderIcon size={14} />
                <span>Workspace Directory</span>
              </div>
              <span className="stat-value font-mono" title={workspace}>
                {workspace || "Server default"}
              </span>
            </div>
          </div>
        </div>

        {/* Credentials and Auth */}
        <div className="account-section-card">
          <h3 className="section-card-title">Provider Authentication</h3>
          <p className="section-card-desc">
            Credentials are kept safe on this local machine. You can also authenticate directly in terminal via <code>muse login</code> (Meta-account browser approval; <code>META_API_KEY</code> always takes priority over the account login).
          </p>

          <div className="credentials-form-grid">
            <div className="form-input-group">
              <label className="field-label">API Key / Secret Token</label>
              <input
                type="password"
                className="settings-text-input"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Enter API key..."
                autoComplete="off"
              />
            </div>

            <div className="form-input-group">
              <label className="field-label">Provider Name (Optional, default: meta)</label>
              <input
                type="text"
                className="settings-text-input"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                placeholder="meta (only accepted value)"
              />
            </div>

            <div className="credentials-action-buttons">
              <button
                type="button"
                className="btn-primary"
                onClick={handleStoreKey}
                disabled={authBusy || !key.trim()}
              >
                Save API Key
              </button>
              <button
                type="button"
                className="btn-danger-ghost"
                onClick={handleLogout}
                disabled={authBusy}
              >
                Log Out
              </button>
            </div>
          </div>

          {actionOut && (
            <div className="auth-response-box">
              <div className="terminal-header">Authentication Response</div>
              <pre className="terminal-content">
                {JSON.stringify(actionOut, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Server Config Status */}
        {cfgOut && (
          <div className="account-section-card">
            <h3 className="section-card-title">Enterprise Configuration Status</h3>
            <pre className="terminal-content host-config">
              {JSON.stringify(cfgOut, null, 2)}
            </pre>
          </div>
        )}

        {cfgErr && <div className="modal-error-alert">{cfgErr}</div>}
      </div>
    </div>
  );
}
