'use strict';

/**
 * Gemini Live API engine.
 *
 * A WebSocket to the model, held by the gateway so the API key never reaches a
 * browser. Audio in is 16 kHz PCM16; audio out is 24 kHz PCM16 - the rates
 * differ, which is why the protocol reports them separately rather than
 * assuming one.
 *
 * Push-to-talk means we run manual activity detection: automatic VAD is
 * disabled and the client's press/release become activityStart/activityEnd.
 * That keeps silence off the wire, which matters on a free tier billed by
 * session time.
 *
 * Sessions are capped upstream (~10 minutes per connection). The API answers
 * this itself with session resumption: it periodically hands us a handle and
 * warns with `goAway` before dropping us. Reconnecting with the handle keeps
 * the conversation, so the user hears nothing. Doing this transparently is a
 * requirement, not a refinement - an assistant that dies mid-sentence every ten
 * minutes is not usable.
 */

const { WebSocket } = require('ws');
const logger = require('../../logger');

const HOST = 'generativelanguage.googleapis.com';
const PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

class GeminiLiveEngine {
  constructor(config, callbacks = {}, { mode = 'ptt', instructions = '', refreshInstructions = null } = {}) {
    this.config = config.voice;
    this.callbacks = callbacks;
    this.name = 'gemini';
    this.mode = mode;
    this.instructions = instructions || config.voice.instructions || '';
    // Called before every connect, including reconnects. The upstream link is
    // replaced roughly every 10 minutes, so this is a free opportunity to pick
    // up anything learned since the session opened.
    this.refreshInstructions = refreshInstructions;
    this.inputSampleRate = config.voice.inputSampleRate;
    this.outputSampleRate = config.voice.outputSampleRate;

    this.ws = null;
    this.ready = false;
    this.closing = false;
    this.resumeHandle = null;
    this.reconnects = 0;
    // Audio that arrives while the socket is being replaced. Small by design:
    // a reconnect is fast, and holding more than a moment of speech would only
    // deliver a stale turn late.
    this.pending = [];
    this.speaking = false;
  }

  url() {
    return `wss://${HOST}${PATH}?key=${encodeURIComponent(this.config.apiKey)}`;
  }

