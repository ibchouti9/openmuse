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
