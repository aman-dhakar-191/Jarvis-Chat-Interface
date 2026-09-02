import type { IDataObject } from 'n8n-workflow';

/** The canonical shape every Jarvis entry point emits. */
export interface NormalizedChatInput extends IDataObject {
	source: string;
	userId: string;
	sessionId: string;
	chatId: string;
	messageId: string;
	connectionId: string | null;
	message: string;
	content: string;
	chatInput: string;
	timestamp: string;
}

interface TelegramMessage {
	message_id?: number | string;
	text?: string;
	caption?: string;
	chat?: { id?: number | string };
	from?: { id?: number | string };
}

/**
 * Accepts either the Jarvis Gateway payload or a Telegram Trigger item and
 * returns one shape, so downstream Jarvis logic never learns which transport
 * the message arrived on.
 *
 * Telegram nests the text under `message` as an object; the gateway sends
 * `message` as a plain string, so the presence of `message.chat` is what
 * distinguishes them.
 */
export function normalizeChatInput(body: IDataObject): NormalizedChatInput {
	const candidate = body.message as TelegramMessage | string | undefined;
	const telegram =
		candidate && typeof candidate === 'object' && candidate.chat ? candidate : undefined;

	const chatId = String(
		telegram?.chat?.id ?? body.chatId ?? body.chat_id ?? body.sessionId ?? '',
	);
	// The conversation key. Never regenerate it: Jarvis memory hangs off it.
	const sessionId = String(body.sessionId ?? chatId);
	const text = telegram
		? String(telegram.text ?? telegram.caption ?? '')
		: String((body.message as string) ?? body.content ?? '');

	return {
		source: telegram ? 'telegram' : String(body.source ?? 'custom_chat'),
		userId: String(telegram?.from?.id ?? body.userId ?? ''),
		sessionId,
		chatId,
		messageId: String(telegram?.message_id ?? body.messageId ?? ''),
		connectionId: body.connectionId ? String(body.connectionId) : null,
		// All three carry the text, so whichever field your existing nodes
		// already reference keeps working.
		message: text,
		content: text,
		chatInput: text,
		timestamp: String(body.timestamp ?? new Date().toISOString()),
	};
}
