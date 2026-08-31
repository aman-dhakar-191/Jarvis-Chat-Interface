'use strict';

function int(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function list(env, name) {
  return (env[name] || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// AUTH_TOKENS entries are `token` or `token:userId`.
function parseTokens(env) {
  const credentials = new Map();
  for (const entry of list(env, 'AUTH_TOKENS')) {
    const separator = entry.indexOf(':');
    const token = separator === -1 ? entry : entry.slice(0, separator);
    const userId = separator === -1 ? 'user_default' : entry.slice(separator + 1).trim();
    if (token) credentials.set(token, userId || 'user_default');
  }
  return credentials;
}

function buildConfig(env = process.env) {
  const responseMode = (env.N8N_RESPONSE_MODE || 'sync').toLowerCase();
  if (responseMode !== 'sync' && responseMode !== 'async') {
    throw new Error(`N8N_RESPONSE_MODE must be "sync" or "async", got "${responseMode}"`);
  }

  const config = {
    port: int(env, 'PORT', 3000),
    tokens: parseTokens(env),
    allowedOrigins: list(env, 'ALLOWED_ORIGINS'),
    n8n: {
      webhookUrl: env.N8N_WEBHOOK_URL || '',
      webhookSecret: env.N8N_WEBHOOK_SECRET || '',
      responseMode,
      timeoutMs: int(env, 'N8N_TIMEOUT_MS', 120000),
      responsePath: env.N8N_RESPONSE_PATH || '',
      // Approval resume URLs must start with this. Defaults to the n8n origin
      // derived from the webhook URL; set to '*' to disable the check.
      resumeUrlPrefix: (env.N8N_RESUME_URL_PREFIX || '').trim(),
    },
    approvalTimeoutMs: int(env, 'APPROVAL_TIMEOUT_MS', 3600000),
    pushSecret: env.PUSH_SECRET || '',
    // The conversation key handed to n8n. Stable by design: the same value on
    // every device and across reinstalls, so Jarvis keeps one memory thread.
    // Defaults to `session_<userId>` when unset.
    defaultSessionId: (env.DEFAULT_SESSION_ID || '').trim(),
    limits: {
      maxMessageBytes: int(env, 'MAX_MESSAGE_BYTES', 32 * 1024),
      maxInflightPerConnection: int(env, 'MAX_INFLIGHT_PER_CONNECTION', 4),
      heartbeatIntervalMs: int(env, 'HEARTBEAT_INTERVAL_MS', 30000),
    },
  };

  config.authEnabled = config.tokens.size > 0;

  if (config.n8n.resumeUrlPrefix === '*') {
    config.n8n.resumeUrlPrefix = '';
  } else if (!config.n8n.resumeUrlPrefix && config.n8n.webhookUrl) {
    try {
      config.n8n.resumeUrlPrefix = new URL(config.n8n.webhookUrl).origin;
    } catch {
      config.n8n.resumeUrlPrefix = '';
    }
  }

  // Warnings, not failures: an unconfigured gateway should still boot so the UI
  // can be opened and the misconfiguration seen.
  config.warnings = [];
  if (!config.authEnabled) {
    config.warnings.push('AUTH_TOKENS is empty - the gateway accepts any client. Do not expose this to the internet.');
  }
  if (!config.n8n.webhookUrl) {
    config.warnings.push('N8N_WEBHOOK_URL is empty - user messages will fail with N8N_UNAVAILABLE.');
  }
  if (!config.pushSecret) {
    config.warnings.push('PUSH_SECRET is empty - POST /api/push is disabled.');
  }
  if (config.n8n.responseMode === 'async' && !config.pushSecret) {
    config.warnings.push('N8N_RESPONSE_MODE=async requires PUSH_SECRET, otherwise no reply can ever arrive.');
  }

  return config;
}

module.exports = buildConfig(process.env);
module.exports.buildConfig = buildConfig;
