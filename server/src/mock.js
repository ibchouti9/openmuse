// Mock host: same surface as MspHost, emits a fake streaming transcript.
// Used for UI demos and for smoke tests where no model call is wanted.
"use strict";

const EventEmitter = require("node:events");

let n = 0;
const sid = () => `mock-session-${++n}`;
const now = () => new Date().toISOString();

class MockHost extends EventEmitter {
  constructor() {
    super();
    this.sessions = [];
    this.workspace = process.cwd();
    this.pendingInput = null;
    this.histories = {};
  }
  status() {
    return { connected: true, lastError: null, restarts: 0, mock: true };
  }
  async sessionList() {
    return { sessions: this.sessions, nextCursor: null };
  }
  async sessionStart() {
    const session = { sessionId: sid(), title: "Mock session", createdAt: now(), updatedAt: now() };
    this.sessions.unshift(session);
    this.emit("notification", { method: "session/started", params: { session } });
    return { session, viewCursor: "0" };
  }
  async sessionResume(sessionId) {
    return {
      session: this.sessions.find((s) => s.sessionId === sessionId) || { sessionId },
      viewCursor: "0",
      history: { mode: "inline", items: this.histories[sessionId] || [] },
      pendingRequests: [],
    };
  }
  async turnStart(sessionId, text) {
    const turnId = `turn-${Date.now()}`;
    const itemId = `item-${Date.now()}`;
    setImmediate(() => {
      if (/approval/i.test(text)) this._playApproval(sessionId, turnId, itemId, text);
      else this._play(sessionId, turnId, itemId, text);
    });
    return { commandId: "mock", disposition: "started", startedNewTurn: true, status: "accepted", turnId };
  }
  _playApproval(sessionId, turnId, itemId, text) {
    const hist = (this.histories[sessionId] = this.histories[sessionId] || []);
    hist.push({ itemId: `u-${Date.now()}`, kind: "userMessage", turnId, revision: 1, status: "completed", text });
    this.emit("notification", { method: "turn/started", params: { sessionId, turnId } });
    const approvalId = `ap-${Date.now()}`;
    const requirementId = { approvalId, sourceIndex: 0 };
    this.pendingApproval = { sessionId, turnId, itemId, approvalId, requirementId, hist };
    setTimeout(() => {
      this.emit("notification", {
        method: "approval/requested",
        params: {
          sessionId, turnId, approvalId, itemId, toolCallId: "mock-call", toolName: "bash",
          viewCursor: "1",
          rawArgs: JSON.stringify({ command: "echo approval-ui-ok", description: "Demo approval" }),
          subject: { kind: "shell", command: "echo approval-ui-ok", workspaceRoot: "/tmp", stages: [{ argv: ["echo", "approval-ui-ok"] }] },
          currentRequirementId: requirementId,
          availableChoices: [
            { choiceId: "allow_once", label: "Allow once", decision: "approved", scope: "once" },
            { choiceId: "abort", label: "Reject", decision: "abort", scope: "once", acceptsFeedback: true },
          ],
          protectedWrite: false, judgeEscalated: false,
        },
      });
    }, 400);
  }
  async approvalDecide() {
    const p = this.pendingApproval;
    this.pendingApproval = null;
    if (p) {
      const { sessionId, turnId, itemId, approvalId } = p;
      this.emit("notification", { method: "approval/resolved", params: { sessionId, approvalId } });
      const tool = { itemId, kind: "toolCall", turnId, revision: 1, status: "inProgress", tool: "bash", args: JSON.stringify({ command: "echo approval-ui-ok" }) };
      this.emit("notification", { method: "item/started", params: { sessionId, viewCursor: "2", item: tool } });
      const doneTool = { ...tool, revision: 2, status: "completed", visibleOutput: "approval-ui-ok\n" };
      p.hist.push(doneTool);
      setTimeout(() => {
        this.emit("notification", { method: "item/completed", params: { sessionId, viewCursor: "3", item: doneTool } });
        this.emit("notification", { method: "turn/completed", params: { sessionId, turnId, terminal: "completed", durationMs: 60 } });
      }, 400);
    }
    return { status: "accepted" };
  }
  async userInputAnswer({ sessionId, userInputId, answers }) {
    if (!this.pendingInput || this.pendingInput.userInputId !== userInputId) {
      throw new Error("no such pending question");
    }
    if (!Array.isArray(answers) || answers.length === 0) throw new Error("answers[] required");
    const done = this.pendingInput.resolve;
    this.pendingInput = null;
    this.emit("notification", { method: "userInput/settled", params: { sessionId, userInputId } });
    setImmediate(done);
    return { status: "accepted" };
  }
  async userInputCancel({ sessionId, userInputId }) {
    if (this.pendingInput && this.pendingInput.userInputId === userInputId) {
      const fail = this.pendingInput.reject;
      this.pendingInput = null;
      setImmediate(fail);
    }
    this.emit("notification", { method: "userInput/settled", params: { sessionId, userInputId } });
    return { status: "accepted" };
  }
  async turnInterrupt(sessionId) {
    this.emit("notification", { method: "turn/completed", params: { sessionId, turnId: "mock", terminal: "cancelled" } });
    return { status: "accepted" };
  }
  async turnCancel(sessionId) {
    return this.turnInterrupt(sessionId);
  }
  async modelList() {
    return { models: [{ modelId: "mock-model", label: "Mock model" }] };
  }
  async viewPage({ sessionId }) {
    return {
      events: (this.histories[sessionId] || []).map((item) => ({ method: "item/completed", params: { sessionId, item } })),
      nextCursor: null,
    };
  }
  async setModel() {
    return { status: "accepted" };
  }
  async setApprovalMode() {
    return { status: "accepted" };
  }
  async approvalListPending() {
    return { approvals: [], userInputs: [] };
  }
  async sessionRead(sessionId) {
    return { session: this.sessions.find((s) => s.sessionId === sessionId) || { sessionId }, history: { mode: "inline", items: this.histories[sessionId] || [] } };
  }
  async sessionFork(sessionId) {
    const src = this.sessions.find((s) => s.sessionId === sessionId);
    const session = { sessionId: sid(), title: src ? `Fork of ${src.title || src.sessionId}` : "Mock fork", createdAt: now(), updatedAt: now() };
    this.sessions.unshift(session);
    this.histories[session.sessionId] = [...(this.histories[sessionId] || [])];
    return { session };
  }
  async sessionCompact() {
    return { status: "accepted" };
  }
  async sessionUserShell(sessionId, commandText) {
    return { status: "accepted", output: `mock ran: ${commandText || ""}`.slice(0, 2000) };
  }
  async turnSteer() {
    return { status: "accepted" };
  }
  async turnUnqueue() {
    return { status: "accepted" };
  }
  async userInputClarify({ sessionId, userInputId }) {
    this.emit("notification", { method: "userInput/settled", params: { sessionId, userInputId } });
    return { status: "accepted" };
  }
  async viewUnsubscribe() {
    return { status: "accepted" };
  }
  async subagentSendMessage() {
    return { status: "accepted" };
  }
  async subagentFollowupTask() {
    return { status: "accepted" };
  }
  async subagentReadResult() {
    return { status: "accepted", result: null };
  }
  async subagentStop() {
    return { status: "accepted" };
  }
  async subagentClose() {
    return { status: "accepted" };
  }
  async subagentInterrupt() {
    return { status: "accepted" };
  }
  async subagentReopen() {
    return { status: "accepted" };
  }
  async subagentResume() {
    return { status: "accepted" };
  }
  _play(sessionId, turnId, itemId, text) {
    const hist = (this.histories[sessionId] = this.histories[sessionId] || []);
    hist.push({ itemId: `u-${Date.now()}`, kind: "userMessage", turnId, revision: 1, status: "completed", text });
    this.emit("notification", { method: "turn/started", params: { sessionId, turnId } });
    // Reasoning streams summary parts via field "summary.N" before the reply
    // opens, mirroring the real host. The UI folds these into one thinking
    // block that updates in place.
    const thinkId = `think-${Date.now()}`;
    const thinkSummary = ["Considering the request and which tools to use.", "Drafting the reply."];
    this.emit("notification", {
      method: "item/started",
      params: { sessionId, viewCursor: "0", item: { itemId: thinkId, kind: "reasoning", turnId, revision: 1, status: "inProgress", summary: [""] } },
    });
    this.emit("notification", {
      method: "item/delta",
      params: { sessionId, itemId: thinkId, field: "summary.0", delta: thinkSummary[0], viewCursor: "0a" },
    });
    this.emit("notification", {
      method: "item/delta",
      params: { sessionId, itemId: thinkId, field: "summary.1", delta: thinkSummary[1], viewCursor: "0b" },
    });
    const toolId = `tool-${Date.now()}`;
    this.emit("notification", {
      method: "item/started",
      params: { sessionId, viewCursor: "0c", item: { itemId: toolId, kind: "toolCall", turnId, revision: 1, status: "inProgress", tool: "bash", args: JSON.stringify({ command: "echo mock-thinking-ok", description: "Demo tool step" }) } },
    });
    this.emit("notification", {
      method: "item/delta",
      params: { sessionId, itemId: toolId, field: "output", delta: "mock-thinking-ok\n", viewCursor: "0d" },
    });
    hist.push({ itemId: thinkId, kind: "reasoning", turnId, revision: 2, status: "completed", summary: thinkSummary });
    hist.push({ itemId: toolId, kind: "toolCall", turnId, revision: 2, status: "completed", tool: "bash", args: JSON.stringify({ command: "echo mock-thinking-ok" }), visibleOutput: "mock-thinking-ok\n" });
    this.emit("notification", {
      method: "item/completed",
      params: { sessionId, viewCursor: "0e", item: { itemId: thinkId, kind: "reasoning", turnId, revision: 2, status: "completed", summary: thinkSummary } },
    });
    this.emit("notification", {
      method: "item/completed",
      params: { sessionId, viewCursor: "0f", item: { itemId: toolId, kind: "toolCall", turnId, revision: 2, status: "completed", tool: "bash", args: JSON.stringify({ command: "echo mock-thinking-ok" }), visibleOutput: "mock-thinking-ok\n" } },
    });
    // Mirror the real wire shape: items nest under params.item.
    this.emit("notification", {
      method: "item/started",
      params: { sessionId, viewCursor: "0g", item: { itemId, kind: "agentMessage", turnId, revision: 1, status: "inProgress", text: "" } },
    });
    // Mid-turn the "model" asks a question; the turn only finishes once answered.
    const userInputId = `ui-${Date.now()}`;
    setTimeout(() => {
      this.emit("notification", {
        method: "userInput/requested",
        params: {
          sessionId,
          turnId,
          itemId: `q-${Date.now()}`,
          toolCallId: "mock-tool",
          toolName: "mock_tool",
          userInputId,
          viewCursor: "1",
          questions: [
            {
              id: "q-color",
              header: "Style",
              question: "Which accent should the mock reply use?",
              selection: { mode: "single" },
              options: [
                { label: "Blue", description: "Calm default" },
                { label: "Green", description: "Fresh look" },
              ],
            },
            {
              id: "q-note",
              header: "Note",
              question: "Anything else to include? (free text)",
              selection: { mode: "single" },
              options: [{ label: "Surprise me" }],
            },
          ],
        },
      });
    }, 400);
    const finish = (ending) => {
      const body =
        ending === "cancelled"
          ? "Mock reply cancelled before answering."
          : `Mock reply to: "${text}"\n\n- streaming works (item/delta)\n- approvals render below when the host asks\n- connect a real host by restarting without OPENMUSE_MOCK=1`;
      let i = 0;
      const timer = setInterval(() => {
        i += 24;
        const done = i >= body.length;
        this.emit("notification", {
          method: "item/delta",
          params: { sessionId, itemId, field: "text", delta: body.slice(i - 24, i), viewCursor: String(i) },
        });
        if (done) {
          clearInterval(timer);
          hist.push({ itemId, kind: "agentMessage", turnId, revision: 2, status: "completed", text: body });
          this.emit("notification", {
            method: "item/completed",
            params: { sessionId, viewCursor: "2", item: { itemId, kind: "agentMessage", turnId, revision: 2, status: "completed", text: body } },
          });
          this.emit("notification", {
            method: "turn/completed",
            params: { sessionId, turnId, terminal: ending, durationMs: 120 },
          });
          this.emit("notification", {
            method: "session/tokenUsage",
            params: { sessionId, usage: { inputTokens: 42, outputTokens: 58 }, cumulative: { totalTokens: 100 } },
          });
        }
      }, 60);
    };
    new Promise((resolve, reject) => {
      this.pendingInput = { userInputId, resolve, reject };
    }).then(
      () => finish("completed"),
      () => finish("cancelled"),
    );
  }
}

// index.js subscribes with host.on("notification", ...) exactly like MspHost.
module.exports = new MockHost();
