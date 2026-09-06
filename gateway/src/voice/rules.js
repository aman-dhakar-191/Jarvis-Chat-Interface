'use strict';

/**
 * Standing approval rules — "stop asking me about this kind of thing".
 *
 * Stored through n8n like the memory snapshot, so the gateway still holds no
 * database credentials. Falls back to memory-only when no URL is configured:
 * rules that vanish on restart are a degraded experience, but a voice session
 * that refuses to start because a rules service is down is a broken one.
 *
 * Matching is deliberately conservative. A rule fires only when the request
 * text clearly corresponds to the remembered kind, because the cost of a wrong
 * match is an action taken without asking - the exact thing approvals exist to
 * prevent.
 */

const logger = require('../logger');

class ApprovalRules {
  constructor(config) {
    this.url = config.voice.rulesUrl;
    this.timeoutMs = config.voice.rulesTimeoutMs;
    this.local = new Map();
  }

  async call(op, body = {}) {
    if (!this.url) return null;
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, ...body }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        logger.warn('approval rules service rejected', { op, status: response.status });
        return null;
      }
      return await response.json();
    } catch (err) {
      logger.warn('approval rules service unavailable', { op, error: err.message });
      return null;
    }
  }

  key(userId, kind) {
    return `${userId}::${kind}`;
  }

  async list(userId) {
    const remote = await this.call('list', { userId });
    if (remote?.rules) {
      // Keep the local cache warm so a later outage degrades gracefully.
      for (const rule of remote.rules) this.local.set(this.key(userId, rule.kind), rule);
      return remote.rules;
    }
    return [...this.local.values()].filter((r) => r.userId === userId);
  }

  async add(kind, decision, userId) {
    const rule = { kind, decision, userId, createdAt: new Date().toISOString() };
    this.local.set(this.key(userId, kind), rule);
    await this.call('add', rule);
    logger.info('approval rule stored', { kind, decision, userId });
    return rule;
  }

  async remove(kind, userId) {
    this.local.delete(this.key(userId, kind));
    await this.call('remove', { kind, userId });
    logger.info('approval rule removed', { kind, userId });
  }

  /**
   * Find a rule matching an approval request.
   *
   * Substring matching in one direction only: the remembered kind must appear
   * in the request text. "calendar event" matches "Create a calendar event for
   * Friday?"; it does not match on a stray shared word. Anything less clear
   * falls through to asking, which is the safe default.
   */
  async match(userId, requestText) {
    const text = String(requestText || '').toLowerCase();
    if (!text) return null;
    const rules = await this.list(userId);
    for (const rule of rules) {
      const kind = String(rule.kind || '').toLowerCase();
      // Very short kinds would match almost anything.
      if (kind.length < 4) continue;
      if (text.includes(kind)) return rule;
    }
    return null;
  }
}

module.exports = { ApprovalRules };
