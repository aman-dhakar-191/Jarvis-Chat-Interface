'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startFakeN8n, startGateway, TestClient, waitUntil } = require('./helpers');

const TOKEN = 'test-token-abc';
const AUTH = { AUTH_TOKENS: `${TOKEN}:aman`, PUSH_SECRET: 'push-secret' };

function jsonReply(body) {
  return (_body, _req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

test('full loop: user.message -> n8n -> assistant.message, ids preserved', async (t) => {
  const n8n = await startFakeN8n(jsonReply([{ json: { output: 'Hello. How can I help?' } }]));
  const gateway = await startGateway({ ...AUTH, N8N_WEBHOOK_URL: n8n.url, N8N_WEBHOOK_SECRET: 'shh' });
  t.after(async () => {
    await gateway.stop();
    await n8n.close();
  });

  const client = await TestClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => client.close());

  const ready = await client.waitForEvent('connection.ready');
  assert.match(ready.data.connectionId, /^conn_/);
  assert.equal(ready.data.userId, 'aman');

  client.send({ id: 'evt_join', event: 'session.join', sessionId: 'session_123' });
  const joined = await client.waitForEvent('session.joined');
  assert.equal(joined.sessionId, 'session_123');

  client.send({
    id: 'evt_001',
    type: 'event',
    event: 'user.message',
    sessionId: 'session_123',
    data: { messageId: 'msg_001', content: 'Hello Jarvis' },
  });

  // 1. the gateway acknowledges the client event
  const ack = await client.waitFor((f) => f.type === 'ack' && f.eventId === 'evt_001');
  assert.equal(ack.status, 'accepted');
  assert.equal(ack.messageId, 'msg_001');

  // 2. it announces the execution before calling n8n
  const started = await client.waitForEvent('execution.started');
  assert.equal(started.data.messageId, 'msg_001');

  // 3. n8n received the normalized, Telegram-equivalent payload
  const reply = await client.waitForEvent('assistant.message');
  assert.equal(n8n.received.length, 1);
  const forwarded = n8n.received[0].body;
  assert.equal(forwarded.source, 'custom_chat');
  assert.equal(forwarded.userId, 'aman');
  assert.equal(forwarded.sessionId, 'session_123');
  assert.equal(forwarded.messageId, 'msg_001');
  assert.equal(forwarded.message, 'Hello Jarvis');
  assert.equal(forwarded.content, 'Hello Jarvis');
  assert.equal(n8n.received[0].headers['x-jarvis-secret'], 'shh');

  // 4. the reply comes back over the socket with sessionId and messageId intact
  assert.equal(reply.sessionId, 'session_123');
  assert.equal(reply.data.replyTo, 'msg_001');
  assert.equal(reply.data.content, 'Hello. How can I help?');

  const completed = await client.waitForEvent('execution.completed');
  assert.equal(completed.data.messageId, 'msg_001');
});

test('the client never dictates its own identity', async (t) => {
  const n8n = await startFakeN8n(jsonReply({ reply: 'ok' }));
  const gateway = await startGateway({ ...AUTH, N8N_WEBHOOK_URL: n8n.url });
  t.after(async () => {
    await gateway.stop();
    await n8n.close();
  });

  const client = await TestClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => client.close());
  await client.waitForEvent('connection.ready');

  client.send({
    event: 'user.message',
    sessionId: 'session_x',
    data: { content: 'hi', userId: 'somebody-else' },
  });
  await client.waitForEvent('assistant.message');
  assert.equal(n8n.received[0].body.userId, 'aman');
});

test('a bad token is refused at the handshake', async () => {
  const gateway = await startGateway({ ...AUTH, N8N_WEBHOOK_URL: 'http://127.0.0.1:1/x' });
  await assert.rejects(
    () => TestClient.connect(`${gateway.wsUrl}/?token=wrong`),
    /401/,
  );
  await assert.rejects(() => TestClient.connect(`${gateway.wsUrl}/`), /401/);
  await gateway.stop();
});

test('n8n being unreachable surfaces as an error event, not a hang', async (t) => {
  // Port 1 refuses connections immediately.
  const gateway = await startGateway({ ...AUTH, N8N_WEBHOOK_URL: 'http://127.0.0.1:1/webhook' });
  t.after(() => gateway.stop());

  const client = await TestClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => client.close());
  await client.waitForEvent('connection.ready');

  client.send({ event: 'user.message', sessionId: 'session_1', data: { messageId: 'msg_x', content: 'hi' } });

  const error = await client.waitForEvent('error');
  assert.equal(error.data.code, 'N8N_UNAVAILABLE');
  assert.equal(error.data.messageId, 'msg_x');

  const failed = await client.waitForEvent('execution.failed');
  assert.equal(failed.data.messageId, 'msg_x');
});

test('an n8n 500 is reported as EXECUTION_FAILED', async (t) => {
  const n8n = await startFakeN8n((_body, _req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'workflow blew up' }));
  });
  const gateway = await startGateway({ ...AUTH, N8N_WEBHOOK_URL: n8n.url });
  t.after(async () => {
    await gateway.stop();
    await n8n.close();
  });

  const client = await TestClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => client.close());
  await client.waitForEvent('connection.ready');

  client.send({ event: 'user.message', sessionId: 's1', data: { content: 'hi' } });
  const error = await client.waitForEvent('error');
  assert.equal(error.data.code, 'EXECUTION_FAILED');
});

