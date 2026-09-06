'use strict';

/**
 * The Phase 1 engine, kept as a first-class implementation rather than deleted.
 *
 * It mirrors the microphone back, which makes it the fastest way to tell a
 * broken browser audio pipeline from a broken model connection: if echo sounds
 * right and Gemini does not, the bug is not in the browser. It also lets the
 * whole voice path be exercised in tests and offline, with no API key.
 */
class EchoEngine {
  constructor(config, callbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
    this.name = 'echo';
    // Echo returns what it was given, so both directions run at input rate.
    this.inputSampleRate = config.voice.inputSampleRate;
    this.outputSampleRate = config.voice.inputSampleRate;
  }

  async open() {}

  sendAudio(pcm) {
    this.callbacks.onAudio?.(pcm);
  }

  activityStart() {}

  activityEnd() {
    this.callbacks.onTurnComplete?.();
  }

  cancel() {}

  async close() {}
}

module.exports = { EchoEngine };
