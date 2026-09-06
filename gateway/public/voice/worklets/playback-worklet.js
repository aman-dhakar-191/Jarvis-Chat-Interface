/**
 * Assistant audio playback worklet.
 *
 * Incoming PCM16 is at the session rate; the context runs at the device rate,
 * so it is resampled on arrival and queued as Float32 ready to play.
 *
 * The `flush` message exists for barge-in (Phase 3): when the user interrupts,
 * audio already queued here must be dropped, not played out. Cancelling
 * generation upstream is not enough - whatever is buffered would still be
 * spoken, which is the usual reason an assistant "keeps talking" after being
 * interrupted.
 */
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = options.processorOptions.sourceSampleRate / sampleRate;
    this.queue = [];
    this.queued = 0;
    this.reported = 0;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (data?.type === 'flush') {
        this.queue.length = 0;
        this.queued = 0;
        return;
      }
      if (!(data instanceof ArrayBuffer)) return;
      this.push(new Int16Array(data));
    };
  }

  push(pcm) {
    const outLength = Math.floor(pcm.length / this.ratio);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const position = i * this.ratio;
      const base = Math.floor(position);
      const frac = position - base;
      const a = pcm[base] / 32768;
      const b = pcm[Math.min(base + 1, pcm.length - 1)] / 32768;
      out[i] = a + (b - a) * frac;
    }
    this.queue.push(out);
    this.queued += out.length;
  }

  process(_inputs, outputs) {
    const channel = outputs[0][0];
    let written = 0;

    while (written < channel.length && this.queue.length > 0) {
      const head = this.queue[0];
      const take = Math.min(head.length, channel.length - written);
      channel.set(head.subarray(0, take), written);
      written += take;
      this.queued -= take;
      if (take === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(take);
    }
    // Underrun is silence, not a stall - the stream is live, so waiting for
    // more audio would only add latency to whatever arrives next.
    if (written < channel.length) channel.fill(0, written);

    // Let the UI show buffer depth without polling across the thread boundary.
    if (Math.abs(this.queued - this.reported) > 800) {
      this.reported = this.queued;
      this.port.postMessage({ type: 'queued', samples: this.queued });
    }
    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
