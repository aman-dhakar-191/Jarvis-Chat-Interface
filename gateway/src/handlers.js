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

  // The client may route a single message to n8n's test webhook, so switching
  // does not need a gateway redeploy.
  const useTest = event.data.useTestWebhook === true;

  logger.info('forwarding to n8n', {
    connectionId: connection.id,
    sessionId: connection.sessionId,
    messageId,
    mode: config.n8n.responseMode,
    useTest,
  });

  if (config.n8n.responseMode === 'async') {
    return startAsyncExecution(ctx, connection, { payload, messageId, useTest });
  }
  return runSyncExecution(ctx, connection, { payload, messageId, useTest });
}

async function runSyncExecution(ctx, connection, { payload, messageId, useTest = false }) {
  const { config } = ctx;
  const sessionId = payload.sessionId;

  let result;
  try {
    result = await n8n.callWebhook(payload, config, { useTest });
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
async function startAsyncExecution(ctx, connection, { payload, messageId, useTest = false }) {
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

  const result = await n8n.callWebhook(payload, config, { useTest });
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

/**
 * `approval.respond` - the user answered a human-in-the-loop prompt.
 * The gateway resumes the parked n8n execution on their behalf; the client
 * never holds the resume URL.
 */
async function handleApprovalRespond(ctx, connection, event) {
  const { config, approvals, registry } = ctx;
  const approvalId = event.data.approvalId ? String(event.data.approvalId) : '';
  const choice = typeof event.data.choice === 'string' ? event.data.choice.trim() : '';
  // A question is answered with free text; a decision with a choice.
  const answer = typeof event.data.text === 'string' ? event.data.text.trim() : '';

  if (!approvalId || (!choice && !answer)) {
    return sendError(
      connection,
      ERROR_CODES.INVALID_MESSAGE,
      'approval.respond requires data.approvalId and either data.choice or data.text',
    );
  }
  if (answer.length > protocol.MAX_CONTENT_CHARS) {
    return sendError(connection, ERROR_CODES.INVALID_MESSAGE, 'data.text is too long');
  }

  const pending = approvals.get(approvalId);
  if (!pending) {
    return sendError(connection, ERROR_CODES.APPROVAL_NOT_FOUND, 'That approval is unknown, already answered, or expired', { approvalId });
  }
  // Only the user the approval was raised for may answer it.
  if (pending.userId && pending.userId !== connection.userId) {
    return sendError(connection, ERROR_CODES.APPROVAL_NOT_FOUND, 'That approval is unknown, already answered, or expired', { approvalId });
  }

  // Settle first so a double-tap cannot resume the workflow twice.
  approvals.settle(approvalId);
  connection.send(protocol.makeAck(event.id, 'accepted', { approvalId }));

  const body = {
    approvalId,
    // A typed answer counts as approval: the user engaged and supplied it.
    choice: choice || 'answered',
    approved: choice ? choice === 'approve' : true,
    answer: answer || null,
    comment: typeof event.data.comment === 'string' ? event.data.comment : null,
    userId: connection.userId,
    sessionId: pending.sessionId,
    respondedAt: new Date().toISOString(),
  };

  let ok = false;
  try {
    const response = await fetch(pending.resumeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    ok = response.ok;
    if (!ok) logger.error('resume call rejected', { approvalId, status: response.status });
  } catch (err) {
    logger.error('resume call failed', { approvalId, error: err.message });
  }

  if (!ok) {
    return sendError(connection, ERROR_CODES.APPROVAL_FAILED, 'Could not resume the workflow in n8n', { approvalId });
  }

  logger.info('approval resumed', {
    approvalId,
    choice: body.choice,
    answered: Boolean(answer),
    sessionId: pending.sessionId,
  });
  // Tell every device in the session, so a second phone stops showing buttons.
  registry.deliver(
    { sessionId: pending.sessionId },
    protocol.makeEvent('approval.resolved', {
      sessionId: pending.sessionId,
      data: { approvalId, choice: body.choice, answer: body.answer, by: connection.userId },
    }),
  );
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
    case 'approval.respond':
      return handleApprovalRespond(ctx, connection, event);
    case 'connection.ping':
      return handlePing(ctx, connection, event);
    default:
      return sendError(connection, ERROR_CODES.INVALID_MESSAGE, `Unsupported event "${event.event}"`);
  }
}

module.exports = { dispatch };
