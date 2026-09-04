// Tiny REST + SSE client for the OpenMuse server.
export interface Choice {
  choiceId: string;
  label: string;
  decision: string;
  scope: string;
  acceptsFeedback?: boolean;
}

export interface Approval {
  approvalId: string;
  sessionId: string;
  toolName: string;
  subject: unknown;
  rawArgs?: string;
  availableChoices: Choice[];
  currentRequirementId: string;
  settled?: boolean;
}

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
  pending: (sessionId: string) => api(`/api/approvals/pending?sessionId=${encodeURIComponent(sessionId)}`),
  read: (sessionId: string) => api(`/api/session/read?sessionId=${encodeURIComponent(sessionId)}`),
  fork: (sessionId: string) => api("/api/session/fork", { method: "POST", body: JSON.stringify({ sessionId }) }),
  compact: (sessionId: string, turnId?: string) =>
    api("/api/session/compact", { method: "POST", body: JSON.stringify({ sessionId, ...(turnId ? { turnId } : {}) }) }),
  shell: (sessionId: string, commandText: string) =>
    api("/api/session/shell", { method: "POST", body: JSON.stringify({ sessionId, commandText }) }),
  steer: (sessionId: string, expectedTurnId: string, text: string) =>
    api("/api/turn/steer", { method: "POST", body: JSON.stringify({ sessionId, expectedTurnId, text }) }),
  unqueue: (sessionId: string, turnId: string) =>
    api("/api/turn/unqueue", { method: "POST", body: JSON.stringify({ sessionId, turnId }) }),
  clarify: (sessionId: string, userInputId: string, text: string) =>
    api("/api/input/clarify", { method: "POST", body: JSON.stringify({ sessionId, userInputId, text }) }),
  unsubscribe: (sessionId: string) =>
    api("/api/view/unsubscribe", { method: "POST", body: JSON.stringify({ sessionId }) }),
  subagent: (route: string, sessionId: string, subagentId: string, extra: Record<string, string> = {}) =>
    api(`/api/subagent/${route}`, { method: "POST", body: JSON.stringify({ sessionId, subagentId, ...extra }) }),
  skills: () => api("/api/skills"),
  skillsAction: (action: string, skill?: string, scope?: string) =>
    api("/api/skills/action", { method: "POST", body: JSON.stringify({ action, skill, scope }) }),
  plugins: () => api("/api/plugins"),
  pluginsAction: (action: string, id?: string, extra: string[] = []) =>
    api("/api/plugins/action", { method: "POST", body: JSON.stringify({ action, id, extra }) }),
  exec: (body: Record<string, string>) => api("/api/exec", { method: "POST", body: JSON.stringify(body) }),
  trace: (sessionLog: string) => api(`/api/trace?sessionLog=${encodeURIComponent(sessionLog)}`),
  cliExport: (session: string) => api(`/api/export?session=${encodeURIComponent(session)}`),
  messages: () => api("/api/session-messages"),
  messageSend: (target: string, message: string) =>
    api("/api/session-messages/send", { method: "POST", body: JSON.stringify({ target, message }) }),
  sandbox: () => api("/api/sandbox"),
  schema: () => api("/api/schema"),
  configStatus: () => api("/api/config/status"),
  configValidate: (plane: string, file: string) =>
    api("/api/config/validate", { method: "POST", body: JSON.stringify({ plane, file }) }),
  cliVersion: () => api("/api/cli/version"),
  init: (dryRun = true) => api("/api/init", { method: "POST", body: JSON.stringify({ dryRun }) }),
  authStatus: () => api("/api/auth/status"),
  authLogout: () => api("/api/auth/logout", { method: "POST", body: JSON.stringify({}) }),
  authSet: (apiKey: string, provider?: string) =>
    api("/api/auth/set", { method: "POST", body: JSON.stringify({ apiKey, provider }) }),
  devUpdate: (repo?: string, dryRun = false) =>
    api("/api/dev/update", { method: "POST", body: JSON.stringify({ repo, dryRun }) }),
  devUpdateStatus: () => api("/api/dev/update-status"),
  gitStatus: (workspace: string) => api(`/api/git/status?workspace=${encodeURIComponent(workspace || "")}`),
  gitCommit: (workspace: string, message: string, push = false) =>
    api("/api/git/commit", { method: "POST", body: JSON.stringify({ workspace, message, push }) }),
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
