'use strict';

/**
 * Binary voice frames.
 *
 * Audio is sent as raw bytes rather than base64 inside JSON: base64 costs ~33%
 * bandwidth and a JSON parse every 20 ms, which is the wrong trade on a stream
 * that runs continuously for minutes.
 *
 *   byte  0      frame type
 *   bytes 1..4   uint32 BE sequence number, per direction, per voice session
 *   bytes 5..    PCM16 little-endian, mono, at the session's sampleRate
 *
 * The sequence number is not used for reordering - a WebSocket is ordered - but
 * it makes drops and duplicates visible in logs and tests, which is most of
 * what goes wrong in an audio pipeline.
 */

const HEADER_BYTES = 5;

const FRAME = {
  MIC_AUDIO: 0x01, // client -> gateway
  ASSISTANT_AUDIO: 0x02, // gateway -> client
};

function encode(type, sequence, pcm) {
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(sequence >>> 0, 1);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

/** Returns { ok: true, type, sequence, pcm } or { ok: false, reason }. */
function decode(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < HEADER_BYTES) return { ok: false, reason: 'frame shorter than header' };
  const type = buffer.readUInt8(0);
  if (type !== FRAME.MIC_AUDIO && type !== FRAME.ASSISTANT_AUDIO) {
    return { ok: false, reason: `unknown frame type 0x${type.toString(16)}` };
  }
  const pcm = buffer.subarray(HEADER_BYTES);
  // PCM16 means two bytes per sample; an odd length is a truncated frame.
  if (pcm.length % 2 !== 0) return { ok: false, reason: 'PCM payload has an odd byte length' };
  return { ok: true, type, sequence: buffer.readUInt32BE(1), pcm };
}

module.exports = { FRAME, HEADER_BYTES, encode, decode };
