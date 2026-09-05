import { useEffect, useRef, useState } from "react";
import {
  CameraIcon,
  CloseIcon,
  ExternalLinkIcon,
  GlobeIcon,
  RefreshCwIcon,
} from "./components/Icons";

declare global {
  interface Window {
    openmuse?: {
      desktop?: boolean;
      captureBrowser?: (guestId: number) => Promise<{ dataUrl: string }>;
      openBrowserDevTools?: (guestId: number) => Promise<void>;
      openExternal?: (url: string) => Promise<void>;
    };
  }
}

const IS_DESKTOP = typeof window !== "undefined" && !!window.openmuse?.desktop;
const WebviewTag: any = "webview";

const PRESETS = [
  { label: "localhost:3000", url: "http://localhost:3000/" },
  { label: "localhost:5173", url: "http://localhost:5173/" },
  { label: "localhost:5174", url: "http://localhost:5174/" },
  { label: "localhost:8000", url: "http://localhost:8000/" },
  { label: "localhost:8080", url: "http://localhost:8080/" },
  { label: "localhost:3101", url: "http://localhost:3101/" },
];

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) return t;
  return `http://${t}`;
}

function shotName(src: string): string {
  let host = "page";
  try {
    host = new URL(src).hostname || "page";
  } catch {
    /* keep default */
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `browser-${host}-${stamp}.png`;
}

export default function BrowserPanel({
  onAttach,
  onClose,
}: {
  onAttach: (dataUrl: string, name: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState(() => {
    try {
      return localStorage.getItem("openmuse.browserUrl") || "";
    } catch {
      return "";
    }
  });
  const [src, setSrc] = useState(() => {
    try {
      return localStorage.getItem("openmuse.browserUrl") || "";
    } catch {
      return "";
    }
  });
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [nav, setNav] = useState({ back: false, fwd: false });
  const [zoom, setZoom] = useState(1);
  const [shot, setShot] = useState<string | null>(null);
  const [shotBusy, setShotBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const webRef = useRef<any>(null);

  function go(raw: string) {
    const url = normalizeUrl(raw);
    if (!url) return;
    setErr(null);
    setLoading(true);
    setShot(null);
    setInput(url);
    setSrc(url);
    setFrameKey((k) => k + 1);
    try {
      localStorage.setItem("openmuse.browserUrl", url);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    const wv = webRef.current;
    if (!IS_DESKTOP || !wv || !src) return;
    const syncNav = () => {
      try {
        setNav({ back: !!wv.canGoBack(), fwd: !!wv.canGoForward() });
      } catch {
        /* guest not ready */
      }
      try {
        const u = wv.getURL();
        if (u) {
          setInput(u);
          try {
            localStorage.setItem("openmuse.browserUrl", u);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    };
    const onStart = () => {
      setLoading(true);
      setErr(null);
    };
    const onStop = () => {
      setLoading(false);
      syncNav();
    };
    const onTitle = (e: any) => {
      if (e && e.title) setTitle(String(e.title));
    };
    const onFail = (e: any) => {
      if (e && e.errorCode === -3) return;
      setLoading(false);
      setErr(`Failed to load (${e?.errorCode ?? "?"}): ${e?.errorDescription || "unknown error"}`);
    };
    wv.addEventListener("did-start-loading", onStart);
    wv.addEventListener("did-stop-loading", onStop);
    wv.addEventListener("did-navigate", syncNav);
    wv.addEventListener("did-navigate-in-page", syncNav);
    wv.addEventListener("page-title-updated", onTitle);
    wv.addEventListener("did-fail-load", onFail);
    return () => {
      wv.removeEventListener("did-start-loading", onStart);
      wv.removeEventListener("did-stop-loading", onStop);
      wv.removeEventListener("did-navigate", syncNav);
      wv.removeEventListener("did-navigate-in-page", syncNav);
      wv.removeEventListener("page-title-updated", onTitle);
      wv.removeEventListener("did-fail-load", onFail);
    };
  }, [src]);

  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setLoading(false), 30000);
    return () => clearTimeout(t);
  }, [loading, src, frameKey]);

  function guestId(): number | null {
    const id = webRef.current?.getWebContentsId?.();
    return typeof id === "number" ? id : null;
  }

  async function screenshot() {
    setErr(null);
    if (!IS_DESKTOP || !window.openmuse?.captureBrowser) {
      setErr("Screenshots require the OpenMuse desktop app.");
      return;
    }
    const id = guestId();
    if (id == null) {
      setErr("Browser preview is not ready yet.");
      return;
    }
    setShotBusy(true);
    try {
      const r = await window.openmuse.captureBrowser(id);
      setShot(r.dataUrl);
    } catch (e: any) {
      setErr(e?.message || "Screenshot capture failed");
    } finally {
      setShotBusy(false);
    }
  }

  async function toggleDevTools() {
    const id = guestId();
    if (id == null || !window.openmuse?.openBrowserDevTools) return;
    try {
      await window.openmuse.openBrowserDevTools(id);
    } catch (e: any) {
      setErr(e?.message || "DevTools launch failed");
    }
  }

  function openExternal() {
    if (!src) return;
    if (window.openmuse?.openExternal) void window.openmuse.openExternal(src);
    else window.open(src, "_blank", "noopener");
  }

  function setZoomLevel(z: number) {
    const clamped = Math.min(2.5, Math.max(0.5, Math.round(z * 100) / 100));
    setZoom(clamped);
    try {
      webRef.current?.setZoomFactor?.(clamped);
    } catch {
      /* web-only mode has no zoom API */
    }
  }

  function downloadShot() {
    if (!shot) return;
    const a = document.createElement("a");
    a.href = shot;
    a.download = shotName(src);
    a.click();
  }

  const canGo = !!input.trim();

  return (
    <section className="browser-pane" aria-label="Web Inspector & Preview">
      {/* Top Header */}
      <div className="browser-pane-header">
        <div className="browser-title-group">
          <GlobeIcon size={14} className="browser-header-globe" />
          <span className="browser-header-title" title={title || src || "Browser Preview"}>
            {loading ? "Loading..." : title || "Browser Preview"}
          </span>
        </div>
        <div className="browser-header-actions">
          <button
            type="button"
            className="browser-icon-btn"
            onClick={() => screenshot()}
            disabled={shotBusy || !src}
            title="Capture page screenshot"
          >
            <CameraIcon size={14} />
            <span className="btn-text">{shotBusy ? "Snapping..." : "Capture"}</span>
          </button>
          <button
            type="button"
            className="browser-icon-btn close"
            onClick={onClose}
            title="Close browser pane"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      </div>

      {/* Navigation bar */}
      <form
        className="browser-nav-bar"
        onSubmit={(e) => {
          e.preventDefault();
          go(input);
        }}
      >
        <div className="nav-controls-group">
          <button
            type="button"
            className="browser-nav-btn"
            title={IS_DESKTOP ? "Back" : "Back (needs desktop app)"}
            aria-label="Back"
            disabled={!IS_DESKTOP || !nav.back}
            onClick={() => webRef.current?.goBack?.()}
          >
            ‹
          </button>
          <button
            type="button"
            className="browser-nav-btn"
            title={IS_DESKTOP ? "Forward" : "Forward (needs desktop app)"}
            aria-label="Forward"
            disabled={!IS_DESKTOP || !nav.fwd}
            onClick={() => webRef.current?.goForward?.()}
          >
            ›
          </button>
          <button
            type="button"
            className="browser-nav-btn"
            title="Reload"
            aria-label="Reload"
            disabled={!src}
            onClick={() => {
              if (webRef.current?.reload) webRef.current.reload();
              else setFrameKey((k) => k + 1);
            }}
          >
            <RefreshCwIcon size={12} className={loading ? "spin" : ""} />
          </button>
        </div>

        <div className="browser-omnibox-wrapper">
          <span className="omnibox-scheme-badge">http</span>
          <input
            className="browser-omnibox-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a URL or select preset below..."
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Browser address"
          />
        </div>

        <button type="submit" className="browser-go-btn" disabled={!canGo}>
          Go
        </button>
      </form>

      {/* Presets */}
      <div className="browser-presets-bar">
        {PRESETS.map((p) => (
          <button
            key={p.url}
            type="button"
            className={`preset-pill ${src === p.url ? "active" : ""}`}
            onClick={() => go(p.url)}
            title={p.url}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Viewport Frame */}
      <div className="browser-viewport-container" aria-busy={loading}>
        {src ? (
          IS_DESKTOP ? (
            <WebviewTag
              key={`${src}-${frameKey}`}
              ref={webRef}
              className="browser-webview-element"
              src={src}
              partition="persist:openmuse-browser"
              allowpopups
            />
          ) : (
            <iframe
              key={`${src}-${frameKey}`}
              className="browser-webview-element"
              src={src}
              title="Browser preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              onLoad={() => setLoading(false)}
            />
          )
        ) : (
          <div className="browser-empty-state">
            <GlobeIcon size={36} />
            <h4 className="empty-title">Live App Preview</h4>
            <p className="empty-desc">
              Inspect your local dev servers, test web apps, or preview builds alongside your chat.
            </p>
          </div>
        )}

        {loading && (
          <div className="browser-loading-bar">
            <div className="loading-progress" />
          </div>
        )}
      </div>

      {err && (
        <div className="browser-error-banner">
          <span>{err}</span>
          <button type="button" className="error-retry-btn" onClick={() => go(src)}>
            Retry
          </button>
          <button type="button" className="error-dismiss-btn" onClick={() => setErr(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Bottom Tools Toolbar */}
      <div className="browser-tools-bar">
        <button
          type="button"
          className="tool-btn"
          disabled={!src || !IS_DESKTOP}
          onClick={() => setZoomLevel(zoom - 0.1)}
          title="Zoom out"
        >
          −
        </button>
        <span className="tool-zoom-text">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="tool-btn"
          disabled={!src || !IS_DESKTOP}
          onClick={() => setZoomLevel(zoom + 0.1)}
          title="Zoom in"
        >
          +
        </button>
        <div className="tool-separator" />
        <button
          type="button"
          className="tool-action-btn"
          disabled={!src || !IS_DESKTOP}
          onClick={toggleDevTools}
          title="Open Chromium DevTools"
        >
          Inspect DevTools
        </button>
        <button
          type="button"
          className="tool-action-btn"
          disabled={!src}
          onClick={openExternal}
          title="Open in default browser"
        >
          <ExternalLinkIcon size={12} />
          <span>Open External</span>
        </button>
      </div>

      {/* Screenshot attachment preview */}
      {shot && (
        <div className="browser-shot-modal">
          <img src={shot} alt="Screenshot preview" className="shot-preview-img" />
          <div className="shot-actions-row">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                onAttach(shot, shotName(src));
                setShot(null);
              }}
            >
              Attach to Chat
            </button>
            <button type="button" className="btn-secondary" onClick={downloadShot}>
              Download PNG
            </button>
            <button type="button" className="btn-ghost" onClick={() => setShot(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
