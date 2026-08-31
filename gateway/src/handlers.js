'use strict';

const logger = require('./logger');
const protocol = require('./protocol');
const n8n = require('./n8n');

const { ERROR_CODES } = protocol;

function sendError(connection, code, message, details) {
  connection.send(protocol.makeError(code, message, { sessionId: connection.sessionId, details }));
}

/** `session.join` - bind this connection to a conversation. */
function handleSessionJoin(ctx, connection, event) {
  const sessionId = event.sessionId || event.data.sessionId;
  if (!sessionId || !protocol.ID_PATTERN.test(String(sessionId))) {
    return sendError(connection, ERROR_CODES.INVALID_SESSION, 'session.join requires a valid sessionId');
  }
  connection.sessionId = String(sessionId);
  connection.send(protocol.makeAck(event.id, 'accepted'));
  connection.send(
    protocol.makeEvent('session.joined', {
      sessionId: connection.sessionId,
      data: { connectionId: connection.id, userId: connection.userId },
    }),
  );
  logger.info('session joined', { connectionId: connection.id, sessionId: connection.sessionId });
}

/**
 * `user.message` - the full loop:
 * ack -> execution.started -> POST n8n -> assistant.message -> execution.completed
 * sessionId and messageId are carried through every hop untouched.
 */
async function handleUserMessage(ctx, connection, event) {
  const { config } = ctx;

  // Falls back to the connection's stable default so a client that never sent
  // session.join still lands in the user's one ongoing conversation.
  const sessionId = event.sessionId || connection.sessionId || connection.defaultSessionId;
  if (!sessionId) {
    return sendError(connection, ERROR_CODES.INVALID_SESSION, 'No session - send session.join first or include sessionId');
  }
  connection.sessionId = String(sessionId);

  const valid = protocol.validateUserMessage(event.data);
  if (!valid.ok) {
    return sendError(connection, valid.code, valid.message);
  }
  const { content, messageId } = valid;

  if (connection.inflight.size >= config.limits.maxInflightPerConnection) {
    return sendError(connection, ERROR_CODES.RATE_LIMITED, `At most ${config.limits.maxInflightPerConnection} messages may be in flight at once`, { messageId });
  }

  connection.send(protocol.makeAck(event.id, 'accepted', { messageId }));
  connection.inflight.add(messageId);
  connection.send(
    protocol.makeEvent('execution.started', { sessionId: connection.sessionId, data: { messageId } }),
  );

  const payload = n8n.buildPayload({
    userId: connection.userId,
    sessionId: connection.sessionId,
    messageId,
    content,
    connectionId: connection.id,
  });

  logger.info('forwarding to n8n', {
    connectionId: connection.id,
    sessionId: connection.sessionId,
    messageId,
    mode: config.n8n.responseMode,
  });

  if (config.n8n.responseMode === 'async') {
    return startAsyncExecution(ctx, connection, { payload, messageId });
  }
  return runSyncExecution(ctx, connection, { payload, messageId });
}

async function runSyncExecution(ctx, connection, { payload, messageId }) {
  const { config } = ctx;
  const sessionId = payload.sessionId;

  let result;
  try {
    result = await n8n.callWebhook(payload, config);
  } catch (err) {
    logger.error('unexpected n8n failure', { messageId, error: err.stack });
    result = { ok: false, errorCode: ERROR_CODES.INTERNAL_ERROR, errorMessage: 'Gateway failed while calling n8n' };
  }

  connection.inflight.delete(messageId);

  if (!result.ok) {
    connection.send(protocol.makeError(result.errorCode, result.errorMessage, { sessionId, details: { messageId } }));
    return connection.send(
      protocol.makeEvent('execution.failed', {
        sessionId,
        data: { messageId, code: result.errorCode, message: result.errorMessage },
      }),
    );
  }

  if (!result.reply) {
    // n8n accepted the message but returned no text. Common when the workflow
    // has no "Respond to Webhook" node - tell the client plainly rather than
    // rendering an empty bubble.
    logger.warn('n8n returned no reply text', { messageId, status: result.status });
    connection.send(
      protocol.makeError(ERROR_CODES.EXECUTION_FAILED, 'Jarvis returned no reply text. Check that the n8n workflow ends in a "Respond to Webhook" node, or set N8N_RESPONSE_MODE=async.', {
        sessionId,
        details: { messageId },
      }),
    );
    return connection.send(
      protocol.makeEvent('execution.failed', { sessionId, data: { messageId, code: ERROR_CODES.EXECUTION_FAILED } }),
    );
  }

  connection.send(
    protocol.makeEvent('assistant.message', {
      sessionId,
      data: { messageId: protocol.messageId(), replyTo: messageId, content: result.reply },
    }),
  );
  connection.send(
    protocol.makeEvent('execution.completed', {
      sessionId,
      data: { messageId, durationMs: result.durationMs },
    }),
  );
}

/**
 * Async mode: fire the webhook, do not wait for its body. n8n calls back into
 * POST /api/push with the same messageId once Jarvis has finished.
 */
async function startAsyncExecution(ctx, connection, { payload, messageId }) {
  const { config, executions } = ctx;
  const sessionId = payload.sessionId;

  executions.start({
    messageId,
    connectionId: connection.id,
    sessionId,
    userId: connection.userId,
    timeoutMs: config.n8n.timeoutMs,
    onTimeout: () => {
      connection.inflight.delete(messageId);
      connection.send(
        protocol.makeError(ERROR_CODES.EXECUTION_TIMEOUT, `Jarvis did not call back within ${config.n8n.timeoutMs}ms`, {
          sessionId,
          details: { messageId },
        }),
      );
      connection.send(
        protocol.makeEvent('execution.failed', { sessionId, data: { messageId, code: ERROR_CODES.EXECUTION_TIMEOUT } }),
      );
    },
  });

  const result = await n8n.callWebhook(payload, config);
  if (!result.ok) {
    executions.settle(messageId);
    connection.inflight.delete(messageId);
    connection.send(protocol.makeError(result.errorCode, result.errorMessage, { sessionId, details: { messageId } }));
    connection.send(
      protocol.makeEvent('execution.failed', {
        sessionId,
        data: { messageId, code: result.errorCode, message: result.errorMessage },
      }),
    );
    return;
  }

  // Some workflows answer immediately even in async mode - honour that and
  // settle early rather than making the client wait for a callback.
  if (result.reply) {
    const execution = executions.settle(messageId);
    if (execution) {
      connection.inflight.delete(messageId);
      connection.send(
        protocol.makeEvent('assistant.message', {
          sessionId,
          data: { messageId: protocol.messageId(), replyTo: messageId, content: result.reply },
        }),
      );
      connection.send(protocol.makeEvent('execution.completed', { sessionId, data: { messageId } }));
    }
  }
}

function handlePing(ctx, connection, event) {
  connection.send(
    protocol.makeEvent('connection.pong', { sessionId: connection.sessionId, data: { echo: event.data } }),
  );
}

async function dispatch(ctx, connection, event) {
  switch (event.event) {
    case 'session.join':
      return handleSessionJoin(ctx, connection, event);
    case 'session.leave':
      connection.sessionId = null;
      return connection.send(protocol.makeAck(event.id, 'accepted'));
    case 'user.message':
      return handleUserMessage(ctx, connection, event);
    case 'connection.ping':
      return handlePing(ctx, connection, event);
    default:
      return sendError(connection, ERROR_CODES.INVALID_MESSAGE, `Unsupported event "${event.event}"`);
  }
}

module.exports = { dispatch };
