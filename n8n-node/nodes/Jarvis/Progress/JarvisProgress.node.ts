import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';

import { getPushUrl, pushEvent } from '../common/gateway';
import { requireSession } from '../common/helpers';
import type { JarvisEvent } from '../common/types';

/**
 * Sends transient progress/status events while a workflow runs. The stage
 * values are the ones the Jarvis client already renders; adding a new one here
 * without teaching the client about it shows nothing.
 */
export class JarvisProgress implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Jarvis Progress',
		name: 'jarvisProgress',
		icon: 'file:../jarvis.svg',
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Show a transient progress message in the Jarvis chat app',
		defaults: { name: 'Jarvis Progress' },
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
				description: 'Jarvis conversation/session that should receive the event',
			},
			{
				displayName: 'Stage',
				name: 'event',
				type: 'options',
				default: 'tool.started',
				description: 'Which stage of the run this update reports',
				options: [
					{ name: 'Tool Started', value: 'tool.started' },
					{ name: 'Tool Progress', value: 'tool.progress' },
					{ name: 'Tool Finished', value: 'tool.finished' },
					{ name: 'Execution Progress', value: 'execution.progress' },
				],
			},
			{
				displayName: 'Status',
				name: 'content',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'Searching your email…',
				description: 'Progress/status message',
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
			const event = this.getNodeParameter('event', i, 'tool.started') as JarvisEvent;

			try {
				const response = await pushEvent(this, pushUrl, { sessionId, event, content });
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
