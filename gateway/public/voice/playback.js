'use strict';

/**
 * Assistant audio playback. A queue in a worklet rather than a chain of
 * AudioBufferSourceNodes, because the queue can be dropped in one message when
 * the user interrupts - scheduled buffer sources cannot be un-scheduled
 * cleanly once started.
 */
class VoicePlayback {
  constructor({ sampleRate, onQueue }) {
    this.sampleRate = sampleRate;
    this.onQueue = onQueue;
    this.context = null;
    this.node = null;
  }

  async start() {
    if (this.node) return;
    this.context = new AudioContext();
    await this.context.audioWorklet.addModule('/voice/worklets/playback-worklet.js');
    this.node = new AudioWorkletNode(this.context, 'playback-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { sourceSampleRate: this.sampleRate },
    });
    this.node.port.onmessage = (event) => {
      if (event.data?.type === 'queued' && this.onQueue) this.onQueue(event.data.samples);
    };
    this.node.connect(this.context.destination);
  }

  /** A user gesture is required before audio may play; call this from a click. */
  async resume() {
    if (this.context?.state === 'suspended') await this.context.resume();
  }

  enqueue(pcmBuffer) {
    this.node?.port.postMessage(pcmBuffer, [pcmBuffer]);
  }

  /** Barge-in: drop everything not yet played. */
  flush() {
    this.node?.port.postMessage({ type: 'flush' });
  }

  async stop() {
    this.flush();
    this.node?.disconnect();
    await this.context?.close().catch(() => {});
    this.context = null;
    this.node = null;
  }
}
