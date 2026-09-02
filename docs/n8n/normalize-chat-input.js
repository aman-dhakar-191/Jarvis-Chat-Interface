// ---------------------------------------------------------------------------
// Normalize Chat Input
// Accepts EITHER the Jarvis Gateway payload OR a Telegram Trigger item and
// emits one canonical shape, so the rest of Jarvis never learns which
// transport the message arrived on.
// ---------------------------------------------------------------------------

// Optional: paste your gateway's N8N_WEBHOOK_SECRET here to reject strangers.
// Leave it empty to skip the check.
const EXPECTED_SECRET = '';

const out = [];

for (const item of $input.all()) {
  const raw = item.json ?? {};
  // The Webhook node nests the POST body under `body`; a sub-workflow call does not.
  const body = raw.body ?? raw;
  const headers = raw.headers ?? {};

  if (EXPECTED_SECRET && headers['x-jarvis-secret'] !== EXPECTED_SECRET) {
    throw new Error('Rejected: x-jarvis-secret header did not match');
  }

  // Telegram nests the text under `message`; the gateway sends `message` as a
  // plain string, so the presence of `message.chat` is what tells them apart.
  const tg = body.message;
  const isTelegram = tg && typeof tg === 'object' && tg.chat;

  const chatId = String(
    isTelegram ? tg.chat.id : (body.chatId ?? body.chat_id ?? body.sessionId ?? ''),
  );
  // sessionId is the stable conversation key. It must never be regenerated:
  // Jarvis keys its memory on it.
  const sessionId = String(body.sessionId ?? chatId);
  const messageId = String(isTelegram ? (tg.message_id ?? '') : (body.messageId ?? ''));
  const userId = String(isTelegram ? (tg.from?.id ?? '') : (body.userId ?? ''));
  const text = isTelegram ? (tg.text ?? tg.caption ?? '') : (body.message ?? body.content ?? '');

  if (!text) {
    throw new Error('Rejected: no message text found on the incoming payload');
  }

  out.push({
    json: {
      source: isTelegram ? 'telegram' : (body.source || 'custom_chat'),
      userId,
      sessionId,
      chatId,
      messageId,
      connectionId: body.connectionId ?? null,
      // Both names carry the text so existing nodes keep working either way.
      message: text,
      content: text,
      chatInput: text,
      timestamp: body.timestamp ?? new Date().toISOString(),
    },
  });
}

return out;
