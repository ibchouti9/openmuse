// Tiny REST + SSE client for the OpenMuse server.
export async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `request failed: ${path}`);
  return body;
}

export function turnCancel(sessionId: string, turnId?: string) {
  return api("/api/turn/cancel", {
    method: "POST",
    body: JSON.stringify({ sessionId, ...(turnId ? { turnId } : {}) }),
  });
}

export function exportSession(sessionId: string) {
  return api(`/api/session/export?sessionId=${encodeURIComponent(sessionId)}`);
}

export const ops = {
  fork: (sessionId: string) => api("/api/session/fork", { method: "POST", body: JSON.stringify({ sessionId }) }),
  compact: (sessionId: string, turnId?: string) =>
    api("/api/session/compact", { method: "POST", body: JSON.stringify({ sessionId, ...(turnId ? { turnId } : {}) }) }),
  configStatus: () => api("/api/config/status"),
  authLogout: () => api("/api/auth/logout", { method: "POST", body: JSON.stringify({}) }),
  authSet: (apiKey: string, provider?: string) =>
    api("/api/auth/set", { method: "POST", body: JSON.stringify({ apiKey, provider }) }),
  devUpdate: (repo?: string, dryRun = false) =>
    api("/api/dev/update", { method: "POST", body: JSON.stringify({ repo, dryRun }) }),
  devUpdateStatus: () => api("/api/dev/update-status"),
  gitStatus: (workspace: string) => api(`/api/git/status?workspace=${encodeURIComponent(workspace || "")}`),
  gitCommit: (workspace: string, message: string, push = false) =>
    api("/api/git/commit", { method: "POST", body: JSON.stringify({ workspace, message, push }) }),
  gitMessage: (workspace: string) =>
    api("/api/git/message", { method: "POST", body: JSON.stringify({ workspace }) }),
  gitPush: (workspace: string) => api("/api/git/push", { method: "POST", body: JSON.stringify({ workspace }) }),
  gitPr: (workspace: string, title: string, body = "", base = "", draft = false) =>
    api("/api/git/pr", { method: "POST", body: JSON.stringify({ workspace, title, body, base, draft }) }),
};

export function subscribe(onEvent: (method: string, params: any) => void, onStatus?: (s: any) => void) {
  const es = new EventSource("/api/events");
  es.addEventListener("msp", (e: MessageEvent) => {
    try {
      const { method, params } = JSON.parse(e.data);
      onEvent(method, params);
    } catch {
      /* ignore malformed frames */
    }
  });
  es.addEventListener("status", (e: MessageEvent) => {
    try {
      onStatus && onStatus(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  });
  return () => es.close();
}
