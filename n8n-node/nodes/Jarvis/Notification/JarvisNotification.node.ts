import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';

import { getPushUrl, pushEvent } from '../common/gateway';
import { requireSession } from '../common/helpers';

/**
 * Sends one `notification` event per incoming item and returns the gateway's
 * response. It never parks the execution - use Jarvis Human Review for that.
 */
export class JarvisNotification implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Jarvis Notification',
		name: 'jarvisNotification',
		icon: 'file:../jarvis.svg',
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["sessionId"]}}',
		description: 'Send a notification to the Jarvis chat app',
		defaults: { name: 'Jarvis Notification' },
		inputs: ['main'] as INodeTypeDescription['inputs'],
		outputs: ['main'] as INodeTypeDescription['outputs'],
		credentials: [{ name: 'jarvisGatewayApi', required: true }],
		properties: [
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '={{ $json.sessionId }}',
				required: true,
				description: 'Jarvis conversation/session that should receive the notification',
			},
			{
				displayName: 'Message',
				name: 'content',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				description: 'Text shown to the user in the Jarvis chat app',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const pushUrl = await getPushUrl(this);
		const results: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const sessionId = requireSession(this, this.getNodeParameter('sessionId', i), i);
			const content = this.getNodeParameter('content', i) as string;

			try {
				const response = await pushEvent(this, pushUrl, {
					sessionId,
					event: 'notification',
					content,
				});

				results.push({ json: response, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					results.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}

				throw error;
			}
		}

		return [results];
	}
}
