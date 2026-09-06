/**
 * Microphone capture worklet.
 *
 * The AudioContext runs at whatever rate the device gives us (commonly 48 kHz);
 * the gateway wants a fixed rate (16 kHz). Resampling here, on the audio
 * thread, means every stage downstream - framing, transport, the engine - sees
 * one rate and never has to care what hardware produced it.
 *
 * Linear interpolation is enough: we are downsampling speech for a model, not
 * mastering audio, and a polyphase filter would cost more than it returns.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { targetSampleRate, frameSamples } = options.processorOptions;
    this.target = targetSampleRate;
    this.frameSamples = frameSamples;
    this.ratio = sampleRate / this.target;
    this.pending = new Float32Array(0);
    // Fractional read position carried across process() calls, so frame
    // boundaries do not introduce a click every 128 samples.
    this.phase = 0;
    this.out = new Int16Array(this.frameSamples);
    this.outLength = 0;
    this.muted = true;

    this.port.onmessage = (event) => {
      if (event.data?.type === 'mute') this.muted = event.data.value !== false;
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    // Push-to-talk: keep the graph running but emit nothing, so releasing the
    // key does not tear down and rebuild the audio pipeline.
    if (this.muted) return true;

    const merged = new Float32Array(this.pending.length + channel.length);
    merged.set(this.pending);
    merged.set(channel, this.pending.length);

    let index = this.phase;
    while (index + 1 < merged.length) {
      const base = Math.floor(index);
      const frac = index - base;
      const sample = merged[base] + (merged[base + 1] - merged[base]) * frac;
      // Clamp before scaling: a sample above 1.0 would wrap to a loud click.
      const clamped = Math.max(-1, Math.min(1, sample));
      this.out[this.outLength++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

      if (this.outLength === this.frameSamples) {
        const frame = this.out.slice(0);
        this.port.postMessage(frame.buffer, [frame.buffer]);
        this.outLength = 0;
      }
      index += this.ratio;
    }

    const consumed = Math.floor(index);
    this.pending = merged.slice(consumed);
    this.phase = index - consumed;
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
