'use strict';

const { timingSafeEqual } = require('node:crypto');

/** Constant-time string compare that does not leak length through early return. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    // Still burn a comparison so the timing profile does not depend on length alone.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Pull the bearer token off an upgrade request.
 * Accepts, in order: an Authorization header (Android/CLI), a `bearer` WebSocket
 * subprotocol (browsers), or a `?token=` query parameter (curl, quick testing).
 */
function extractToken(req) {
  const header = req.headers.authorization;
  if (header && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  // Browsers cannot set headers on a WebSocket handshake but can offer
  // subprotocols, so `['bearer', <token>]` keeps the token out of the URL
  // (and therefore out of proxy and access logs).
  const offered = req.headers['sec-websocket-protocol'];
  if (offered) {
    const parts = offered.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2 && parts[0].toLowerCase() === 'bearer') {
      return parts[1];
    }
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (token) return token.trim();
  } catch {
    /* malformed URL - treated as no token */
  }
  return null;
}

function authenticate(req, config) {
  if (!config.authEnabled) {
    return { ok: true, userId: 'user_dev', anonymous: true };
  }
  const token = extractToken(req);
  if (!token) {
    return { ok: false, reason: 'missing token' };
  }
  for (const [candidate, userId] of config.tokens) {
    if (safeEqual(candidate, token)) return { ok: true, userId, anonymous: false };
  }
  return { ok: false, reason: 'unknown token' };
}

function originAllowed(req, config) {
  if (config.allowedOrigins.length === 0) return true;
  const origin = req.headers.origin;
  // Non-browser clients (Android, curl) send no Origin header; the token is their gate.
  if (!origin) return true;
  return config.allowedOrigins.includes(origin);
}

module.exports = { authenticate, originAllowed, extractToken, safeEqual };
