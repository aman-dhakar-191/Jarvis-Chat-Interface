'use strict';

/** Browser half of src/voice/frames.js. Keep the two in step. */
const VOICE_FRAME = { MIC_AUDIO: 0x01, ASSISTANT_AUDIO: 0x02 };
const VOICE_HEADER_BYTES = 5;

function encodeVoiceFrame(type, sequence, pcmBuffer) {
  const out = new Uint8Array(VOICE_HEADER_BYTES + pcmBuffer.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint32(1, sequence >>> 0, false);
  out.set(new Uint8Array(pcmBuffer), VOICE_HEADER_BYTES);
  return out.buffer;
}

function decodeVoiceFrame(arrayBuffer) {
  if (arrayBuffer.byteLength < VOICE_HEADER_BYTES) return null;
  const view = new DataView(arrayBuffer);
  return {
    type: view.getUint8(0),
    sequence: view.getUint32(1, false),
    pcm: arrayBuffer.slice(VOICE_HEADER_BYTES),
  };
}
