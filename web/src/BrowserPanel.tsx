import { useEffect, useRef, useState } from "react";

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
// "webview" is an Electron-only tag unknown to React's JSX types.
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
    // Remount the guest even for a same-URL Go/Retry so navigation events
    // fire and `loading` always resolves instead of sticking on.
    setFrameKey((k) => k + 1);
    try {
      localStorage.setItem("openmuse.browserUrl", url);
    } catch {
      /* ignore */
    }
  }

  // Wire Electron webview navigation events whenever the guest exists.
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
      if (e && e.errorCode === -3) return; // ERR_ABORTED, e.g. superseded nav
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

  // Watchdog: never spin forever. Frame-blocking sites (X-Frame-Options)
  // and stalled dev servers may never resolve `loading`; after 30s stop
  // the spinner so the pane degrades to its error/empty state instead.
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
      setErr("Screenshots need the OpenMuse desktop app — a plain browser tab can't capture other sites.");
      return;
    }
    const id = guestId();
    if (id == null) {
      setErr("Browser view isn't ready yet — wait for the page to load.");
      return;
    }
    setShotBusy(true);
    try {
      const r = await window.openmuse.captureBrowser(id);
      setShot(r.dataUrl);
    } catch (e: any) {
      setErr(e?.message || "Screenshot failed");
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
      setErr(e?.message || "DevTools failed");
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
    <section className="browser" aria-label="Browser preview">
      <div className="bhead">
        <span className="btitle" title={title || src || "Browser"}>
          {loading ? "Loading…" : title || "Browser"}
        </span>
        <span className="spacer" />
        <button className="mini" onClick={() => screenshot()} disabled={shotBusy}>
          {shotBusy ? "Capturing…" : "Screenshot"}
        </button>
        <button className="mini" onClick={onClose} title="Close browser pane">
          Close
        </button>
      </div>
      <form
        className="bnav"
        onSubmit={(e) => {
          e.preventDefault();
          go(input);
        }}
      >
        <button
          type="button"
          className="iconbtn bnavbtn"
          title={IS_DESKTOP ? "Back" : "Back (needs desktop app)"}
          aria-label="Back"
          disabled={!IS_DESKTOP || !nav.back}
          onClick={() => webRef.current?.goBack?.()}
        >
          ←
        </button>
        <button
          type="button"
          className="iconbtn bnavbtn"
          title={IS_DESKTOP ? "Forward" : "Forward (needs desktop app)"}
          aria-label="Forward"
          disabled={!IS_DESKTOP || !nav.fwd}
          onClick={() => webRef.current?.goForward?.()}
        >
          →
        </button>
        <button
          type="button"
          className="iconbtn bnavbtn"
          title="Reload"
          aria-label="Reload"
          disabled={!src}
          onClick={() => {
            if (webRef.current?.reload) webRef.current.reload();
            else setFrameKey((k) => k + 1);
          }}
        >
          ⟳
        </button>
        <input
          className="burl"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a URL — e.g. localhost:3000"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Browser address"
        />
        <button type="submit" className="primary bgo" disabled={!canGo}>
          Go
        </button>
      </form>
      <div className="bpresets">
        {PRESETS.map((p) => (
          <button key={p.url} className={src === p.url ? "on" : ""} onClick={() => go(p.url)} title={p.url}>
            {p.label}
          </button>
        ))}
      </div>
      {!IS_DESKTOP && (
        <p className="bhint">
          Web mode renders pages in a plain frame — some sites block framing. Full navigation, zoom, and screenshots
          need the OpenMuse desktop app.
        </p>
      )}
      <div className="bview" aria-busy={loading} aria-live="off">
        {src ? (
          IS_DESKTOP ? (
            <WebviewTag
              key={`${src}-${frameKey}`}
              ref={webRef}
              className="bwebview"
              src={src}
              partition="persist:openmuse-browser"
              allowpopups
            />
          ) : (
            <iframe
              key={`${src}-${frameKey}`}
              className="bwebview"
              src={src}
              title="Browser preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              onLoad={() => setLoading(false)}
            />
          )
        ) : (
          <div className="bempty" role="status">
            <p className="bempty-title">Preview your work</p>
            <p className="bempty-sub">Type any URL above — your dev server, localhost, or a live site — or pick a preset.</p>
          </div>
        )}
        {loading && (
          <div className="bloading" aria-hidden>
            <span className="sr">Loading page…</span>
          </div>
        )}
      </div>
      {err && (
        <div className="err berr" role="alert">
          <span>{err}</span>
          <div className="row berrrow">
            {src && (
              <button className="mini" onClick={() => go(src)}>
                Retry
              </button>
            )}
            <button className="mini" onClick={() => setErr(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      <div className="btools">
        <button className="mini" disabled={!src} onClick={() => go(src)} title="Reload the page">
          Reload
        </button>
        <button className="mini" disabled={!src || !IS_DESKTOP} onClick={() => setZoomLevel(zoom - 0.1)} title={IS_DESKTOP ? "Zoom out" : "Zoom needs the desktop app"}>
          A−
        </button>
        <span className="bzoom" title="Page zoom">
          {Math.round(zoom * 100)}%
        </span>
        <button className="mini" disabled={!src || !IS_DESKTOP} onClick={() => setZoomLevel(zoom + 0.1)} title={IS_DESKTOP ? "Zoom in" : "Zoom needs the desktop app"}>
          A+
        </button>
        <button className="mini" disabled={!src || !IS_DESKTOP} onClick={() => toggleDevTools()} title="Inspect the page">
          Inspect
        </button>
        <button className="mini" disabled={!src} onClick={openExternal} title="Open in system browser">
          Open ↗
        </button>
      </div>
      {shot && (
        <div className="bshot">
          <img src={shot} alt="Browser screenshot preview" />
          <div className="row bshotrow">
            <button className="primary" onClick={() => onAttach(shot, shotName(src))}>
              Attach to chat
            </button>
            <button className="ghost" onClick={downloadShot}>
              Download
            </button>
            <button className="ghost" onClick={() => setShot(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
