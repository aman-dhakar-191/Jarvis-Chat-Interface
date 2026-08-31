// ---------------------------------------------------------------------------
// Format Reply
// Pulls Jarvis's answer out of whatever the existing workflow returned, then
// re-attaches the routing ids the gateway needs: sessionId, chatId, messageId.
// ---------------------------------------------------------------------------

const ctx = $('Normalize Chat Input').first().json;

const REPLY_KEYS = ['reply', 'output', 'text', 'answer', 'response', 'message', 'content', 'result'];

function pickText(value, depth = 0) {
  if (value == null || depth > 6) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = pickText(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const key of REPLY_KEYS) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  for (const key of ['json', 'data', 'body', 'result', 'output', 'message']) {
    if (value[key] && typeof value[key] === 'object') {
      const found = pickText(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

const incoming = $input.all().map((item) => item.json);
// The fallback keeps this workflow testable before the real Jarvis node is enabled.
const reply = pickText(incoming) ?? `(no Jarvis node connected yet) You said: ${ctx.message}`;

return [{
  json: {
    // Several aliases so the gateway - and any other consumer - finds the text.
    reply,
    text: reply,
    output: reply,
    // Routing: the gateway delivers by messageId first, then chatId/sessionId.
    messageId: ctx.messageId,
    replyTo: ctx.messageId,
    chatId: ctx.chatId,
    sessionId: ctx.sessionId,
    userId: ctx.userId,
    source: ctx.source,
  },
}];
