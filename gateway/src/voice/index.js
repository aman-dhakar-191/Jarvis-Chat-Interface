'use strict';

/**
 * Voice path.
 *
 * Phase 1 built the transport; Phase 2 puts a realtime model behind it. The
 * gateway holds the engine connection, so the API key never reaches a browser
 * and a compromised client cannot forge a tool call - it only ever sends audio.
 *
 * Audio does not go through n8n, and the text path does not come through here.
 */

const logger = require('../logger');
const protocol = require('../protocol');
const frames = require('./frames');
const { createEngine, MODES } = require('./engine');
const memory = require('./memory');

const { ERROR_CODES } = protocol;

function voiceError(connection, code, message, details = {}) {
  connection.send(protocol.makeEvent('voice.error', {
    sessionId: connection.sessionId,
    data: { code, message, ...details },
  }));
}

function voiceEvent(connection, event, data) {
  connection.send(protocol.makeEvent(event, { sessionId: connection.sessionId, data }));
}

async function handleSessionStart(ctx, connection, event) {
  const { config, voiceSessions } = ctx;

  if (!config.voice.enabled) {
    return voiceError(connection, ERROR_CODES.VOICE_UNAVAILABLE, 'Voice is not enabled on this gateway. Set VOICE_ENABLED=true.');
  }
  if (config.voice.provider === 'gemini' && !config.voice.apiKey) {
    return voiceError(connection, ERROR_CODES.VOICE_UNAVAILABLE, 'VOICE_PROVIDER=gemini needs GEMINI_API_KEY.');
  }

  // Turn-taking mode is the client's to pick, but not to invent.
  const mode = MODES.includes(event.data.mode) ? event.data.mode : 'ptt';

  const sessionId = event.sessionId || connection.sessionId || connection.defaultSessionId;
  connection.sessionId = sessionId ? String(sessionId) : connection.sessionId;

  const session = voiceSessions.start({
    connectionId: connection.id,
    userId: connection.userId,
    sessionId: connection.sessionId,
    maxSessionMs: config.voice.maxSessionMs,
    onExpire: (voiceSessionId) => {
      endSession(ctx, connection, voiceSessionId, 'expired');
    },
  });

  let engine;
  try {
    // Loaded once here, then again on each upstream reconnect - the engine
    // calls back before every connect, so a 30-minute session picks up
    // anything learned in the meantime for free.
    const loadInstructions = async () => memory.buildInstructions(config, await memory.fetchSnapshot(config));

    engine = createEngine(config, buildCallbacks(ctx, connection, session), {
      mode,
      instructions: await loadInstructions(),
      refreshInstructions: loadInstructions,
    });
    session.engine = engine;
    session.mode = mode;
    await engine.open();
  } catch (err) {
    logger.error('voice engine failed to open', { error: err.message, provider: config.voice.provider });
    voiceSessions.end(session.voiceSessionId, 'engine-failed');
    return voiceError(connection, ERROR_CODES.VOICE_UNAVAILABLE, `Could not reach the voice engine: ${err.message}`);
  }

  // A session that was ended while the engine was still opening must not come
  // back to life; the store is the authority on whether it still exists.
  if (!voiceSessions.get(session.voiceSessionId)) {
    await engine.close();
    return;
  }

  session.inputSampleRate = engine.inputSampleRate;
  session.outputSampleRate = engine.outputSampleRate;

  connection.send(protocol.makeAck(event.id, 'accepted', { voiceSessionId: session.voiceSessionId }));
  voiceEvent(connection, 'voice.session.started', {
    voiceSessionId: session.voiceSessionId,
    // The two rates differ - Gemini takes 16 kHz and returns 24 kHz - so the
    // client is told both rather than assuming one. Getting this wrong sounds
    // like chipmunk audio, which is why it is not a single field.
    inputSampleRate: engine.inputSampleRate,
    outputSampleRate: engine.outputSampleRate,
    frameMs: config.voice.frameMs,
    engine: engine.name,
    // `open` means the microphone stays live while the assistant speaks and the
    // engine decides the turns; `ptt` means the client does.
    mode,
    expiresAt: new Date(session.expiresAt).toISOString(),
  });

  logger.info('voice session started', {
    voiceSessionId: session.voiceSessionId,
    connectionId: connection.id,
    userId: connection.userId,
    engine: engine.name,
    mode,
  });
}

function buildCallbacks(ctx, connection, session) {
  return {
    onAudio: (pcm) => {
      session.outSequence += 1;
      session.bytesOut += pcm.length;
      connection.sendBinary(frames.encode(frames.FRAME.ASSISTANT_AUDIO, session.outSequence, pcm));
    },
    onTranscript: ({ role, text, final }) => {
      voiceEvent(connection, 'voice.transcript', {
        voiceSessionId: session.voiceSessionId,
        role,
        text,
        final: Boolean(final),
      });
    },
    onInterrupted: () => {
      // The client must drop buffered audio, not merely stop requesting more:
      // whatever is already queued would otherwise still be spoken.
      voiceEvent(connection, 'voice.interrupted', { voiceSessionId: session.voiceSessionId });
    },
    onTurnComplete: () => {
      voiceEvent(connection, 'voice.turn.complete', { voiceSessionId: session.voiceSessionId });
    },
    onReconnected: ({ resumed } = {}) => {
      // Informational. The user should hear nothing; the UI may want to know.
      voiceEvent(connection, 'voice.engine.reconnected', {
        voiceSessionId: session.voiceSessionId,
        resumed: Boolean(resumed),
      });
    },
    onError: ({ code, message, fatal }) => {
      voiceError(connection, code || ERROR_CODES.VOICE_UNAVAILABLE, message, {
        voiceSessionId: session.voiceSessionId,
      });
      if (fatal) endSession(ctx, connection, session.voiceSessionId, 'engine-error');
    },
  };
}

