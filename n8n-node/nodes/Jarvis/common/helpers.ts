import { NodeOperationError, type IExecuteFunctions } from 'n8n-workflow';

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
