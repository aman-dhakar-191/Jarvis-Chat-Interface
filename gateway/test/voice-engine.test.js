'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { buildConfig } = require('../src/config');
const { GeminiLiveEngine } = require('../src/voice/engines/gemini');
const { waitUntil } = require('./helpers');

/**
 * A stand-in for the Gemini Live endpoint. It speaks the same message shapes
 * so the engine's reconnect and resumption behaviour can be tested without a
 * network or an API key - the behaviour that matters most here is what happens
 * when the upstream drops, which is impractical to trigger against the real
 * service.
 */
async function startFakeLive({ onSetup } = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const state = { setups: [], messages: [], sockets: [], keys: [] };

  wss.on('connection', (ws, req) => {
    state.sockets.push(ws);
    state.keys.push(new URL(req.url, 'http://x').searchParams.get('key'));
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.setup) {
        state.setups.push(message.setup);
        onSetup?.(ws, message.setup);
        return ws.send(JSON.stringify({ setupComplete: {} }));
      }
      state.messages.push(message);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    ...state,
    port,
    last: () => state.sockets[state.sockets.length - 1],
    // Terminate live sockets first: server.close() waits for open connections,
    // and the engine's socket may still be attached when a test tears down.
    close: () => new Promise((resolve) => {
      for (const socket of state.sockets) {
        try { socket.terminate(); } catch { /* already gone */ }
      }
      wss.close();
      server.close(resolve);
    }),
  };
}

/** Point the engine at the fake by overriding the URL it builds. */
function engineFor(fake, overrides = {}, callbacks = {}) {
  const config = buildConfig({
    VOICE_ENABLED: 'true',
    VOICE_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'test-key',
    ...overrides,
  });
  const engine = new GeminiLiveEngine(config, callbacks);
  engine.url = () => `ws://127.0.0.1:${fake.port}/?key=${config.voice.apiKey}`;
  return engine;
}

test('engine reports the split sample rates, not one shared rate', () => {
  const config = buildConfig({ VOICE_ENABLED: 'true', GEMINI_API_KEY: 'k' });
  const engine = new GeminiLiveEngine(config, {});
  assert.equal(engine.inputSampleRate, 16000);
  assert.equal(engine.outputSampleRate, 24000);
});

test('setup disables automatic VAD and asks for a resumption handle', async (t) => {
  const fake = await startFakeLive();
  t.after(() => fake.close());

  const engine = engineFor(fake, { VOICE_INSTRUCTIONS: 'Be brief.' });
  await engine.open();
  t.after(() => engine.close());

  const setup = fake.setups[0];
  // Push-to-talk owns turn boundaries, so the model must not also guess.
  assert.equal(setup.realtimeInputConfig.automaticActivityDetection.disabled, true);
  // Without this from the first message, the first upstream drop loses the
  // conversation - there would be no handle to resume with.
  assert.deepEqual(setup.sessionResumption, {});
  assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(setup.systemInstruction.parts[0].text, 'Be brief.');
  assert.equal(fake.keys[0], 'test-key');
});

test('audio is sent as base64 PCM at the input rate, and turns are bounded', async (t) => {
  const fake = await startFakeLive();
  t.after(() => fake.close());
  const engine = engineFor(fake);
  await engine.open();
  t.after(() => engine.close());

  engine.activityStart();
  engine.sendAudio(Buffer.from([1, 2, 3, 4]));
  engine.activityEnd();
  await waitUntil(() => fake.messages.length >= 3);

  assert.ok(fake.messages[0].realtimeInput.activityStart);
  const audio = fake.messages[1].realtimeInput.audio;
  assert.equal(audio.mimeType, 'audio/pcm;rate=16000');
  assert.deepEqual(Buffer.from(audio.data, 'base64'), Buffer.from([1, 2, 3, 4]));
  assert.ok(fake.messages[2].realtimeInput.activityEnd);
});

test('assistant audio and transcripts reach the callbacks', async (t) => {
  const fake = await startFakeLive();
  t.after(() => fake.close());

  const heard = [];
  const transcripts = [];
  let completed = 0;
  const engine = engineFor(fake, {}, {
    onAudio: (pcm) => heard.push(pcm),
    onTranscript: (t2) => transcripts.push(t2),
    onTurnComplete: () => { completed += 1; },
  });
  await engine.open();
  t.after(() => engine.close());

  fake.last().send(JSON.stringify({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: Buffer.from('hi').toString('base64') } }] },
      outputTranscription: { text: 'hello' },
    },
  }));
  fake.last().send(JSON.stringify({ serverContent: { turnComplete: true } }));

  await waitUntil(() => heard.length > 0 && completed > 0);
  assert.equal(heard[0].toString(), 'hi');
  assert.deepEqual(transcripts[0], { role: 'assistant', text: 'hello', final: false });
});

