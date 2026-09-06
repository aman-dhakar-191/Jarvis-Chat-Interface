'use strict';

/**
 * The voice engine adapter boundary.
 *
 * Everything provider-specific lives behind this interface, so swapping Gemini
 * for another realtime model is a new file in engines/ rather than a rewrite.
 * Nothing above this line knows about WebSocket frame shapes, base64, model
 * names or sample rates.
 *
 *   await engine.open()          establish the upstream session
 *   engine.sendAudio(pcm)        raw PCM16 at engine.inputSampleRate
 *   engine.activityStart()       user began speaking (manual VAD / push-to-talk)
 *   engine.activityEnd()         user stopped speaking
 *   engine.cancel()              abandon the current assistant turn
 *   await engine.close()
 *
 * Callbacks, all optional: onAudio(pcm), onTranscript({ role, text, final }),
 * onInterrupted(), onTurnComplete(), onReconnected(), onError({ code, message,
 * fatal }).
 *
 * Engines must never throw into the caller: transport problems arrive through
 * onError, because the gateway decides whether the client sees them.
 */

/**
 * Turn-taking modes, chosen per session by the client:
 *
 *   ptt   push-to-talk. The client owns the turn edges and the engine's own
 *         voice activity detection is disabled. Silence never reaches the
 *         model, which matters on a tier billed by session time.
 *
 *   open  always listening. The engine detects speech itself, so the user can
 *         speak while the assistant is speaking - genuine full duplex, and the
 *         only mode where barge-in happens without pressing anything.
 */
const MODES = ['ptt', 'open'];

function createEngine(config, callbacks, { mode = 'ptt' } = {}) {
  const provider = config.voice.provider;
  if (provider === 'echo') {
    const { EchoEngine } = require('./engines/echo');
    return new EchoEngine(config, callbacks, { mode });
  }
  if (provider === 'gemini') {
    const { GeminiLiveEngine } = require('./engines/gemini');
    return new GeminiLiveEngine(config, callbacks, { mode });
  }
  throw new Error(`Unknown VOICE_PROVIDER "${provider}"`);
}

module.exports = { createEngine, MODES };
