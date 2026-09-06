'use strict';

/**
 * Microphone capture. Owns getUserMedia, the AudioContext and the capture
 * worklet, and hands finished PCM16 frames to a callback.
 *
 * The context is created once and kept: push-to-talk mutes the worklet rather
 * than stopping the graph, because tearing down and rebuilding an AudioContext
 * costs hundreds of milliseconds and browsers rate-limit the churn.
 */
class VoiceCapture {
  constructor({ sampleRate, frameMs, onFrame, onLevel, deviceId = '' }) {
    this.sampleRate = sampleRate;
    this.deviceId = deviceId;
    this.frameMs = frameMs;
    this.onFrame = onFrame;
    this.onLevel = onLevel;
    this.context = null;
    this.stream = null;
    this.node = null;
    this.started = false;
  }

  async start() {
    if (this.started) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      // Full duplex means the microphone stays open while the speaker plays,
      // so without echo cancellation the assistant hears itself and interrupts
      // its own turn. These three are not optional.
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        // `exact` rather than `ideal`: silently recording from the wrong
        // microphone is worse than failing and falling back visibly.
        ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
      },
    });

    // Ask for the session rate directly; where the browser refuses, the worklet
    // resamples from whatever it gave us instead.
    try {
      this.context = new AudioContext({ sampleRate: this.sampleRate });
    } catch {
      this.context = new AudioContext();
    }
    await this.context.audioWorklet.addModule('/voice/worklets/capture-worklet.js');

    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: {
        targetSampleRate: this.sampleRate,
        frameSamples: Math.round((this.sampleRate * this.frameMs) / 1000),
      },
    });

    this.node.port.onmessage = (event) => {
      const pcm = event.data;
      if (!(pcm instanceof ArrayBuffer)) return;
      if (this.onLevel) this.onLevel(peakOf(new Int16Array(pcm)));
      this.onFrame(pcm);
    };

    source.connect(this.node);
    this.started = true;
  }

  /**
   * Switch microphone without dropping the voice session. The graph is rebuilt
   * because a MediaStreamSource is bound to the stream it was created from.
   */
  async useDevice(deviceId, transmitting) {
    if (deviceId === this.deviceId) return;
    this.deviceId = deviceId;
    await this.stop();
    await this.start();
    this.setTransmitting(Boolean(transmitting));
  }

  /** Push-to-talk. `true` means the microphone is live. */
  setTransmitting(on) {
    this.node?.port.postMessage({ type: 'mute', value: !on });
    if (!on && this.onLevel) this.onLevel(0);
  }

  async stop() {
    this.started = false;
    this.node?.port.postMessage({ type: 'mute', value: true });
    this.node?.disconnect();
    for (const track of this.stream?.getTracks() || []) track.stop();
    await this.context?.close().catch(() => {});
    this.context = null;
    this.stream = null;
    this.node = null;
  }
}

function peakOf(samples) {
  let peak = 0;
  // Every fourth sample is plenty for a level meter and a quarter of the work.
  for (let i = 0; i < samples.length; i += 4) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  return peak / 32768;
}
