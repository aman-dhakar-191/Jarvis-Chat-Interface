'use strict';

const { randomUUID } = require('node:crypto');

const ERROR_CODES = {
  AUTH_FAILED: 'AUTH_FAILED',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  INVALID_SESSION: 'INVALID_SESSION',
  RATE_LIMITED: 'RATE_LIMITED',
  N8N_UNAVAILABLE: 'N8N_UNAVAILABLE',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  EXECUTION_TIMEOUT: 'EXECUTION_TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

const MAX_CONTENT_CHARS = 8000;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function eventId() {
  return `evt_${randomUUID()}`;
}

function messageId() {
  return `msg_${randomUUID()}`;
}

function makeEvent(event, { sessionId = null, data = {}, type = 'event', id = eventId() } = {}) {
  return { id, type, event, timestamp: new Date().toISOString(), sessionId, data };
}

function makeAck(eventId, status = 'accepted', extra = {}) {
  return { id: `ack_${randomUUID()}`, type: 'ack', eventId, status, timestamp: new Date().toISOString(), ...extra };
}

function makeError(code, message, { sessionId = null, details = {} } = {}) {
  return makeEvent('error', { sessionId, type: 'error', data: { code, message, ...details } });
}

/**
 * Validate a raw inbound frame. Returns { ok: true, event } or { ok: false, code, message }.
 * The gateway never trusts a client-supplied userId - identity comes from the token.
 */
function parseInbound(raw, { maxBytes }) {
  if (Buffer.byteLength(raw) > maxBytes) {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: `Frame exceeds ${maxBytes} bytes` };
  }

  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: 'Frame is not valid JSON' };
  }

  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: 'Frame must be a JSON object' };
  }
  if (typeof frame.event !== 'string' || frame.event === '') {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: 'Field "event" is required' };
  }
  if (frame.id !== undefined && (typeof frame.id !== 'string' || !ID_PATTERN.test(frame.id))) {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: 'Field "id" must be a short identifier string' };
  }
  if (frame.sessionId !== undefined && frame.sessionId !== null && !ID_PATTERN.test(String(frame.sessionId))) {
    return { ok: false, code: ERROR_CODES.INVALID_SESSION, message: 'Field "sessionId" must be a short identifier string' };
  }

  frame.id = frame.id || eventId();
  frame.data = frame.data && typeof frame.data === 'object' && !Array.isArray(frame.data) ? frame.data : {};
  return { ok: true, event: frame };
}

/** Extra validation for the `user.message` payload. */
function validateUserMessage(data) {
  if (typeof data.content !== 'string' || data.content.trim() === '') {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: 'data.content is required and must be a non-empty string' };
  }
  if (data.content.length > MAX_CONTENT_CHARS) {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: `data.content exceeds ${MAX_CONTENT_CHARS} characters` };
  }
  if (data.messageId !== undefined && !ID_PATTERN.test(String(data.messageId))) {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: 'data.messageId must be a short identifier string' };
  }
  return { ok: true, content: data.content.trim(), messageId: data.messageId ? String(data.messageId) : messageId() };
}

module.exports = {
  ERROR_CODES,
  ID_PATTERN,
  MAX_CONTENT_CHARS,
  eventId,
  messageId,
  makeEvent,
  makeAck,
  makeError,
  parseInbound,
  validateUserMessage,
};
