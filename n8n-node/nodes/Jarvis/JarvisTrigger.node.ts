import {
	NodeOperationError,
	type IDataObject,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';

import { normalizeChatInput } from './normalize';

export class JarvisTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Jarvis Trigger',
		name: 'jarvisTrigger',
		icon: 'file:jarvis.svg',
		group: ['trigger'],
		version: 1,
		description: 'Starts the workflow when a message arrives from the Jarvis chat app',
		defaults: { name: 'Jarvis Trigger' },
		inputs: [],
		outputs: ['main'] as INodeTypeDescription['outputs'],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: '={{$parameter["responseMode"]}}',
				path: '={{$parameter["path"]}}',
			},
		],
		properties: [
			{
				displayName: 'Path',
				name: 'path',
				type: 'string',
				default: 'jarvis-chat',
				required: true,
				description: 'Webhook path. Must match the gateway\'s N8N_WEBHOOK_URL.',
			},
			{
				displayName: 'Respond',
				name: 'responseMode',
				type: 'options',
				default: 'responseNode',
				options: [
					{
						name: "Using 'Respond to Webhook' Node",
						value: 'responseNode',
						description: 'Sync mode: the gateway waits for this workflow to answer',
					},
					{
						name: 'Immediately',
						value: 'onReceived',
						description: 'Async mode: reply later via the Jarvis node or /api/push',
					},
				],
			},
			{
				displayName: 'Shared Secret',
				name: 'sharedSecret',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				description:
					"The gateway's N8N_WEBHOOK_SECRET. Leave empty to accept any caller. Checked against the x-jarvis-secret header.",
			},
		],
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const expected = this.getNodeParameter('sharedSecret', '') as string;
		if (expected) {
			const headers = this.getHeaderData() as IDataObject;
			const provided = headers['x-jarvis-secret'];
			if (provided !== expected) {
				throw new NodeOperationError(this.getNode(), 'Rejected: x-jarvis-secret did not match');
			}
		}

		const body = (this.getBodyData() ?? {}) as IDataObject;
		const normalized = normalizeChatInput(body);
		if (!normalized.content) {
			throw new NodeOperationError(this.getNode(), 'Rejected: the payload carried no message text');
		}

		return { workflowData: [[{ json: normalized }]] };
	}
}