test('a workflow with no reply text says so instead of showing an empty bubble', async (t) => {
  const n8n = await startFakeN8n((_body, _req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: { ok: true } }));
  });
  const gateway = await startGateway({ ...AUTH, N8N_WEBHOOK_URL: n8n.url });
  t.after(async () => {
    await gateway.stop();
    await n8n.close();
  });

  const client = await TestClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => client.close());
  await client.waitForEvent('connection.ready');

  client.send({ event: 'user.message', sessionId: 's1', data: { content: 'hi' } });
  const error = await client.waitForEvent('error');
  assert.equal(error.data.code, 'EXECUTION_FAILED');
  assert.match(error.data.message, /Respond to Webhook/);
});

test('malformed frames are rejected without killing the connection', async (t) => {
  const gateway = await startGateway({ ...AUTH, N8N_WEBHOOK_URL: 'http://127.0.0.1:1/x' });
  t.after(() => gateway.stop());

  const client = await TestClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => client.close());
  await client.waitForEvent('connection.ready');

  client.ws.send('not json at all');
  const first = await client.waitForEvent('error');
  assert.equal(first.data.code, 'INVALID_MESSAGE');

  client.send({ event: 'user.message', sessionId: 's1', data: { content: '   ' } });
  const second = await client.waitFor((f) => f.event === 'error' && /data\.content/.test(f.data.message));
  assert.equal(second.data.code, 'INVALID_MESSAGE');

  // still usable
  client.send({ event: 'connection.ping' });
  await client.waitForEvent('connection.pong');
});

test('async mode: n8n calls back through POST /api/push', async (t) => {
  let captured = null;
  const n8n = await startFakeN8n((body, _req, res) => {
    captured = body;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));
  });
  const gateway = await startGateway({
    ...AUTH,
    N8N_WEBHOOK_URL: n8n.url,
    N8N_RESPONSE_MODE: 'async',
  });
  t.after(async () => {
    await gateway.stop();
    await n8n.close();
  });

  const client = await TestClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => client.close());
  await client.waitForEvent('connection.ready');

  client.send({ event: 'user.message', sessionId: 'session_async', data: { messageId: 'msg_async', content: 'slow one' } });
  await client.waitForEvent('execution.started');
  await waitUntil(() => captured !== null);

  const pushed = await fetch(`${gateway.httpUrl}/api/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gateway-secret': 'push-secret' },
    body: JSON.stringify({ messageId: 'msg_async', content: 'Took a while, but here you go.' }),
  });
  assert.equal(pushed.status, 200);
  assert.deepEqual(await pushed.json(), { ok: true, delivered: 1 });

  const reply = await client.waitForEvent('assistant.message');
  assert.equal(reply.data.content, 'Took a while, but here you go.');
  assert.equal(reply.data.replyTo, 'msg_async');
  assert.equal(reply.sessionId, 'session_async');
  await client.waitForEvent('execution.completed');
});

test('push requires the shared secret and a routing target', async (t) => {
  const gateway = await startGateway({ ...AUTH, N8N_WEBHOOK_URL: 'http://127.0.0.1:1/x' });
  t.after(() => gateway.stop());

  const unauthorized = await fetch(`${gateway.httpUrl}/api/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gateway-secret': 'nope' },
    body: JSON.stringify({ sessionId: 's1', content: 'hi' }),
  });
  assert.equal(unauthorized.status, 401);

  const untargeted = await fetch(`${gateway.httpUrl}/api/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gateway-secret': 'push-secret' },
    body: JSON.stringify({ content: 'to nobody' }),
  });
  assert.equal(untargeted.status, 400);
});

test('unprompted notifications reach every connection in the session', async (t) => {
  const gateway = await startGateway({ ...AUTH, N8N_WEBHOOK_URL: 'http://127.0.0.1:1/x' });
  t.after(() => gateway.stop());

  const phone = await TestClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  const laptop = await TestClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(async () => {
    await phone.close();
    await laptop.close();
  });

  for (const client of [phone, laptop]) {
    await client.waitForEvent('connection.ready');
    client.send({ event: 'session.join', sessionId: 'shared_session' });
    await client.waitForEvent('session.joined');
  }

  const response = await fetch(`${gateway.httpUrl}/api/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gateway-secret': 'push-secret' },
    body: JSON.stringify({ sessionId: 'shared_session', event: 'notification', content: 'Your build finished.' }),
  });
  assert.deepEqual(await response.json(), { ok: true, delivered: 2 });

  for (const client of [phone, laptop]) {
    const note = await client.waitForEvent('notification');
    assert.equal(note.data.content, 'Your build finished.');
  }
});

