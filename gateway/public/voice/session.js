'use strict';

/**
 * Voice session lifecycle over the existing gateway WebSocket.
 *
 * There is no second socket: `voice.*` events and binary audio ride the
 * connection the text client already authenticated and joined. That is what
 * keeps voice and text on one identity, one sessionId and one reconnect story.
 */
class VoiceSession {
  constructor({ bridge, onState, onLevel, onNote }) {
    this.bridge = bridge;
    this.onState = onState;
    this.onLevel = onLevel;
    this.onNote = onNote;
    this.voiceSessionId = null;
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

  async start() {
    const socket = this.bridge.socket();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.onNote?.('Not connected to the gateway yet.');
      return;
    }
    this.setState('starting');
    socket.send(JSON.stringify({
      id: `evt_${Math.random().toString(36).slice(2)}`,
      type: 'event',
      event: 'voice.session.start',
      data: {},
    }));
  }

  /** Called by the bridge for every `voice.*` event from the gateway. */
  async onEvent(event) {
    if (event.event === 'voice.session.started') {
      this.voiceSessionId = event.data.voiceSessionId;
      await this.openAudio(event.data);
      this.setState('ready');
      this.onNote?.(
        event.data.engine === 'echo'
          ? 'Voice transport is up. Phase 1 echoes your microphone back — there is no model yet.'
          : 'Voice session ready.',
      );
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

  async openAudio({ sampleRate, frameMs }) {
    this.playback = new VoicePlayback({ sampleRate });
    await this.playback.start();
    await this.playback.resume();

    this.capture = new VoiceCapture({
      sampleRate,
      frameMs,
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
    if (this.state !== 'ready' && this.state !== 'talking') return;
    this.capture?.setTransmitting(on);
    this.setState(on ? 'talking' : 'ready');
  }

  async stop() {
    const socket = this.bridge.socket();
    if (socket && socket.readyState === WebSocket.OPEN && this.voiceSessionId) {
      socket.send(JSON.stringify({
        id: `evt_${Math.random().toString(36).slice(2)}`,
        type: 'event',
        event: 'voice.session.end',
        data: { voiceSessionId: this.voiceSessionId },
      }));
    }
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