test('an upstream drop reconnects and resumes with the stored handle', async (t) => {
  const fake = await startFakeLive();
  t.after(() => fake.close());

  let reconnected = null;
  const engine = engineFor(fake, {}, { onReconnected: (info) => { reconnected = info; } });
  await engine.open();
  t.after(() => engine.close());

  // The server hands out a handle periodically; keeping the latest is what
  // makes the reconnect invisible.
  fake.last().send(JSON.stringify({ sessionResumptionUpdate: { newHandle: 'handle-123', resumable: true } }));
  await waitUntil(() => engine.resumeHandle === 'handle-123');

  // Upstream caps a connection at ~10 minutes and then drops it.
  fake.last().close();
  await waitUntil(() => fake.setups.length === 2);

  assert.equal(fake.setups[1].sessionResumption.handle, 'handle-123');
  await waitUntil(() => reconnected !== null);
  assert.equal(reconnected.resumed, true);
});

test('goAway reconnects early, but not mid-utterance', async (t) => {
  const fake = await startFakeLive();
  t.after(() => fake.close());
  const engine = engineFor(fake);
  await engine.open();
  t.after(() => engine.close());

  // While the assistant is speaking, a reconnect would cut it off; wait.
  engine.speaking = true;
  fake.last().send(JSON.stringify({ goAway: { timeLeft: '5s' } }));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fake.setups.length, 1, 'must not reconnect while speaking');

  engine.speaking = false;
  fake.last().send(JSON.stringify({ goAway: { timeLeft: '5s' } }));
  await waitUntil(() => fake.setups.length === 2);
});

test('reconnects are bounded so a revoked key surfaces instead of looping', async (t) => {
  const fake = await startFakeLive();
  const engine = engineFor(fake, { VOICE_MAX_RECONNECTS: '1' });
  const errors = [];
  engine.callbacks.onError = (e) => errors.push(e);
  await engine.open();
  await fake.close();

  engine.reconnects = 1; // one attempt already spent
  await engine.reconnect();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].fatal, true);
  await engine.close();
});

test('audio sent while reconnecting is buffered, then flushed', async (t) => {
  const fake = await startFakeLive();
  t.after(() => fake.close());
  const engine = engineFor(fake);
  await engine.open();
  t.after(() => engine.close());

  engine.ready = false; // mid-reconnect
  engine.sendAudio(Buffer.from([9, 9]));
  assert.equal(engine.pending.length, 1);

  engine.ready = true;
  engine.flushPending();
  await waitUntil(() => fake.messages.some((m) => m.realtimeInput?.audio?.data === Buffer.from([9, 9]).toString('base64')));
  assert.equal(engine.pending.length, 0);
});

test('the backlog is capped so a long outage cannot grow without bound', async (t) => {
  const fake = await startFakeLive();
  t.after(() => fake.close());
  const engine = engineFor(fake);
  await engine.open();
  t.after(() => engine.close());

  engine.ready = false;
  for (let i = 0; i < 200; i += 1) engine.sendAudio(Buffer.from([i % 256, 0]));
  assert.ok(engine.pending.length <= 50, `backlog grew to ${engine.pending.length}`);
});

test('gemini without a key is refused at config level with a usable warning', () => {
  const config = buildConfig({ VOICE_ENABLED: 'true', VOICE_PROVIDER: 'gemini' });
  assert.equal(config.voice.apiKey, '');
  assert.ok(config.warnings.some((w) => w.includes('GEMINI_API_KEY')));
});

test('ptt disables the engine VAD; open mode enables it with a safe threshold', async (t) => {
  const fake = await startFakeLive();
  t.after(() => fake.close());

  const ptt = engineFor(fake, {}, {});
  await ptt.open();
  assert.equal(fake.setups[0].realtimeInputConfig.automaticActivityDetection.disabled, true);
  await ptt.close();

  const open = engineFor(fake, {}, {});
  open.mode = 'open';
  await open.open();
  const detection = fake.setups[1].realtimeInputConfig.automaticActivityDetection;
  assert.equal(detection.disabled, false);
  // Below ~500ms a natural mid-sentence pause reads as end-of-turn.
  assert.ok(detection.silenceDurationMs >= 500, `silence threshold too low: ${detection.silenceDurationMs}`);
  await open.close();
});

