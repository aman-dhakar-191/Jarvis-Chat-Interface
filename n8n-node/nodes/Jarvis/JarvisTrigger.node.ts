import {
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
		description:
			'Starts the workflow when a message arrives from the Jarvis chat app. In sync mode end the workflow with the node that produces the reply - Respond to Webhook does not work behind a community trigger.',
		defaults: { name: 'Jarvis Trigger' },
		inputs: [],
		outputs: ['main'] as INodeTypeDescription['outputs'],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: '={{$parameter["responseMode"]}}',
				/*
				 * One field, two meanings - see getResponseData() in n8n's own
				 * Webhook node:
				 *
				 *   lastNode   -> an enum naming what to return, so the reply is
				 *                 the final node's first item.
				 *   onReceived -> the literal body sent back immediately.
				 *
				 * Hardcoding the async text here also fed it to sync mode, where
				 * it is not a valid enum value and so never returned the reply.
				 */
				responseData:
					'={{$parameter["responseMode"] === "onReceived" ? $parameter["responseText"] : "firstEntryJson"}}',
				// Without isFullPath, n8n prefixes the webhookId to the path and the
				// webhook registers at /webhook/<uuid>/<path> instead of
				// /webhook/<path>. n8n's own Webhook node sets this for the same reason.
				isFullPath: true,
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
				placeholder: 'jarvis-chat',
				description:
					"Webhook path, with no leading slash. The gateway's N8N_WEBHOOK_URL must end with this exact path.",
			},
			{
				displayName: 'Respond',
				name: 'responseMode',
				type: 'options',
				// 'responseNode' is deliberately absent: n8n's Respond to Webhook node
				// only recognises the core Webhook node, and fails with "No Webhook
				// node found in the workflow" behind a community trigger.
				default: 'lastNode',
				options: [
					{
						name: 'When Last Node Finishes',
						value: 'lastNode',
						description:
							'Sync mode. n8n returns the final node\'s first item, so no Respond to Webhook node is needed - and none will work here.',
					},
					{
						name: 'Immediately',
						value: 'onReceived',
						description: 'Async mode: reply later via the Jarvis node or /api/push',
					},
				],
			},
			{
				displayName: 'Immediate Reply',
				name: 'responseText',
				type: 'string',
				default: 'Working on it...',
				description:
					'Sent back the moment the message arrives, before the workflow runs - so no workflow data exists yet and $json is empty. The expression is evaluated per request though, so it can still vary: {{ ["Working on it...", "On it...", "Give me a sec..."][Math.floor(Math.random() * 3)] }}',
				placeholder: 'Working on it...',

				displayOptions: {
					show: { responseMode: ['onReceived'] },
				},
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
		// Reject with a specific status and message rather than throwing. A throw
		// here surfaces to the caller as a bare 500 "Workflow could not be
		// started", which says nothing about what was actually wrong.
		const reject = (status: number, error: string, hint: string): IWebhookResponseData => {
			this.getResponseObject().status(status).json({ error, hint });
			return { noWebhookResponse: true };
		};

		const expected = this.getNodeParameter('sharedSecret', '') as string;
		if (expected) {
			const headers = this.getHeaderData() as IDataObject;
			if (headers['x-jarvis-secret'] !== expected) {
				return reject(
					401,
					'x-jarvis-secret did not match',
					"Set the gateway's N8N_WEBHOOK_SECRET to the same value, or clear Shared Secret on this node.",
				);
			}
		}

		const body = (this.getBodyData() ?? {}) as IDataObject;
		const normalized = normalizeChatInput(body);
		if (!normalized.content) {
			return reject(
				400,
				'the payload carried no message text',
				'Expected `message`, `content`, or a Telegram `message.text`.',
			);
		}

		return { workflowData: [[{ json: normalized }]] };
	}
}
