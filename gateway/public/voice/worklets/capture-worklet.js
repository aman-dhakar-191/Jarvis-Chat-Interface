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
    const { targetSampleRate, frameSamples, gateThreshold, gateHoldMs } = options.processorOptions;
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

    // Noise gate.
    //
    // Browser noise suppression is tuned for steady noise - fans, hum - and
    // deliberately preserves speech, so it treats other people talking as
    // signal. What separates you from them is distance: a mouth 20 cm away is
    // roughly 20 dB louder than someone across the room, so an amplitude
    // threshold can cut them while leaving you untouched.
    //
    // 0 disables the gate entirely.
    this.gate = gateThreshold || 0;
    // Once open, stay open briefly. Speech dips below any threshold between
    // syllables, and gating on those dips chops words into fragments - which
    // ruins transcription far more thoroughly than the noise did.
    this.holdFrames = Math.max(1, Math.round(((gateHoldMs || 400) / 1000) * (targetSampleRate / frameSamples)));
    this.holdLeft = 0;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (data?.type === 'mute') this.muted = data.value !== false;
      if (data?.type === 'gate') this.gate = Number(data.value) || 0;
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
        this.emit();
        this.outLength = 0;
      }
      index += this.ratio;
    }

    const consumed = Math.floor(index);
    this.pending = merged.slice(consumed);
    this.phase = index - consumed;
    return true;
  }

  emit() {
    const frame = this.out.slice(0);

    if (this.gate > 0) {
      // RMS, not peak: a single click should not open the gate.
      let sum = 0;
      for (let i = 0; i < frame.length; i += 2) {
        const sample = frame[i] / 32768;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / (frame.length / 2));

      if (rms >= this.gate) this.holdLeft = this.holdFrames;
      else if (this.holdLeft > 0) this.holdLeft -= 1;

      if (this.holdLeft === 0) {
        // Report the level anyway, so the UI meter still moves while gated -
        // otherwise a threshold set too high looks like a broken microphone.
        this.port.postMessage({ type: 'gated', rms });
        return;
      }
    }

    this.port.postMessage(frame.buffer, [frame.buffer]);
  }
}

registerProcessor('capture-processor', CaptureProcessor);
