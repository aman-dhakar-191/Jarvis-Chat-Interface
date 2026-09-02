import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { pushEvent } from '../common/gateway';

/**
 * Send Notification - one `notification` event for one item.
 *
 * The caller owns the item loop, the session validation and continueOnFail, so
 * this only has to build the body and push it.
 */
export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
	sessionId: string,
	pushUrl: string,
): Promise<INodeExecutionData> {
	const content = this.getNodeParameter('notifyContent', itemIndex) as string;

	const response = await pushEvent(this, pushUrl, {
		sessionId,
		event: 'notification',
		content,
	});

	return { json: response, pairedItem: { item: itemIndex } };
}
