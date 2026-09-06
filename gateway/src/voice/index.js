'use strict';

/**
 * Voice path - Phase 1: transport only.
 *
 * There is no engine here yet, by design. This phase closes the loop
 * mic -> gateway -> speaker by echoing audio straight back, so the browser
 * audio pipeline (AudioWorklet capture, resampling, PCM16 framing, playback
 * queue) can be proven correct before any model is involved. When the engine
 * lands in Phase 2 it replaces `echo` and nothing else moves.
 *
 * The text path does not pass through this file.
 */

const logger = require('../logger');
const protocol = require('../protocol');
const frames = require('./frames');

const { ERROR_CODES } = protocol;

function voiceError(connection, code, message, details = {}) {
  connection.send(protocol.makeEvent('voice.error', {
    sessionId: connection.sessionId,
    data: { code, message, ...details },
  }));
}

function handleSessionStart(ctx, connection, event) {
  const { config, voiceSessions } = ctx;

  if (!config.voice.enabled) {
    return voiceError(connection, ERROR_CODES.VOICE_UNAVAILABLE, 'Voice is not enabled on this gateway. Set VOICE_ENABLED=true.');
  }

  const sessionId = event.sessionId || connection.sessionId || connection.defaultSessionId;
  connection.sessionId = sessionId ? String(sessionId) : connection.sessionId;

  const session = voiceSessions.start({
    connectionId: connection.id,
    userId: connection.userId,
    sessionId: connection.sessionId,
    sampleRate: config.voice.sampleRate,
    maxSessionMs: config.voice.maxSessionMs,
    onExpire: (voiceSessionId) => {
      connection.send(protocol.makeEvent('voice.session.ended', {
        sessionId: connection.sessionId,
        data: { voiceSessionId, reason: 'expired' },
      }));
    },
  });

  connection.send(protocol.makeAck(event.id, 'accepted', { voiceSessionId: session.voiceSessionId }));
  connection.send(protocol.makeEvent('voice.session.started', {
    sessionId: connection.sessionId,
    data: {
      voiceSessionId: session.voiceSessionId,
      // The client learns the audio shape rather than hard-coding it, so an
      // engine swap that changes rates does not need a client release.
      sampleRate: session.sampleRate,
      frameMs: config.voice.frameMs,
      // Phase 1 has no model. Say so explicitly rather than letting the UI
      // imply Jarvis is listening.
      engine: 'echo',
      expiresAt: new Date(session.expiresAt).toISOString(),
    },
  }));

  logger.info('voice session started', {
    voiceSessionId: session.voiceSessionId,
    connectionId: connection.id,
    userId: connection.userId,
    engine: 'echo',
  });
}

function handleSessionEnd(ctx, connection, event) {
  const { voiceSessions } = ctx;
  const requested = event.data.voiceSessionId ? String(event.data.voiceSessionId) : null;
  const session = requested ? voiceSessions.get(requested) : voiceSessions.forConnection(connection.id);

  // Idempotent: ending an already-ended session is not an error, because a
  // client that reloads mid-session will send this after the socket is gone.
  connection.send(protocol.makeAck(event.id, 'accepted'));
  if (!session || session.connectionId !== connection.id) return;

  voiceSessions.end(session.voiceSessionId, 'client');
  connection.send(protocol.makeEvent('voice.session.ended', {
    sessionId: connection.sessionId,
    data: { voiceSessionId: session.voiceSessionId, reason: 'client' },
  }));
  logger.info('voice session ended', {
    voiceSessionId: session.voiceSessionId,
    bytesIn: session.bytesIn,
    bytesOut: session.bytesOut,
    durationMs: Date.now() - session.startedAt,
  });
}

/**
 * A binary frame arrived. Hot path - runs every ~20 ms per active session, so
 * it does no allocation beyond the echo itself and never logs per frame.
 */
function handleAudio(ctx, connection, raw) {
  const { config, voiceSessions } = ctx;
  const session = voiceSessions.forConnection(connection.id);
  // Audio with no session is dropped in silence. It is the expected shape of a
  // race between `voice.session.end` and frames already in flight, and erroring
  // on it would spam a client that did nothing wrong.
  if (!session) return;

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

  // Sliding one-second byte budget. A stuck client that spins sending audio
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
    voiceSessions.end(session.voiceSessionId, 'flood');
    voiceError(connection, ERROR_CODES.RATE_LIMITED, 'Audio arrived faster than the session allows', {
      voiceSessionId: session.voiceSessionId,
    });
    return connection.send(protocol.makeEvent('voice.session.ended', {
      sessionId: connection.sessionId,
      data: { voiceSessionId: session.voiceSessionId, reason: 'flood' },
    }));
  }

  session.inSequence = decoded.sequence;
  session.bytesIn += decoded.pcm.length;

  // Phase 1: the "engine" is a mirror. Phase 2 replaces this line.
  echo(connection, session, decoded.pcm);
}

function echo(connection, session, pcm) {
  session.outSequence += 1;
  session.bytesOut += pcm.length;
  connection.sendBinary(frames.encode(frames.FRAME.ASSISTANT_AUDIO, session.outSequence, pcm));
}

function handle(ctx, connection, event) {
  switch (event.event) {
    case 'voice.session.start':
      return handleSessionStart(ctx, connection, event);
    case 'voice.session.end':
      return handleSessionEnd(ctx, connection, event);
    default:
      return voiceError(connection, ERROR_CODES.INVALID_MESSAGE, `Unsupported voice event "${event.event}"`);
  }
}

module.exports = { handle, handleAudio };
