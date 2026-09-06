'use strict';

/**
 * Tracks live voice sessions. Deliberately shaped like ExecutionStore: an
 * in-memory Map with unref'd timers, dropped when the connection goes away.
 * A personal single-instance gateway needs no shared store.
 *
 * One voice session per connection. Two microphones on one socket is not a
 * thing, and allowing it would only create ways to leak audio between turns.
 */

const { randomUUID } = require('node:crypto');

class VoiceSessionStore {
  constructor() {
    this.byId = new Map();
    this.byConnectionId = new Map();
  }

  get size() {
    return this.byId.size;
  }

  get(voiceSessionId) {
    return this.byId.get(voiceSessionId) || null;
  }

  forConnection(connectionId) {
    const id = this.byConnectionId.get(connectionId);
    return id ? this.byId.get(id) || null : null;
  }

  start({ connectionId, userId, sessionId, maxSessionMs, onExpire }) {
    // Replace rather than reject: a client that reloaded mid-session should be
    // able to start again without waiting for a timeout to clear the old one.
    this.endForConnection(connectionId, 'replaced');

    const voiceSessionId = `voice_${randomUUID()}`;
    const timer = setTimeout(() => {
      this.end(voiceSessionId, 'expired');
      onExpire?.(voiceSessionId);
    }, maxSessionMs);
    timer.unref?.();

    const session = {
      voiceSessionId,
      connectionId,
      userId,
      sessionId,
      // Set once the engine is open: the engine, not config, owns the rates.
      engine: null,
      mode: 'ptt',
      inputSampleRate: null,
      outputSampleRate: null,
      talking: false,
      pendingApprovalId: null,
      startedAt: Date.now(),
      expiresAt: Date.now() + maxSessionMs,
      inSequence: 0,
      outSequence: 0,
      bytesIn: 0,
      bytesOut: 0,
      // Sliding one-second budget, so a runaway client cannot flood the socket.
      windowStartedAt: Date.now(),
      windowBytes: 0,
      timer,
    };
    this.byId.set(voiceSessionId, session);
    this.byConnectionId.set(connectionId, voiceSessionId);
    return session;
  }

  end(voiceSessionId, reason = 'ended') {
    const session = this.byId.get(voiceSessionId);
    if (!session) return null;
    clearTimeout(session.timer);
    this.byId.delete(voiceSessionId);
    if (this.byConnectionId.get(session.connectionId) === voiceSessionId) {
      this.byConnectionId.delete(session.connectionId);
    }
    session.endedReason = reason;
    return session;
  }

  endForConnection(connectionId, reason = 'ended') {
    const id = this.byConnectionId.get(connectionId);
    return id ? this.end(id, reason) : null;
  }

  clear() {
    for (const session of this.byId.values()) clearTimeout(session.timer);
    this.byId.clear();
    this.byConnectionId.clear();
  }
}

module.exports = { VoiceSessionStore };
