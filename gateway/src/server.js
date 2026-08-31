'use strict';

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { WebSocketServer } = require('ws');

const logger = require('./logger');
const protocol = require('./protocol');
const { authenticate, originAllowed, safeEqual } = require('./auth');
const { Connection, ConnectionRegistry } = require('./connections');
const { ExecutionStore } = require('./executions');
const { ApprovalStore, resumeUrlAllowed } = require('./approvals');
const { dispatch } = require('./handlers');

const { ERROR_CODES } = protocol;

function createServer(config) {
  const registry = new ConnectionRegistry();
  const executions = new ExecutionStore();
  const approvals = new ApprovalStore();
  const ctx = { config, registry, executions, approvals };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      connections: registry.size,
      pendingExecutions: executions.byMessageId.size,
      pendingApprovals: approvals.size,
      authEnabled: config.authEnabled,
      n8nConfigured: Boolean(config.n8n.webhookUrl),
      responseMode: config.n8n.responseMode,
    });
  });

  // n8n -> gateway -> client. Powers async replies and unprompted notifications.
  app.post('/api/push', (req, res) => {
    if (!config.pushSecret) {
      return res.status(503).json({ ok: false, error: 'PUSH_SECRET is not configured' });
    }
    const provided = req.get('x-gateway-secret') || '';
    if (!safeEqual(config.pushSecret, provided)) {
      logger.warn('rejected push with bad secret', { ip: req.ip });
      return res.status(401).json({ ok: false, error: 'invalid secret' });
    }

    const body = req.body || {};
    const replyTo = body.messageId ? String(body.messageId) : null;
    const eventName = typeof body.event === 'string' && body.event ? body.event : 'assistant.message';
    const content = typeof body.content === 'string' ? body.content : body.message;

    // If this push answers a tracked execution, inherit its routing and close it out.
    const execution = replyTo ? executions.settle(replyTo) : null;
    const filter = {
      connectionId: body.connectionId || execution?.connectionId,
      // chatId is accepted as an alias so a Telegram-shaped workflow can reply
      // with whichever key it already carries.
      sessionId: body.sessionId || body.chatId || body.chat_id || execution?.sessionId,
      userId: body.userId || execution?.userId,
    };
    if (!filter.connectionId && !filter.sessionId && !filter.userId) {
      return res.status(400).json({ ok: false, error: 'one of connectionId, sessionId, chatId or userId is required' });
    }

    if (execution) {
      registry.get(execution.connectionId)?.inflight.delete(replyTo);
    }

    const data = body.data && typeof body.data === 'object' ? { ...body.data } : {};
    if (content !== undefined) data.content = content;
    if (replyTo) data.replyTo = replyTo;
    data.messageId = data.messageId || protocol.messageId();

    // Human-in-the-loop: n8n parks a Wait node and hands us its resume URL.
    // Register it server-side and strip it - the client only sees an opaque id,
    // so a resume capability never leaves the gateway.
    if (eventName === 'approval.request') {
      const resumeUrl = body.resumeUrl || data.resumeUrl;
      if (!resumeUrl) {
        return res.status(400).json({ ok: false, error: 'approval.request requires resumeUrl' });
      }
      if (!resumeUrlAllowed(resumeUrl, config)) {
        logger.warn('rejected approval with out-of-scope resumeUrl', { resumeUrl });
        return res.status(400).json({
          ok: false,
          error: `resumeUrl must start with ${config.n8n.resumeUrlPrefix} (set N8N_RESUME_URL_PREFIX to change)`,
        });
      }
      delete data.resumeUrl;
      data.approvalId = approvals.create({
        approvalId: data.approvalId,
        resumeUrl,
        sessionId: filter.sessionId || null,
        userId: filter.userId || null,
        ttlMs: config.approvalTimeoutMs,
        onExpire: (approvalId, sessionId) => {
          registry.deliver({ sessionId }, protocol.makeEvent('approval.expired', {
            sessionId,
            data: { approvalId },
          }));
        },
      });
      // A list of choices makes the client render buttons; default to yes/no.
      if (!Array.isArray(data.choices) || data.choices.length === 0) {
        data.choices = [
          { value: 'approve', label: 'Approve' },
          { value: 'reject', label: 'Reject' },
        ];
      }
    }

    const outbound = protocol.makeEvent(eventName, { sessionId: filter.sessionId || null, data });
    const delivered = registry.deliver(filter, outbound);

    if (execution && eventName === 'assistant.message') {
      registry.deliver(filter, protocol.makeEvent('execution.completed', {
        sessionId: filter.sessionId || null,
        data: { messageId: replyTo },
      }));
    }

    logger.info('push delivered', { event: eventName, delivered, replyTo });
    res.json({ ok: true, delivered });
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  const server = http.createServer(app);
  // `noServer` lets us reject the handshake before a socket is ever upgraded,
  // so an unauthenticated client never reaches the message loop.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.limits.maxMessageBytes,
    // Echo back only the `bearer` marker, never the token itself.
    handleProtocols: (protocols) => (protocols.has('bearer') ? 'bearer' : false),
  });

  server.on('upgrade', (req, socket, head) => {
    if (!originAllowed(req, config)) {
      logger.warn('rejected upgrade: origin not allowed', { origin: req.headers.origin });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    const auth = authenticate(req, config);
    if (!auth.ok) {
      logger.warn('rejected upgrade: auth failed', { reason: auth.reason });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, auth));
  });

  wss.on('connection', (ws, req, auth) => {
    const connection = registry.add(new Connection(ws, auth));
    // One stable conversation key per user unless the client asks for another.
    connection.defaultSessionId = config.defaultSessionId || `session_${connection.userId}`;
    logger.info('client connected', {
      connectionId: connection.id,
      userId: connection.userId,
      anonymous: connection.anonymous,
      total: registry.size,
    });

    connection.send(
      protocol.makeEvent('connection.ready', {
        data: {
          connectionId: connection.id,
          userId: connection.userId,
          defaultSessionId: connection.defaultSessionId,
          responseMode: config.n8n.responseMode,
          authEnabled: config.authEnabled,
        },
      }),
    );

    ws.on('pong', () => {
      connection.isAlive = true;
    });

    ws.on('message', async (raw) => {
      const parsed = protocol.parseInbound(raw, { maxBytes: config.limits.maxMessageBytes });
      if (!parsed.ok) {
        return connection.send(protocol.makeError(parsed.code, parsed.message, { sessionId: connection.sessionId }));
      }
      try {
        await dispatch(ctx, connection, parsed.event);
      } catch (err) {
        logger.error('handler threw', { connectionId: connection.id, event: parsed.event.event, error: err.stack });
        connection.send(
          protocol.makeError(ERROR_CODES.INTERNAL_ERROR, 'Gateway error while handling the event', {
            sessionId: connection.sessionId,
          }),
        );
      }
    });

    ws.on('close', () => {
      registry.remove(connection.id);
      executions.dropConnection(connection.id);
      logger.info('client disconnected', { connectionId: connection.id, total: registry.size });
    });

    ws.on('error', (err) => logger.error('socket error', { connectionId: connection.id, error: err.message }));
  });

  // Drop connections that stop answering pings; the client reconnects on its own.
  const heartbeat = setInterval(() => {
    for (const connection of registry.connections.values()) {
      if (!connection.isAlive) {
        logger.warn('terminating unresponsive connection', { connectionId: connection.id });
        connection.ws.terminate();
        continue;
      }
      connection.isAlive = false;
      try {
        connection.ws.ping();
      } catch {
        connection.ws.terminate();
      }
    }
  }, config.limits.heartbeatIntervalMs);
  heartbeat.unref();

  async function close() {
    clearInterval(heartbeat);
    executions.clear();
    approvals.clear();
    registry.closeAll();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }

  return { app, server, wss, registry, executions, approvals, close };
}

module.exports = { createServer };
