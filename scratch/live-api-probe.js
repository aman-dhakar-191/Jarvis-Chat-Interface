#!/usr/bin/env node
'use strict';

/**
 * Disposable verification script. NOT part of the gateway.
 *
 * Answers one question: does native-audio Live API return audio on a
 * Gemini API key with no billing enabled?
 *
 * The AI Studio "Rate Limit" page cannot answer this - it only reports models
 * you have already used. So we make a real streaming session and look at what
 * comes back.
 *
 *   GEMINI_API_KEY=... node scratch/live-api-probe.js
 *
 * Uses a text turn rather than microphone audio: we are testing whether AUDIO
 * *output* is permitted, and text-in keeps the probe free of PCM plumbing.
 * Delete this file once the answer is recorded in docs/voice-design.md.
 */

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('Set GEMINI_API_KEY first.');
  process.exit(2);
}

// Model names moved during 2026 and the docs are not reachable from the
// environment this was written in, so try a spread and report each verdict.
const CANDIDATES = [
  'models/gemini-3.1-flash-live-preview',
  'models/gemini-2.5-flash-native-audio-preview-09-2025',
  'models/gemini-2.5-flash-preview-native-audio-dialog',
  'models/gemini-2.0-flash-live-001',
];

const ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent' +
  `?key=${API_KEY}`;

const TIMEOUT_MS = 20000;

// Node 22+ exposes WebSocket globally; fall back to the gateway's `ws`.
let WS = globalThis.WebSocket;
if (!WS) {
  try {
    WS = require('../gateway/node_modules/ws');
  } catch {
    console.error('No global WebSocket (need Node 22+) and `ws` not found.');
    console.error('Run `npm install` in gateway/ first, or use a newer Node.');
    process.exit(2);
  }
}

function probe(model) {
  return new Promise((resolve) => {
    const ws = new WS(ENDPOINT);
    let setupComplete = false;
    let audioBytes = 0;
    let textOut = '';
    let settled = false;

    const finish = (verdict, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already gone */ }
      resolve({ model, verdict, detail, audioBytes, textOut, setupComplete });
    };

    const timer = setTimeout(() => finish('TIMEOUT', `no verdict in ${TIMEOUT_MS}ms`), TIMEOUT_MS);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model,
          generationConfig: { responseModalities: ['AUDIO'] },
        },
      }));
    };

    ws.onmessage = async (ev) => {
      let raw = ev.data;
      if (raw instanceof Blob) raw = await raw.text();
      else if (raw instanceof ArrayBuffer) raw = Buffer.from(raw).toString('utf8');
      else if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');

      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.setupComplete) {
        setupComplete = true;
        // A short prompt; we only care that audio comes back at all.
        ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: 'Say the word hello.' }] }],
            turnComplete: true,
          },
        }));
        return;
      }

      const parts = msg.serverContent?.modelTurn?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data) audioBytes += Buffer.from(part.inlineData.data, 'base64').length;
        if (part.text) textOut += part.text;
      }

      if (msg.serverContent?.turnComplete) {
        finish(audioBytes > 0 ? 'AUDIO_OK' : 'NO_AUDIO', `${audioBytes} bytes`);
      }
    };

    // The interesting failures arrive as close codes, not messages.
    ws.onclose = (ev) => {
      const reason = (ev.reason || '').slice(0, 300) || '(no reason given)';
      if (setupComplete && audioBytes > 0) return finish('AUDIO_OK', `${audioBytes} bytes`);
      finish(`CLOSED_${ev.code}`, reason);
    };

    ws.onerror = () => { /* onclose carries the useful detail */ };
  });
}

(async () => {
  console.log('Probing Gemini Live API for native-audio output on this key.\n');
  const results = [];
  for (const model of CANDIDATES) {
    process.stdout.write(`  ${model} ... `);
    const r = await probe(model);
    console.log(`${r.verdict}  ${r.detail}`);
    results.push(r);
  }

  const win = results.find((r) => r.verdict === 'AUDIO_OK');
  console.log('\n--- verdict ---');
  if (win) {
    console.log(`Free-tier native audio WORKS on ${win.model} (${win.audioBytes} bytes).`);
    console.log('Proceed with the Gemini-first plan in docs/voice-design.md.');
    process.exit(0);
  }

  const quota = results.find((r) => /quota|billing|permission|403|429/i.test(r.detail));
  if (quota) {
    console.log('Native audio appears to be BLOCKED without billing:');
    console.log(`  ${quota.model}: ${quota.detail}`);
    console.log('Fall back to Gemini Live paid (~$5-9/mo). Architecture is unchanged.');
  } else {
    console.log('No candidate returned audio. Most likely the model names are stale.');
    console.log('Check current names, add them to CANDIDATES, and re-run.');
    for (const r of results) console.log(`  ${r.model}: ${r.verdict} ${r.detail}`);
  }
  process.exit(1);
})();
