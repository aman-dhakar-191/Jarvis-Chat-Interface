import { NodeOperationError, type IDataObject, type IExecuteFunctions } from 'n8n-workflow';

/**
 * Every Jarvis event is addressed to a conversation. An empty session id is a
 * configuration mistake, not an empty result, so fail loudly with the same
 * message from every node rather than pushing an undeliverable event.
 */
export function requireSession(
	ctx: IExecuteFunctions,
	value: unknown,
	itemIndex: number,
): string {
	const sessionId = typeof value === 'string' ? value.trim() : '';

	if (!sessionId) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Session ID is empty, so the gateway cannot determine which Jarvis conversation should receive the event',
			{
				itemIndex,
				description:
					'Make sure the Jarvis sessionId is available. For sub-workflows use the sessionId supplied by the parent agent.',
			},
		);
	}

	return sessionId;
}

/**
 * The arguments a HITL call carries about the gated tool, in one shape.
 *
 * n8n merges the gated tool's arguments into the HITL call, and the shape
 * follows whatever the model emitted - the same tool in the same run has
 * arrived both flat:
 *
 *     { tool, action, command, extra, Message }
 *
 * and wrapped:
 *
 *     { tool, Message, toolParameters: { action, command, extra } }
 *
 * Either way the caller wants the arguments themselves, so a wrapper is folded
 * into the top level. Malformed JSON is reported as text rather than thrown:
 * a status message is not worth failing an approval over.
 *
 * Only the two wrapper keys are known here, and both are n8n's own. Nothing
 * about any particular workflow's field names belongs in this function - it has
 * to hold for whatever a node is wired to.
 */
const WRAPPER_KEYS = ['toolParameters', 'hitlParameters'];

/** How many times a wrapper may be nested before we stop digging. */
const MAX_UNWRAP_DEPTH = 5;

/**
 * The value as a plain object, parsing it first if it arrived as JSON text.
 * Anything that is not an object - an array, a number, unparseable text - has
 * no arguments in it, so it comes back undefined.
 */
function asObject(value: unknown): IDataObject | undefined {
	if (typeof value === 'string') {
		const text = value.trim();
		if (!text) return undefined;

		try {
			// Recursive because a value can arrive encoded more than once.
			return asObject(JSON.parse(text));
		} catch {
			return undefined;
		}
	}

	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

	return value as IDataObject;
}

export function normalizeToolArguments(raw: unknown): IDataObject {
	// Text that is not JSON at all stays visible rather than being dropped.
	if (typeof raw === 'string') {
		const text = raw.trim();
		if (!text) return {};

		try {
			JSON.parse(text);
		} catch {
			return { raw: text };
		}
	}

	const parsed = asObject(raw);
	if (!parsed) return {};

	let args: IDataObject = { ...parsed };

	for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
		let unwrapped = false;

		for (const wrapper of WRAPPER_KEYS) {
			const nested = asObject(args[wrapper]);
			if (!nested) continue;

			/*
			 * Drop the wrapper BEFORE merging its contents. Merging first and
			 * deleting after loses everything when a wrapper is nested inside
			 * itself: the inner object overwrites the key, and the delete then
			 * removes the arguments along with it.
			 */
			const rest: IDataObject = { ...args };
			delete rest[wrapper];

			// The wrapper's own contents win: they are the arguments, and the
			// outer level only carries the call's envelope.
			args = { ...rest, ...nested };
			unwrapped = true;
		}

		if (!unwrapped) break;
	}

	return args;
}
