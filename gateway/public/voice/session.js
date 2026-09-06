'use strict';

/**
 * Voice session lifecycle over the existing gateway WebSocket.
 *
 * There is no second socket: `voice.*` events and binary audio ride the
 * connection the text client already authenticated and joined. That is what
 * keeps voice and text on one identity, one sessionId and one reconnect story.
 */
class VoiceSession {
  constructor({ bridge, onState, onLevel, onNote, onTranscript }) {
    this.bridge = bridge;
    this.onState = onState;
    this.onLevel = onLevel;
    this.onNote = onNote;
    this.onTranscript = onTranscript;
    this.voiceSessionId = null;
    this.mode = 'ptt';
    this.capture = null;
    this.playback = null;
    this.sequence = 0;
    this.state = 'idle';
    this.stats = { framesOut: 0, framesIn: 0, bytesIn: 0 };
  }

  setState(state) {
    this.state = state;
    this.onState?.(state);
  }

  /** Only meaningful before start(); a live session keeps the mode it opened with. */
  setMode(mode) {
    if (this.state !== 'idle') return false;
    this.mode = mode === 'open' ? 'open' : 'ptt';
    return true;
  }

  async start() {
    const socket = this.bridge.socket();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.onNote?.('Not connected to the gateway yet.');
      return;
    }
    this.setState('starting');
    this.send('voice.session.start', { mode: this.mode });
  }

  /** Called by the bridge for every `voice.*` event from the gateway. */
  async onEvent(event) {
    if (event.event === 'voice.session.started') {
      this.voiceSessionId = event.data.voiceSessionId;
      this.mode = event.data.mode || 'ptt';
      await this.openAudio(event.data);

      if (this.mode === 'open') {
        // Always-on: the microphone stays live from here, including while the
        // assistant speaks. That is what makes barge-in possible without
        // pressing anything - and what makes echo cancellation load-bearing.
        this.capture.setTransmitting(true);
        this.setState('listening');
      } else {
        this.setState('ready');
      }
      if (event.data.engine === 'echo') {
        this.onNote?.('Echo mode: your microphone is mirrored back, with no model attached.');
      } else if (this.mode === 'open') {
        this.onNote?.('Listening. Speak any time — you can interrupt mid-sentence. Use headphones, or Jarvis will hear itself and interrupt its own turn.');
      } else {
        this.onNote?.('Voice session ready. Hold to talk.');
      }
      return;
    }

    if (event.event === 'voice.interrupted') {
      // Drop what is queued rather than letting it play out. Cancelling the
      // model upstream is not enough - buffered audio would still be spoken,
      // which is the usual reason an assistant keeps talking after being
      // interrupted.
      this.playback?.flush();
      return;
    }

    if (event.event === 'voice.transcript') {
      this.onTranscript?.(event.data);
      return;
    }

    if (event.event === 'voice.turn.complete') return;

    if (event.event === 'voice.engine.reconnected') {
      // The upstream connection is capped and gets replaced periodically. The
      // user should hear nothing, so this is not surfaced as a banner.
      return;
    }

    if (event.event === 'voice.session.ended') {
      this.onNote?.(`Voice session ended (${event.data.reason}).`);
      await this.teardown();
      return;
    }

    if (event.event === 'voice.error') {
      this.onNote?.(event.data.message || 'Voice error.');
      // A refusal to start leaves no session to tear down, but a mid-session
      // error might; teardown is idempotent so it is safe either way.
      await this.teardown();
    }
  }

  async openAudio({ inputSampleRate, outputSampleRate, frameMs }) {
    // The two rates differ - the engine takes 16 kHz and returns 24 kHz - so
    // capture and playback are configured separately. Sharing one rate here
    // sounds like chipmunk audio in whichever direction is wrong.
    this.playback = new VoicePlayback({
      sampleRate: outputSampleRate,
      sinkId: VoiceDevices.get('output'),
    });
    await this.playback.start();
    await this.playback.resume();

    this.capture = new VoiceCapture({
      sampleRate: inputSampleRate,
      frameMs,
      deviceId: VoiceDevices.get('input'),
      onLevel: (level) => this.onLevel?.(level),
      onFrame: (pcm) => this.sendAudio(pcm),
    });
    await this.capture.start();
  }

  sendAudio(pcm) {
    const socket = this.bridge.socket();
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // Dropping frames beats queueing them: stale microphone audio is worse
    // than a gap, and bufferedAmount growing means we are already behind.
    if (socket.bufferedAmount > 512 * 1024) return;
    this.sequence += 1;
    this.stats.framesOut += 1;
    socket.send(encodeVoiceFrame(VOICE_FRAME.MIC_AUDIO, this.sequence, pcm));
  }

  /** Called by the bridge for every binary frame from the gateway. */
  onAudio(arrayBuffer) {
    const frame = decodeVoiceFrame(arrayBuffer);
    if (!frame || frame.type !== VOICE_FRAME.ASSISTANT_AUDIO) return;
    this.stats.framesIn += 1;
    this.stats.bytesIn += frame.pcm.byteLength;
    this.playback?.enqueue(frame.pcm);
  }

  setTransmitting(on) {
    // Always-on mode has no press: the microphone is already live and the
    // engine owns the turn edges.
    if (this.mode === 'open') return;
    if (this.state !== 'ready' && this.state !== 'talking') return;

    // Push-to-talk is manual turn detection: the engine's own VAD is off, so
    // these edges are what tells it a turn began and ended.
    if (on) this.playback?.flush(); // barge-in, locally, before the round trip
    this.send(on ? 'voice.activity.start' : 'voice.activity.end', {
      voiceSessionId: this.voiceSessionId,
    });

    this.capture?.setTransmitting(on);
    this.setState(on ? 'talking' : 'ready');
  }

  /** Change devices mid-session; both are safe to call while idle. */
  async useInput(deviceId) {
    VoiceDevices.set('input', deviceId);
    await this.capture?.useDevice(deviceId, this.state === 'talking' || this.mode === 'open');
  }

  async useOutput(deviceId) {
    VoiceDevices.set('output', deviceId);
    await this.playback?.useSink(deviceId);
  }

  send(event, data = {}) {
    const socket = this.bridge.socket();
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      id: `evt_${Math.random().toString(36).slice(2)}`,
      type: 'event',
      event,
      data,
    }));
  }

  async stop() {
    if (this.voiceSessionId) this.send('voice.session.end', { voiceSessionId: this.voiceSessionId });
    await this.teardown();
  }

  async teardown() {
    await this.capture?.stop();
    await this.playback?.stop();
    this.capture = null;
    this.playback = null;
    this.voiceSessionId = null;
    this.sequence = 0;
    this.setState('idle');
  }
}