  setupMessage() {
    const setup = {
      model: this.config.model,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: this.config.voiceName } },
        },
      },
      // Push-to-talk owns the turn boundaries, so the model must not also
      // guess. Always-on mode is the opposite: the model's own detection is
      // what lets the user interrupt without pressing anything, which is the
      // whole point of full duplex.
      realtimeInputConfig: {
        automaticActivityDetection: this.mode === 'open'
          ? {
            disabled: false,
            // Below ~500 ms of trailing silence, natural pauses get cut into
            // fragments, which degrades both transcription and replies.
            silenceDurationMs: this.config.silenceDurationMs,
            prefixPaddingMs: this.config.prefixPaddingMs,
          }
          : { disabled: true },
      },
      // Ask for a resumption handle from the first message, otherwise the first
      // upstream drop loses the conversation.
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (this.instructions) {
      setup.systemInstruction = { parts: [{ text: this.instructions }] };
    }
    return { setup };
  }

  async open() {
    if (this.refreshInstructions) {
      try {
        const fresh = await this.refreshInstructions();
        if (fresh) this.instructions = fresh;
      } catch (err) {
        // Memory is a nice-to-have; never let it stop a session opening.
        logger.warn('instruction refresh failed', { error: err.message });
      }
    }
    return this.connect();
  }

  connect() {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(this.url());
      } catch (err) {
        return reject(err);
      }
      this.ws = socket;
      this.ready = false;

      const failFast = (err) => {
        socket.removeAllListeners();
        try { socket.close(); } catch { /* already gone */ }
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      socket.once('error', failFast);
      socket.once('open', () => socket.send(JSON.stringify(this.setupMessage())));

      socket.on('message', (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString('utf8'));
        } catch {
          return;
        }
        if (message.setupComplete && !this.ready) {
          this.ready = true;
          socket.off('error', failFast);
          this.attachSteadyStateHandlers(socket);
          this.flushPending();
          return resolve();
        }
        this.handleMessage(message);
      });

      socket.once('close', (code, reason) => {
        if (this.ready) return; // steady-state handler owns this
        failFast(new Error(`upstream closed during setup: ${code} ${reason?.toString() || ''}`));
      });
    });
  }

  attachSteadyStateHandlers(socket) {
    socket.on('error', (err) => {
      logger.warn('gemini socket error', { error: err.message });
    });
    socket.once('close', (code, reason) => {
      this.ready = false;
      if (this.closing) return;
      logger.info('gemini socket closed, reconnecting', {
        code,
        reason: reason?.toString().slice(0, 200),
        resumable: Boolean(this.resumeHandle),
      });
      this.reconnect();
    });
  }

  handleMessage(message) {
    // The server hands out a fresh handle periodically. Keep the latest: it is
    // what makes a reconnect invisible.
    if (message.sessionResumptionUpdate?.newHandle) {
      this.resumeHandle = message.sessionResumptionUpdate.newHandle;
      return;
    }
    // Advance warning that the connection is about to be dropped. Reconnect
    // now rather than waiting for the close, so the gap lands between turns.
    if (message.goAway) {
      logger.info('gemini goAway', { timeLeft: message.goAway.timeLeft });
      if (!this.speaking) this.reconnect();
      return;
    }
    if (message.toolCall) {
      // Phase 4. Acknowledged here so an unexpected tool call is visible in
      // logs rather than silently dropped.
      logger.warn('gemini requested a tool call, but tools are not wired yet', {
        names: (message.toolCall.functionCalls || []).map((c) => c.name),
      });
      return;
    }

    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) {
      this.speaking = false;
      this.callbacks.onInterrupted?.();
    }

    for (const part of content.modelTurn?.parts || []) {
      const data = part.inlineData?.data;
      if (!data) continue;
      this.speaking = true;
      this.callbacks.onAudio?.(Buffer.from(data, 'base64'));
    }

    if (content.inputTranscription?.text) {
      this.callbacks.onTranscript?.({ role: 'user', text: content.inputTranscription.text, final: false });
    }
    if (content.outputTranscription?.text) {
      this.callbacks.onTranscript?.({ role: 'assistant', text: content.outputTranscription.text, final: false });
    }
    if (content.turnComplete) {
      this.speaking = false;
      this.callbacks.onTurnComplete?.();
    }
  }

  async reconnect() {
    if (this.closing) return;
    this.reconnects += 1;
    // Bounded, because a key that has been revoked will never succeed and
    // retrying forever would hide the real error from the user.
    if (this.reconnects > this.config.maxReconnects) {
      return this.callbacks.onError?.({
        code: 'VOICE_UNAVAILABLE',
        message: 'Lost the voice engine connection and could not re-establish it.',
        fatal: true,
      });
    }
    try { this.ws?.removeAllListeners(); } catch { /* already gone */ }
    try {
      await this.open();
      logger.info('gemini reconnected', { attempt: this.reconnects, resumed: Boolean(this.resumeHandle) });
      this.callbacks.onReconnected?.({ resumed: Boolean(this.resumeHandle) });
    } catch (err) {
      logger.warn('gemini reconnect failed', { attempt: this.reconnects, error: err.message });
      const backoff = Math.min(8000, 250 * 2 ** (this.reconnects - 1));
      const timer = setTimeout(() => this.reconnect(), backoff);
      timer.unref?.();
    }
  }

  send(payload) {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  sendAudio(pcm) {
    const chunk = {
      realtimeInput: {
        audio: {
          data: pcm.toString('base64'),
          mimeType: `audio/pcm;rate=${this.inputSampleRate}`,
        },
      },
    };
    if (!this.send(chunk)) {
      this.pending.push(chunk);
      // Cap the backlog at roughly a second of audio.
      if (this.pending.length > 50) this.pending.shift();
    }
  }

  flushPending() {
    const queued = this.pending;
    this.pending = [];
    for (const chunk of queued) this.send(chunk);
  }

  // In `open` mode the model detects turns itself; sending manual activity
  // markers alongside automatic detection is a protocol error, not a hint.
  activityStart() {
    if (this.mode !== 'ptt') return;
    this.send({ realtimeInput: { activityStart: {} } });
  }

  activityEnd() {
    if (this.mode !== 'ptt') return;
    this.send({ realtimeInput: { activityEnd: {} } });
  }

  /** Barge-in. The model drops its turn when the user starts a new one. */
  cancel() {
    this.speaking = false;
    this.activityStart();
  }

  async close() {
    this.closing = true;
    this.ready = false;
    try {
      this.ws?.removeAllListeners();
      this.ws?.close();
    } catch { /* already gone */ }
    this.ws = null;
  }
}

module.exports = { GeminiLiveEngine };
