'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { startGateway, TestClient } = require('./helpers');
const frames = require('../src/voice/frames');

const TOKEN = 'test-token-abc';
// Every test here runs the echo engine: it exercises the whole voice path -
// session lifecycle, framing, flood control, teardown - with no API key and no
// network. The Gemini engine is covered separately by its own unit tests.
const VOICE_ON = { AUTH_TOKENS: `${TOKEN}:aman`, VOICE_ENABLED: 'true', VOICE_PROVIDER: 'echo' };

/** A client that keeps binary frames as well as JSON ones. */
class VoiceClient extends TestClient {
  constructor(url, options) {
    super(url, options);
    this.ws.binaryType = 'nodebuffer';
    this.audio = [];
    this.audioWaiters = [];
    // The parent registered a JSON-only listener; take binary before it throws.
    this.ws.removeAllListeners('message');
    this.ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        const decoded = frames.decode(raw);
        this.audio.push(decoded);
        this.audioWaiters = this.audioWaiters.filter((w) => {
          if (this.audio.length < w.count) return true;
          w.resolve(this.audio);
          return false;
        });
        return;
      }
      const frame = JSON.parse(raw);
      this.frames.push(frame);
      this.waiters = this.waiters.filter((waiter) => {
        if (!waiter.predicate(frame)) return true;
        waiter.resolve(frame);
        return false;
      });
    });
  }

  static async connect(url, options) {
    const client = new VoiceClient(url, options);
    await new Promise((resolve, reject) => {
      client.ws.once('open', resolve);
      client.ws.once('error', reject);
    });
    return client;
  }

  sendAudio(sequence, pcm) {
    this.ws.send(frames.encode(frames.FRAME.MIC_AUDIO, sequence, pcm), { binary: true });
  }

  waitForAudio(count, timeoutMs = 5000) {
    if (this.audio.length >= count) return Promise.resolve(this.audio);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${count} audio frames, saw ${this.audio.length}`)), timeoutMs);
      this.audioWaiters.push({ count, resolve: (a) => { clearTimeout(timer); resolve(a); } });
    });
  }
}

function tone(samples = 320) {
  const pcm = Buffer.allocUnsafe(samples * 2);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), i * 2);
  return pcm;
}

test('frames round-trip through encode/decode', () => {
  const pcm = tone(16);
  const decoded = frames.decode(frames.encode(frames.FRAME.MIC_AUDIO, 42, pcm));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.type, frames.FRAME.MIC_AUDIO);
  assert.equal(decoded.sequence, 42);
  assert.deepEqual(decoded.pcm, pcm);
});

test('frames reject a truncated header and an odd PCM length', () => {
  assert.equal(frames.decode(Buffer.from([1, 2])).ok, false);
  assert.equal(frames.decode(Buffer.concat([frames.encode(1, 1, Buffer.alloc(0)), Buffer.from([7])])).ok, false);
  assert.match(frames.decode(Buffer.from([0x09, 0, 0, 0, 1])).reason, /unknown frame type/);
});

test('voice session starts and echoes microphone audio back', async (t) => {
  const gateway = await startGateway(VOICE_ON);
  t.after(() => gateway.stop());

  const client = await VoiceClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => client.close());
  await client.waitForEvent('connection.ready');

  client.send({ id: 'evt_v1', event: 'voice.session.start' });
  const started = await client.waitForEvent('voice.session.started');
  assert.match(started.data.voiceSessionId, /^voice_/);
  assert.equal(started.data.inputSampleRate, 16000);
  // Echo returns what it was given, so both rates match. Gemini's do not.
  assert.equal(started.data.outputSampleRate, 16000);
  assert.equal(started.data.frameMs, 20);
  assert.equal(started.data.engine, 'echo');
  assert.equal(gateway.voiceSessions.size, 1);

  const pcm = tone();
  client.sendAudio(1, pcm);
  client.sendAudio(2, pcm);
  const audio = await client.waitForAudio(2);

  assert.equal(audio[0].type, frames.FRAME.ASSISTANT_AUDIO);
  assert.deepEqual(audio[0].pcm, pcm, 'echoed PCM must be byte-identical');
  // Outbound sequence is the gateway's own counter, not the client's.
  assert.deepEqual(audio.map((f) => f.sequence), [1, 2]);
});

test('voice is refused unless enabled, and the text path still works', async (t) => {
  const gateway = await startGateway({ AUTH_TOKENS: `${TOKEN}:aman` });
  t.after(() => gateway.stop());

  const client = await VoiceClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => client.close());
  await client.waitForEvent('connection.ready');

  client.send({ id: 'evt_v1', event: 'voice.session.start' });
  const error = await client.waitForEvent('voice.error');
  assert.equal(error.data.code, 'VOICE_UNAVAILABLE');
  assert.equal(gateway.voiceSessions.size, 0);

  // The text protocol is untouched by a voice refusal.
  client.send({ id: 'evt_ping', event: 'connection.ping', data: { hi: true } });
  const pong = await client.waitForEvent('connection.pong');
  assert.deepEqual(pong.data.echo, { hi: true });
});

test('audio without a session is dropped rather than erroring', async (t) => {
  const gateway = await startGateway(VOICE_ON);
  t.after(() => gateway.stop());

  const client = await VoiceClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => client.close());
  await client.waitForEvent('connection.ready');

  client.sendAudio(1, tone());
  client.send({ id: 'evt_ping', event: 'connection.ping', data: {} });
  await client.waitForEvent('connection.pong');
  assert.equal(client.audio.length, 0);
  assert.equal(client.frames.some((f) => f.event === 'voice.error'), false);
});

test('a flood of audio ends the session instead of saturating the socket', async (t) => {
  const gateway = await startGateway({ ...VOICE_ON, VOICE_MAX_AUDIO_BYTES_PER_SECOND: '2000' });
  t.after(() => gateway.stop());

  const client = await VoiceClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => client.close());
  await client.waitForEvent('connection.ready');

  client.send({ id: 'evt_v1', event: 'voice.session.start' });
  await client.waitForEvent('voice.session.started');

  for (let i = 1; i <= 10; i += 1) client.sendAudio(i, tone(500));
  const ended = await client.waitForEvent('voice.session.ended');
  assert.equal(ended.data.reason, 'flood');
  assert.equal(gateway.voiceSessions.size, 0);
});

test('ending a session is idempotent and disconnect cleans up', async (t) => {
  const gateway = await startGateway(VOICE_ON);
  t.after(() => gateway.stop());

  const client = await VoiceClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  await client.waitForEvent('connection.ready');
  client.send({ id: 'evt_v1', event: 'voice.session.start' });
  const started = await client.waitForEvent('voice.session.started');

  client.send({ id: 'evt_v2', event: 'voice.session.end', data: { voiceSessionId: started.data.voiceSessionId } });
  const ended = await client.waitForEvent('voice.session.ended');
  assert.equal(ended.data.reason, 'client');

  // Second end: acked, no second ended event, no error.
  client.send({ id: 'evt_v3', event: 'voice.session.end', data: { voiceSessionId: started.data.voiceSessionId } });
  await client.waitFor((f) => f.type === 'ack' && f.eventId === 'evt_v3');
  assert.equal(client.frames.filter((f) => f.event === 'voice.session.ended').length, 1);

  // Match on a *new* id: waitForEvent scans buffered frames first, so plain
  // 'voice.session.started' would resolve against the session just ended.
  client.send({ id: 'evt_v4', event: 'voice.session.start' });
  await client.waitFor((f) => f.event === 'voice.session.started'
    && f.data.voiceSessionId !== started.data.voiceSessionId);
  assert.equal(gateway.voiceSessions.size, 1);
  await client.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(gateway.voiceSessions.size, 0, 'disconnect must drop the voice session');
});

test('starting twice on one connection replaces rather than accumulates', async (t) => {
  const gateway = await startGateway(VOICE_ON);
  t.after(() => gateway.stop());

  const client = await VoiceClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => client.close());
  await client.waitForEvent('connection.ready');

  client.send({ id: 'evt_a', event: 'voice.session.start' });
  const first = await client.waitForEvent('voice.session.started');
  client.send({ id: 'evt_b', event: 'voice.session.start' });
  await client.waitFor((f) => f.event === 'voice.session.started' && f.data.voiceSessionId !== first.data.voiceSessionId);
  assert.equal(gateway.voiceSessions.size, 1);
});

test('health reports voice state', async (t) => {
  const gateway = await startGateway(VOICE_ON);
  t.after(() => gateway.stop());
  const health = await (await fetch(`${gateway.httpUrl}/health`)).json();
  assert.equal(health.voiceEnabled, true);
  assert.equal(health.voiceSessions, 0);
});
