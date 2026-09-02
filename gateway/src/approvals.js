'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Pending human-in-the-loop approvals.
 *
 * n8n pauses a workflow on a Wait node and gives us a resume URL. That URL is a
 * capability - anyone holding it can resume the workflow - so it is kept here on
 * the server and never sent to a client. The client only ever sees the opaque
 * approvalId, and the gateway calls the resume URL on its behalf.
 */
class ApprovalStore {
  constructor() {
    this.byId = new Map();
  }

  create({ approvalId = `apr_${randomUUID()}`, resumeUrl, sessionId, userId, ttlMs, onExpire }) {
    // Approvals are session-scoped, not connection-scoped: a phone that
    // reconnects mid-approval must still be able to answer.
    const timer = setTimeout(() => {
      this.byId.delete(approvalId);
      if (onExpire) onExpire(approvalId, sessionId);
    }, ttlMs);
    timer.unref?.();

    this.byId.set(approvalId, { approvalId, resumeUrl, sessionId, userId, timer, createdAt: Date.now() });
    return approvalId;
  }

  get(approvalId) {
    return this.byId.get(approvalId) || null;
  }

  settle(approvalId) {
    const approval = this.byId.get(approvalId);
    if (!approval) return null;
    clearTimeout(approval.timer);
    this.byId.delete(approvalId);
    return approval;
  }

  get size() {
    return this.byId.size;
  }

  clear() {
    for (const approval of this.byId.values()) clearTimeout(approval.timer);
    this.byId.clear();
  }
}

/**
 * The gateway POSTs to a URL supplied by n8n, so constrain it to the n8n origin.
 * Only a holder of PUSH_SECRET can set it, but a narrow allowlist keeps a
 * compromised or mistyped workflow from turning the gateway into an open relay.
 */
function resumeUrlAllowed(resumeUrl, config) {
  const prefix = config.n8n.resumeUrlPrefix;
  if (!prefix) return true;
  try {
    return new URL(resumeUrl).href.startsWith(prefix);
  } catch {
    return false;
  }
}

module.exports = { ApprovalStore, resumeUrlAllowed };
