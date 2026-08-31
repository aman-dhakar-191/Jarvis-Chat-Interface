'use strict';

const logger = require('./logger');

// Keys, in priority order, that n8n workflows commonly use for the final text.
const REPLY_KEYS = ['reply', 'output', 'text', 'answer', 'response', 'message', 'content', 'result'];

function getPath(value, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), value);
}

/**
 * n8n hands back wildly different shapes depending on how the workflow responds
 * (Respond to Webhook node, "last node" mode, AI Agent output, ...). Unwrap the
 * common containers and pull out the reply text without asking the user to
 * change their existing workflow.
 */
function extractReply(payload, explicitPath = '', depth = 0) {
  if (payload == null || depth > 6) return null;

  if (explicitPath && depth === 0) {
    const picked = getPath(payload, explicitPath);
    if (typeof picked === 'string' && picked.trim() !== '') return picked.trim();
    if (picked != null) return extractReply(picked, '', depth + 1);
  }

  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof payload === 'number' || typeof payload === 'boolean') {
    return String(payload);
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractReply(item, '', depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof payload !== 'object') return null;

  for (const key of REPLY_KEYS) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  // n8n item envelopes and generic wrappers.
  for (const key of ['json', 'data', 'body', 'result', 'output', 'message']) {
    if (payload[key] != null && typeof payload[key] === 'object') {
      const found = extractReply(payload[key], '', depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * POST the normalized chat payload to the existing n8n webhook.
 * Returns { ok, status, body, reply, errorCode, errorMessage } - it never throws.
 */
async function callWebhook(payload, config) {
  const { webhookUrl, webhookSecret, timeoutMs, responsePath } = config.n8n;

  if (!webhookUrl) {
    return { ok: false, errorCode: 'N8N_UNAVAILABLE', errorMessage: 'N8N_WEBHOOK_URL is not configured' };
  }

  const headers = { 'content-type': 'application/json', accept: 'application/json, text/plain;q=0.9' };
  if (webhookSecret) headers['x-jarvis-secret'] = webhookSecret;

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    logger.error('n8n request failed', { messageId: payload.messageId, error: err.message, timedOut });
    return {
      ok: false,
      errorCode: timedOut ? 'EXECUTION_TIMEOUT' : 'N8N_UNAVAILABLE',
      errorMessage: timedOut ? `Jarvis did not respond within ${timeoutMs}ms` : `Could not reach n8n: ${err.message}`,
    };
  }

  const rawText = await response.text().catch(() => '');
  let body = rawText;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json') || /^\s*[[{]/.test(rawText)) {
    try {
      body = JSON.parse(rawText);
    } catch {
      body = rawText;
    }
  }

  const durationMs = Date.now() - startedAt;

  if (!response.ok) {
    logger.error('n8n returned an error status', { messageId: payload.messageId, status: response.status, durationMs });
    return {
      ok: false,
      status: response.status,
      body,
      errorCode: 'EXECUTION_FAILED',
      errorMessage: `n8n responded with HTTP ${response.status}`,
    };
  }

  logger.info('n8n responded', { messageId: payload.messageId, status: response.status, durationMs });
  return { ok: true, status: response.status, body, durationMs, reply: extractReply(body, responsePath) };
}

/** Build the Telegram-equivalent payload the n8n entry point expects. */
function buildPayload({ userId, sessionId, messageId, content, connectionId, replyTo }) {
  return {
    source: 'custom_chat',
    userId,
    sessionId,
    // `chatId` is the Telegram-equivalent routing key, and it is the sessionId.
    // Echo it (or the messageId) back and the gateway knows which device to
    // deliver the reply to - the same role `chat.id` plays in a Telegram flow.
    chatId: sessionId,
    chat_id: sessionId,
    messageId,
    connectionId,
    // Both keys carry the text: different parts of the design doc use each name,
    // so the n8n side can read whichever it already references.
    message: content,
    content,
    replyTo: replyTo || null,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { callWebhook, buildPayload, extractReply };
