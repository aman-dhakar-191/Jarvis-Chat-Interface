'use strict';

const http = require('node:http');
const { WebSocket } = require('ws');
const { buildConfig } = require('../src/config');
const { createServer } = require('../src/server');

/** A stand-in for the real n8n webhook. `handler(body, req, res)` decides the reply. */
async function startFakeN8n(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* leave as {} */
      }
      received.push({ body, headers: req.headers });
      handler(body, req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/webhook/jarvis-chat`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startGateway(env) {
  const config = buildConfig({ HEARTBEAT_INTERVAL_MS: '60000', ...env });
  const instance = createServer(config);
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const port = instance.server.address().port;
  return {
    ...instance,
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    stop: () => instance.close(),
  };
}

/** A WebSocket client that buffers every inbound frame and can await one by predicate. */
class TestClient {
  constructor(url, options) {
    this.ws = new WebSocket(url, options);
    this.frames = [];
    this.waiters = [];
    this.ws.on('message', (raw) => {
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
    const client = new TestClient(url, options);
    await new Promise((resolve, reject) => {
      client.ws.once('open', resolve);
      client.ws.once('error', reject);
    });
    return client;
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame));
  }

  /** Resolve with the first frame matching `predicate`, past or future. */
  waitFor(predicate, timeoutMs = 5000) {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for frame; saw: ${this.frames.map((f) => f.event || f.type).join(', ')}`)),
        timeoutMs,
      );
      this.waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  waitForEvent(name, timeoutMs) {
    return this.waitFor((frame) => frame.event === name, timeoutMs);
  }

  close() {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', resolve);
      this.ws.close();
    });
  }
}

module.exports = { startFakeN8n, startGateway, TestClient };

/** Poll an arbitrary condition (not tied to inbound frames). */
async function waitUntil(condition, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('timed out waiting for condition');
}

module.exports.waitUntil = waitUntil;