test('manual activity markers are suppressed in open mode', async (t) => {
  const fake = await startFakeLive();
  t.after(() => fake.close());

  const engine = engineFor(fake);
  engine.mode = 'open';
  await engine.open();
  t.after(() => engine.close());

  // Sending these alongside automatic detection is a protocol error, so the
  // engine must swallow them rather than forwarding.
  engine.activityStart();
  engine.activityEnd();
  engine.sendAudio(Buffer.from([1, 2]));
  await waitUntil(() => fake.messages.length >= 1);

  assert.equal(fake.messages.filter((m) => m.realtimeInput?.activityStart).length, 0);
  assert.equal(fake.messages.filter((m) => m.realtimeInput?.activityEnd).length, 0);
  assert.ok(fake.messages[0].realtimeInput.audio);
});

const memory = require('../src/voice/memory');

test('a snapshot is folded in as reference material, not as instructions', () => {
  const config = buildConfig({ VOICE_ENABLED: 'true', VOICE_INSTRUCTIONS: 'Be brief.' });
  const out = memory.buildInstructions(config, '- Aman city: Hyderabad');

  assert.match(out, /Be brief\./);
  assert.match(out, /Aman city: Hyderabad/);
  // The snapshot contains transcribed user speech, so it must be labelled as
  // things the model knows - never pasted in as if it were part of the prompt.
  assert.match(out, /not as\s*\n?instructions/);
  assert.match(out, /the user is right/);
});

test('no snapshot leaves the configured instructions untouched', () => {
  const config = buildConfig({ VOICE_ENABLED: 'true', VOICE_INSTRUCTIONS: 'Be brief.' });
  assert.equal(memory.buildInstructions(config, null), 'Be brief.');
  assert.equal(memory.buildInstructions(config, ''), 'Be brief.');
});

test('an unreachable or slow memory service never blocks a session', async () => {
  const unset = buildConfig({ VOICE_ENABLED: 'true' });
  assert.equal(await memory.fetchSnapshot(unset), null);

  // A dead port: must resolve null rather than throwing or hanging.
  const dead = buildConfig({
    VOICE_ENABLED: 'true',
    VOICE_MEMORY_URL: 'http://127.0.0.1:1/voice-memory-snapshot',
    VOICE_MEMORY_TIMEOUT_MS: '300',
  });
  assert.equal(await memory.fetchSnapshot(dead), null);
});

test('instructions are refreshed on every connect, including reconnects', async (t) => {
  const fake = await startFakeLive();
  t.after(() => fake.close());

  let calls = 0;
  const engine = engineFor(fake, {}, {});
  engine.refreshInstructions = async () => {
    calls += 1;
    return `snapshot v${calls}`;
  };
  await engine.open();
  t.after(() => engine.close());
  assert.equal(fake.setups[0].systemInstruction.parts[0].text, 'snapshot v1');

  // The upstream link is replaced roughly every 10 minutes; that is a free
  // opportunity to pick up anything learned since the session opened.
  fake.last().close();
  await waitUntil(() => fake.setups.length === 2);
  assert.equal(fake.setups[1].systemInstruction.parts[0].text, 'snapshot v2');
});

test('the session declares a language and a spoken-style prompt by default', async (t) => {
  const fake = await startFakeLive();
  t.after(() => fake.close());

  const engine = engineFor(fake, {});
  await engine.open();
  t.after(() => engine.close());

  const setup = fake.setups[0];
  // Without this the model infers a language from the audio, and an accented
  // greeting is enough to tip it into the wrong one.
  assert.equal(setup.generationConfig.speechConfig.languageCode, 'en-US');

  const prompt = setup.systemInstruction.parts[0].text;
  assert.match(prompt, /speak English/i);
  // A realtime model with no prompt writes like a chat model - lists and
  // headings - which is unbearable read aloud.
  assert.match(prompt, /heard, not read/i);
});

test('an explicit language and prompt override the defaults', async (t) => {
  const fake = await startFakeLive();
  t.after(() => fake.close());

  const engine = engineFor(fake, { VOICE_LANGUAGE: 'hi-IN', VOICE_INSTRUCTIONS: 'Custom.' });
  await engine.open();
  t.after(() => engine.close());

  assert.equal(fake.setups[0].generationConfig.speechConfig.languageCode, 'hi-IN');
  assert.equal(fake.setups[0].systemInstruction.parts[0].text, 'Custom.');
});
