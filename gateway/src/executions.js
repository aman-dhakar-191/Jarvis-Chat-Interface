'use strict';

/**
 * Tracks in-flight Jarvis executions so an async n8n callback (POST /api/push)
 * can be matched back to the connection that asked for it, and so a client
 * cannot flood the gateway with unbounded concurrent requests.
 * In-memory by design: a personal single-instance gateway needs no shared store.
 */
class ExecutionStore {
  constructor() {
    this.byMessageId = new Map();
  }

  start({ messageId, connectionId, sessionId, userId, timeoutMs, onTimeout }) {
    const timer = setTimeout(() => {
      this.byMessageId.delete(messageId);
      onTimeout();
    }, timeoutMs);
    timer.unref?.();
    this.byMessageId.set(messageId, { messageId, connectionId, sessionId, userId, timer, startedAt: Date.now() });
  }

  /** Resolve and remove an execution, clearing its timeout. */
  settle(messageId) {
    const execution = this.byMessageId.get(messageId);
    if (!execution) return null;
    clearTimeout(execution.timer);
    this.byMessageId.delete(messageId);
    return execution;
  }

  /** Drop every execution belonging to a connection that went away. */
  dropConnection(connectionId) {
    for (const [messageId, execution] of this.byMessageId) {
      if (execution.connectionId === connectionId) {
        clearTimeout(execution.timer);
        this.byMessageId.delete(messageId);
      }
    }
  }

  clear() {
    for (const execution of this.byMessageId.values()) clearTimeout(execution.timer);
    this.byMessageId.clear();
  }
}

module.exports = { ExecutionStore };