test('too many concurrent messages are rate limited, not queued forever', async (t) => {
  // n8n that never answers, so requests stay in flight.
  const n8n = await startFakeN8n(() => {});
  const gateway = await startGateway({
    ...AUTH,
    N8N_WEBHOOK_URL: n8n.url,
    MAX_INFLIGHT_PER_CONNECTION: '2',
    N8N_TIMEOUT_MS: '2000',
  });
  t.after(async () => {
    await gateway.stop();
    await n8n.close();
  });

  const client = await TestClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => client.close());
  await client.waitForEvent('connection.ready');

  for (let i = 0; i < 3; i += 1) {
    client.send({ event: 'user.message', sessionId: 's1', data: { messageId: `msg_${i}`, content: `q${i}` } });
  }
  const error = await client.waitForEvent('error');
  assert.equal(error.data.code, 'RATE_LIMITED');
});

test('health reports what is actually configured', async (t) => {
  const gateway = await startGateway({ ...AUTH, N8N_WEBHOOK_URL: 'http://example.invalid/x' });
  t.after(() => gateway.stop());
  const health = await (await fetch(`${gateway.httpUrl}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.authEnabled, true);
  assert.equal(health.n8nConfigured, true);
  assert.equal(health.responseMode, 'sync');
});

test('the browser path authenticates via the bearer subprotocol', async (t) => {
  const n8n = await startFakeN8n((_body, _req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ reply: 'authenticated without a query string' }));
  });
  const gateway = await startGateway({ ...AUTH, N8N_WEBHOOK_URL: n8n.url });
  t.after(async () => {
    await gateway.stop();
    await n8n.close();
  });

  const client = await TestClient.connect(gateway.wsUrl, ['bearer', TOKEN]);
  t.after(() => client.close());

  await client.waitForEvent('connection.ready');
  client.send({ event: 'user.message', sessionId: 's1', data: { content: 'hi' } });
  const reply = await client.waitForEvent('assistant.message');
  assert.equal(reply.data.content, 'authenticated without a query string');

  await assert.rejects(() => TestClient.connect(gateway.wsUrl, ['bearer', 'wrong-token']), /401/);
});

test('the session id is stable: same value across reconnects and devices', async (t) => {
  const n8n = await startFakeN8n(jsonReply({ reply: 'ok' }));
  const gateway = await startGateway({ ...AUTH, N8N_WEBHOOK_URL: n8n.url });
  t.after(async () => {
    await gateway.stop();
    await n8n.close();
  });

  // No DEFAULT_SESSION_ID set - the gateway derives one from the user.
  const first = await TestClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  const readyA = await first.waitForEvent('connection.ready');
  assert.equal(readyA.data.defaultSessionId, 'session_aman');
  await first.close();

  // A second device, and a later reconnect, must land on the same conversation.
  const second = await TestClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => second.close());
  const readyB = await second.waitForEvent('connection.ready');
  assert.equal(readyB.data.defaultSessionId, 'session_aman');
  assert.notEqual(readyA.data.connectionId, readyB.data.connectionId);

  // A message with no sessionId still reaches the stable session.
  second.send({ event: 'user.message', data: { content: 'hi' } });
  await second.waitForEvent('assistant.message');
  assert.equal(n8n.received[0].body.sessionId, 'session_aman');
  assert.equal(n8n.received[0].body.chatId, 'session_aman');
  assert.equal(n8n.received[0].body.chat_id, 'session_aman');
});

test('DEFAULT_SESSION_ID pins the conversation key explicitly', async (t) => {
  const n8n = await startFakeN8n(jsonReply({ reply: 'ok' }));
  const gateway = await startGateway({ ...AUTH, N8N_WEBHOOK_URL: n8n.url, DEFAULT_SESSION_ID: 'jarvis_main' });
  t.after(async () => {
    await gateway.stop();
    await n8n.close();
  });

  const client = await TestClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => client.close());
  const ready = await client.waitForEvent('connection.ready');
  assert.equal(ready.data.defaultSessionId, 'jarvis_main');

  client.send({ event: 'user.message', data: { messageId: 'msg_7', content: 'hi' } });
  const reply = await client.waitForEvent('assistant.message');
  assert.equal(reply.sessionId, 'jarvis_main');
  assert.equal(reply.data.replyTo, 'msg_7');
});

test('n8n can reply by chatId alone, exactly like a Telegram chat_id', async (t) => {
  const gateway = await startGateway({ ...AUTH, N8N_WEBHOOK_URL: 'http://127.0.0.1:1/x', DEFAULT_SESSION_ID: 'jarvis_main' });
  t.after(() => gateway.stop());

  const client = await TestClient.connect(`${gateway.wsUrl}/?token=${TOKEN}`);
  t.after(() => client.close());
  await client.waitForEvent('connection.ready');
  client.send({ event: 'session.join', sessionId: 'jarvis_main' });
  await client.waitForEvent('session.joined');

  const response = await fetch(`${gateway.httpUrl}/api/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gateway-secret': 'push-secret' },
    body: JSON.stringify({ chatId: 'jarvis_main', content: 'Routed by chatId.' }),
  });
  assert.deepEqual(await response.json(), { ok: true, delivered: 1 });
  const message = await client.waitForEvent('assistant.message');
  assert.equal(message.data.content, 'Routed by chatId.');
});
