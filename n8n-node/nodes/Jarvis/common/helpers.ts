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
export function normalizeToolArguments(raw: unknown): IDataObject {
	let value: unknown = raw;

	if (typeof value === 'string') {
		const text = value.trim();
		if (!text) return {};

		try {
			value = JSON.parse(text);
		} catch {
			// Not JSON at all - keep it visible instead of silently dropping it.
			return { raw: text };
		}
	}

	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

	let args = { ...(value as IDataObject) };

	for (const wrapper of ['toolParameters', 'hitlParameters']) {
		const nested = args[wrapper];

		if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
			// The wrapper's own contents win: they are the arguments, and the
			// outer level only carries the call's envelope.
			args = { ...args, ...(nested as IDataObject) };
			delete args[wrapper];
		}
	}

	return args;
}
