import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { pushEvent } from '../common/gateway';
import type { JarvisEvent } from '../common/types';

/**
 * Send Progress - one transient status event for one item.
 *
 * The stage values are the ones the Jarvis client already renders; adding a new
 * one here without teaching the client about it shows nothing.
 */
export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
	sessionId: string,
	pushUrl: string,
): Promise<INodeExecutionData> {
	const content = this.getNodeParameter('content', itemIndex) as string;
	const event = this.getNodeParameter('event', itemIndex, 'tool.started') as JarvisEvent;

	const response = await pushEvent(this, pushUrl, { sessionId, event, content });

	return { json: response, pairedItem: { item: itemIndex } };
}