function endSession(ctx, connection, voiceSessionId, reason) {
  const session = ctx.voiceSessions.end(voiceSessionId, reason);
  if (!session) return null;
  session.engine?.close().catch(() => {});
  voiceEvent(connection, 'voice.session.ended', { voiceSessionId, reason });
  logger.info('voice session ended', {
    voiceSessionId,
    reason,
    bytesIn: session.bytesIn,
    bytesOut: session.bytesOut,
    durationMs: Date.now() - session.startedAt,
  });
  return session;
}

function handleSessionEnd(ctx, connection, event) {
  const requested = event.data.voiceSessionId ? String(event.data.voiceSessionId) : null;
  const session = requested ? ctx.voiceSessions.get(requested) : ctx.voiceSessions.forConnection(connection.id);

  // Idempotent: a client that reloaded mid-session sends this after the socket
  // is already gone, and that is not an error.
  connection.send(protocol.makeAck(event.id, 'accepted'));
  if (!session || session.connectionId !== connection.id) return;
  endSession(ctx, connection, session.voiceSessionId, 'client');
}

/** Push-to-talk boundaries. Manual VAD means the client owns the turn edges. */
function handleActivity(ctx, connection, event, starting) {
  const session = ctx.voiceSessions.forConnection(connection.id);
  if (!session?.engine) return;
  // In always-on mode the engine detects turns itself. A client that sends
  // these anyway is ignored rather than errored: it is harmless, and the mode
  // can change between a press and its release.
  if (session.mode === 'open') return;
  if (starting) {
    session.talking = true;
    // Speaking over the assistant is barge-in: tell the client to drop what it
    // has buffered before the engine has even reacted.
    voiceEvent(connection, 'voice.interrupted', { voiceSessionId: session.voiceSessionId });
    session.engine.activityStart();
  } else {
    session.talking = false;
    session.engine.activityEnd();
  }
}

/**
 * A binary frame arrived. Hot path - runs every ~20 ms per active session, so
 * it allocates nothing beyond the forward and never logs per frame.
 */
function handleAudio(ctx, connection, raw) {
  const { config, voiceSessions } = ctx;
  const session = voiceSessions.forConnection(connection.id);
  // Audio with no session is dropped in silence: it is the expected shape of a
  // race between voice.session.end and frames already in flight.
  if (!session?.engine) return;

  const decoded = frames.decode(raw);
  if (!decoded.ok) {
    logger.warn('bad voice frame', { voiceSessionId: session.voiceSessionId, reason: decoded.reason });
    return voiceError(connection, ERROR_CODES.INVALID_MESSAGE, `Malformed voice frame: ${decoded.reason}`, {
      voiceSessionId: session.voiceSessionId,
    });
  }
  if (decoded.type !== frames.FRAME.MIC_AUDIO) {
    return voiceError(connection, ERROR_CODES.INVALID_MESSAGE, 'Only microphone audio may be sent by a client', {
      voiceSessionId: session.voiceSessionId,
    });
  }

  // Sliding one-second byte budget: a stuck client that spins sending audio
  // would otherwise pin the event loop for every other connection.
  const now = Date.now();
  if (now - session.windowStartedAt >= 1000) {
    session.windowStartedAt = now;
    session.windowBytes = 0;
  }
  session.windowBytes += decoded.pcm.length;
  if (session.windowBytes > config.voice.maxAudioBytesPerSecond) {
    logger.warn('voice flood, ending session', {
      voiceSessionId: session.voiceSessionId,
      windowBytes: session.windowBytes,
    });
    voiceError(connection, ERROR_CODES.RATE_LIMITED, 'Audio arrived faster than the session allows', {
      voiceSessionId: session.voiceSessionId,
    });
    return endSession(ctx, connection, session.voiceSessionId, 'flood');
  }

  session.inSequence = decoded.sequence;
  session.bytesIn += decoded.pcm.length;
  session.engine.sendAudio(decoded.pcm);
}

function handle(ctx, connection, event) {
  switch (event.event) {
    case 'voice.session.start':
      return handleSessionStart(ctx, connection, event);
    case 'voice.session.end':
      return handleSessionEnd(ctx, connection, event);
    case 'voice.activity.start':
      return handleActivity(ctx, connection, event, true);
    case 'voice.activity.end':
      return handleActivity(ctx, connection, event, false);
    default:
      return voiceError(connection, ERROR_CODES.INVALID_MESSAGE, `Unsupported voice event "${event.event}"`);
  }
}

module.exports = { handle, handleAudio, endSession };
