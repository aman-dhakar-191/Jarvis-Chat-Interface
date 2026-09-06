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
      // n8n exposes every webhook twice. The client can ask for the test path
      // per message, so switching does not need a redeploy. Derived rather than
      // configured, so it cannot drift from the production URL.
      testWebhookUrl: (env.N8N_WEBHOOK_URL || '').includes('/webhook-test/')
        ? env.N8N_WEBHOOK_URL
        : (env.N8N_WEBHOOK_URL || '').replace('/webhook/', '/webhook-test/'),
    },
    approvalTimeoutMs: int(env, 'APPROVAL_TIMEOUT_MS', 3600000),
    // The voice path. Off unless explicitly enabled, so an existing deployment
    // that pulls this version behaves exactly as it did before.
    voice: {
      enabled: (env.VOICE_ENABLED || '').toLowerCase() === 'true',
      // `echo` mirrors the microphone back with no model and no API key. It is
      // the fastest way to tell a broken browser audio pipeline from a broken
      // model connection, so it stays available rather than being deleted.
      provider: (env.VOICE_PROVIDER || 'gemini').toLowerCase(),
      apiKey: env.GEMINI_API_KEY || env.VOICE_API_KEY || '',
      // A preview model: pin it here and expect to change it. The 2.5
      // native-audio model is the fallback if this one is withdrawn.
      model: env.VOICE_MODEL || 'models/gemini-3.1-flash-live-preview',
      voiceName: env.VOICE_NAME || 'Puck',
      instructions: env.VOICE_INSTRUCTIONS || '',
      // The rates differ by direction: Gemini takes 16 kHz and returns 24 kHz.
      // One shared rate would sound like chipmunk audio in one direction.
      inputSampleRate: int(env, 'VOICE_INPUT_SAMPLE_RATE', 16000),
      outputSampleRate: int(env, 'VOICE_OUTPUT_SAMPLE_RATE', 24000),
      frameMs: int(env, 'VOICE_FRAME_MS', 20),
      maxSessionMs: int(env, 'VOICE_MAX_SESSION_MS', 1800000),
      // Upstream drops a connection roughly every 10 minutes; session
      // resumption makes that invisible, but a revoked key never recovers, so
      // reconnects are bounded rather than infinite.
      maxReconnects: int(env, 'VOICE_MAX_RECONNECTS', 20),
      // 16 kHz PCM16 is 32 kB/s. The default leaves ~3x headroom for bursts
      // after a stall without letting a stuck client saturate the socket.
      maxAudioBytesPerSecond: int(env, 'VOICE_MAX_AUDIO_BYTES_PER_SECOND', 96000),
    },
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
  if (config.voice.enabled && config.voice.provider === 'gemini' && !config.voice.apiKey) {
    config.warnings.push('VOICE_ENABLED=true with VOICE_PROVIDER=gemini but no GEMINI_API_KEY - voice sessions will be refused. Set VOICE_PROVIDER=echo to test the transport without a key.');
  }
  if (config.voice.enabled && config.limits.maxMessageBytes < 4096) {
    config.warnings.push('MAX_MESSAGE_BYTES is very small - voice audio frames may be rejected by the socket.');
  }
  if (config.n8n.responseMode === 'async' && !config.pushSecret) {
    config.warnings.push('N8N_RESPONSE_MODE=async requires PUSH_SECRET, otherwise no reply can ever arrive.');
  }

  return config;
}

module.exports = buildConfig(process.env);
module.exports.buildConfig = buildConfig;
