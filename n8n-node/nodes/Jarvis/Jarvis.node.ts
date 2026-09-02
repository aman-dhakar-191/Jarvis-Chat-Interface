import {
	SEND_AND_WAIT_OPERATION,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';

import { getPushUrl } from './common/gateway';
import { requireSession } from './common/helpers';

import { humanReviewDescription } from './descriptions/humanReview';
import { notificationDescription } from './descriptions/notification';
import { progressDescription } from './descriptions/progress';

import * as humanReview from './operations/humanReview.operation';
import * as notification from './operations/notification.operation';
import * as progress from './operations/progress.operation';

/**
 * One integration node with several actions, laid out the way n8n's own
 * Telegram node is: the operations live in `operations/`, their fields in
 * `descriptions/`, and the human-in-the-loop operation keeps its own module
 * because it owns the whole execution rather than one item.
 *
 * Each operation's `action` is what the node creator lists, so the picker still
 * offers "Send progress", "Send notification" and "Send and wait for approval"
 * as separate entries without them being separate node types.
 */
export class Jarvis implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Jarvis',
		name: 'jarvis',
		icon: 'file:jarvis.svg',
		group: ['output'],
		version: 1,

		subtitle: '={{$parameter["operation"]}}',

		description: 'Send notifications and request human approval through the Jarvis chat app',

		defaults: {
			name: 'Jarvis',
		},

		/*
		 * IMPORTANT:
		 *
		 * Keep this as a normal `main` node. n8n generates
		 *
		 *     jarvisHitlTool
		 *
		 * itself when it detects the sendAndWait operation below, and that
		 * generated node is what an AI Agent connects to as ai_tool.
		 */
		inputs: ['main'] as INodeTypeDescription['inputs'],
		outputs: ['main'] as INodeTypeDescription['outputs'],

		credentials: [
			{
				name: 'jarvisGatewayApi',
				required: true,
			},
		],

		/*
		 * Resume webhook, used only by sendAndWait. n8n exposes
		 * $execution.resumeUrl while the execution is waiting, and
		 * restartWebhook is what makes the gateway's call resume the parked
		 * execution instead of starting a new one.
		 */
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: '',
				restartWebhook: true,
			},
		],

		properties: [
			// ================================================================
			// OPERATION
			// ================================================================

			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,

				default: 'sendProgress',

				options: [
					{
						name: 'Send Progress',
						value: 'sendProgress',
						description: 'Show a transient progress message',
						action: 'Send progress',
					},

					{
						name: 'Send Notification',
						value: 'notify',
						description: 'Send a normal Jarvis notification',
						action: 'Send notification',
					},

					/*
					 * IMPORTANT:
					 *
					 * The value must stay `sendAndWait` (SEND_AND_WAIT_OPERATION).
					 * n8n scans for exactly this value to generate the Jarvis
					 * HITL tool, which is what an AI Agent connects to.
					 *
					 * It was briefly named `*` to keep it out of the node
					 * creator's Actions list - useActionsGeneration.ts filters
					 * those - but that name is also what the Operation dropdown
					 * renders, so the node showed a bare `*` when configured by
					 * hand. n8n's own Slack, Gmail and Telegram nodes all list
					 * this operation; so does this one.
					 */
					{
						name: 'Send and Wait for Approval',
						value: SEND_AND_WAIT_OPERATION,
						description: 'Request approval and pause the execution until the user responds',
						action: 'Send and wait for approval',
					},
				],
			},

			// ================================================================
			// SHARED
			// ================================================================

			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '={{ $json.sessionId }}',
				required: true,
				description: 'Jarvis conversation/session that should receive the event',
			},

			/*
			 * Deliberately not gated on the operation, as it always has been:
			 * the generated jarvisHitlTool replaces this property with its own
			 * HITL-aware Message property, and a displayOptions rule naming
			 * `operation` would depend on a field that variant may not carry.
			 */
			{
				displayName: 'Message',
				name: 'message',
				type: 'string',

				default:
					'=The agent wants to use {{ $tool.name }}\\n\\nInput:\\n{{ JSON.stringify($tool.parameters, null, 2) }}',

				required: true,

				typeOptions: {
					rows: 4,
				},

				description: 'Message shown to the user before the tool is executed',
			},

			// ================================================================
			// PER-OPERATION FIELDS
			// ================================================================

			...progressDescription,
			...notificationDescription,
			...humanReviewDescription,
		],
	};

	// ======================================================================
	// RESUME WEBHOOK
	// ======================================================================

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		return await humanReview.webhook.call(this);
	}

	// ======================================================================
	// EXECUTE
	// ======================================================================

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const operation = this.getNodeParameter('operation', 0) as string;

		const pushUrl = await getPushUrl(this);

		// Parks the execution and returns through webhook(), so it owns the
		// whole node output rather than one item.
		if (operation === SEND_AND_WAIT_OPERATION) {
			return await humanReview.execute.call(this, pushUrl);
		}

		const results: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			// Outside the try on purpose: an unaddressed event is a
			// configuration mistake, and always has failed the node even when
			// continueOnFail is set.
			const sessionId = requireSession(this, this.getNodeParameter('sessionId', i), i);

			try {
				results.push(
					operation === 'notify'
						? await notification.execute.call(this, i, sessionId, pushUrl)
						: await progress.execute.call(this, i, sessionId, pushUrl),
				);
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
