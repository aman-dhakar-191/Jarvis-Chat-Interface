import {
	WAIT_INDEFINITELY,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';

import { getPushUrl, pushEvent } from './common/gateway';
import { requireSession } from './common/helpers';
import type { ApprovalOptions } from './common/types';

/**
 * DEPRECATED - superseded by the Jarvis Notification, Jarvis Progress and
 * Jarvis Human Review nodes.
 *
 * It stays registered, keeps the node name `jarvis` and keeps every operation
 * value so that workflows already saved with it - and the `jarvisHitlTool`
 * n8n generates from its `sendAndWait` operation - keep loading and running.
 * `hidden` only removes it from the node creator panel. Do not rename it, and
 * do not add features here; add them to the focused nodes instead.
 */
export class Jarvis implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Jarvis (Legacy)',
		name: 'jarvis',
		icon: 'file:jarvis.svg',
		group: ['output'],
		version: 1,
		hidden: true,

		subtitle: '={{$parameter["operation"]}}',

		description:
			'Deprecated: use Jarvis Notification, Jarvis Progress or Jarvis Human Review instead',

		defaults: {
			name: 'Jarvis',
		},

		/*
		 * IMPORTANT:
		 *
		 * Keep this node as a normal `main` node.
		 *
		 * n8n will automatically generate:
		 *
		 *     jarvisHitlTool
		 *
		 * when it detects the `sendAndWait` operation below.
		 *
		 * That generated node becomes:
		 *
		 *     ai_tool -> Jarvis Human Review -> ai_tool
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
		 * Resume webhook.
		 *
		 * n8n exposes:
		 *
		 *     $execution.resumeUrl
		 *
		 * while the execution is waiting.
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
					 * The exact value MUST be `sendAndWait`.
					 *
					 * n8n detects this operation and automatically
					 * generates the Jarvis HITL Tool variant.
					 */
					{
						name: 'Send and Wait for Approval',
						value: 'sendAndWait',
						description:
							'Request approval and pause the execution until the user responds',
						action: 'Send and wait for approval',
					},

				],
			},

			// ================================================================
			// SESSION
			// ================================================================

			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '={{ $json.sessionId }}',
				required: true,
				description:
					'Jarvis conversation/session that should receive the event',
			},

			// ================================================================
			// MESSAGE
			// ================================================================

			/*
			 * IMPORTANT:
			 *
			 * The generated jarvisHitlTool replaces this property with
			 * its own HITL-aware Message property.
			 *
			 * n8n's generated HITL version can use:
			 *
			 *     $tool.name
			 *     $tool.parameters
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

				description:
					'Message shown to the user before the tool is executed',
			},

			// ================================================================
			// SEND PROGRESS
			// ================================================================

			{
				displayName: 'Status',
				name: 'content',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'Searching your email…',
				description: 'Progress/status message',

				displayOptions: {
					show: {
						operation: ['sendProgress'],
					},
				},
			},

			{
				displayName: 'Stage',
				name: 'event',
				type: 'options',
				default: 'tool.started',

				options: [
					{
						name: 'Tool Started',
						value: 'tool.started',
					},
					{
						name: 'Tool Progress',
						value: 'tool.progress',
					},
					{
						name: 'Tool Finished',
						value: 'tool.finished',
					},
					{
						name: 'Execution Progress',
						value: 'execution.progress',
					},
				],

				displayOptions: {
					show: {
						operation: ['sendProgress'],
					},
				},
			},

			// ================================================================
			// NOTIFICATION
			// ================================================================

			{
				displayName: 'Message',
				name: 'notifyContent',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				default: '',
				required: true,

				displayOptions: {
					show: {
						operation: ['notify'],
					},
				},
			},

			// ================================================================
			// N8N HITL APPROVAL OPTIONS
			// ================================================================

			/*
			 * n8n's HITL generator looks specifically for a property
			 * called `approvalOptions`.
			 *
			 * It will preserve this property on jarvisHitlTool.
			 */
			{
				displayName: 'Approval Options',
				name: 'approvalOptions',
				type: 'fixedCollection',

				placeholder: 'Add option',

				default: {},

				options: [
					{
						displayName: 'Values',
						name: 'values',

						values: [
							{
								displayName: 'Type of Approval',
								name: 'approvalType',
								type: 'options',

								default: 'double',

								options: [
									{
										name: 'Approve Only',
										value: 'single',
									},
									{
										name: 'Approve and Disapprove',
										value: 'double',
									},
								],
							},

							{
								displayName: 'Approve Button Label',
								name: 'approveLabel',
								type: 'string',
								default: 'Approve',

								displayOptions: {
									show: {
										approvalType: ['single', 'double'],
									},
								},
							},

							{
								displayName: 'Disapprove Button Label',
								name: 'disapproveLabel',
								type: 'string',
								default: 'Reject',

								displayOptions: {
									show: {
										approvalType: ['double'],
									},
								},
							},
						],
					},
				],

				displayOptions: {
					show: {
						operation: ['sendAndWait'],
					},
				},
			},

			// ================================================================
			// WAIT SETTINGS
			// ================================================================

			{
				displayName: 'Limit Wait Time',
				name: 'limitWaitTime',
				type: 'boolean',

				default: true,

				description:
					'Whether to give up after a specified amount of time',

				displayOptions: {
					show: {
						operation: ['sendAndWait'],
					},
				},
			},

			{
				displayName: 'Wait For',
				name: 'resumeAmount',
				type: 'number',

				default: 1,

				typeOptions: {
					minValue: 1,
				},

				displayOptions: {
					show: {
						operation: ['sendAndWait'],

						limitWaitTime: [true],
					},
				},
			},

			{
				displayName: 'Unit',
				name: 'resumeUnit',
				type: 'options',

				default: 'hours',

				options: [
					{
						name: 'Minutes',
						value: 'minutes',
					},
					{
						name: 'Hours',
						value: 'hours',
					},
					{
						name: 'Days',
						value: 'days',
					},
				],

				displayOptions: {
					show: {
						operation: ['sendAndWait'],

						limitWaitTime: [true],
					},
				},
			},
		],
	};

	// ======================================================================
	// RESUME WEBHOOK
	// ======================================================================

	async webhook(
		this: IWebhookFunctions,
	): Promise<IWebhookResponseData> {
		const body = (this.getBodyData() ?? {}) as IDataObject;

		/*
		 * The Jarvis Gateway posts something like:
		 *
		 * {
		 *   "approved": true,
		 *   "choice": "approve"
		 * }
		 *
		 * This becomes the result of the waiting node.
		 */
		return {
			webhookResponse: {
				ok: true,
			},

			workflowData: [
				[
					{
						json: body,
					},
				],
			],
		};
	}

	// ======================================================================
	// EXECUTE
	// ======================================================================

	async execute(
		this: IExecuteFunctions,
	): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();

		const operation = this.getNodeParameter(
			'operation',
			0,
		) as string;

		// ------------------------------------------------------------------
		// Gateway endpoint
		// ------------------------------------------------------------------

		const pushUrl = await getPushUrl(this);

		// ==================================================================
		// SEND AND WAIT
		//
		// This is the operation that causes n8n to generate:
		//
		//     jarvisHitlTool
		//
		// ==================================================================

		if (operation === 'sendAndWait') {
			const sessionId = requireSession(
				this,
				this.getNodeParameter('sessionId', 0),
				0,
			);

			/*
			 * IMPORTANT:
			 *
			 * The generated HITL node provides this property.
			 *
			 * It normally contains:
			 *
			 * "The agent wants to use {{ $tool.name }}"
			 *
			 * plus the actual $tool.parameters.
			 */
			const message = this.getNodeParameter(
				'message',
				0,
			) as string;

			// --------------------------------------------------------------
			// Approval options
			// --------------------------------------------------------------

			const approvalOptions =
				this.getNodeParameter(
					'approvalOptions',
					0,
					{},
				) as ApprovalOptions;

			const approvalValues =
				approvalOptions?.values ?? {};

			const approvalType =
				approvalValues.approvalType ?? 'double';

			const approveLabel =
				approvalValues.approveLabel ??
				'Approve';

			const disapproveLabel =
				approvalValues.disapproveLabel ??
				'Reject';

			const choices = [
				{
					value: 'approve',
					label: approveLabel,
				},

				...(approvalType === 'double'
					? [
							{
								value: 'reject',
								label: disapproveLabel,
							},
						]
					: []),
			];

			// --------------------------------------------------------------
			// Resume URL
			// --------------------------------------------------------------

			const resumeUrl =
				this.evaluateExpression(
					'{{ $execution.resumeUrl }}',
					0,
				) as string;

			/*
			 * Makes the n8n editor show the node as waiting.
			 */
			this.setMetadata({
				resumeUrl,
			});

			// --------------------------------------------------------------
			// Send approval request to Jarvis
			// --------------------------------------------------------------

			await pushEvent(this, pushUrl, {
				sessionId,

				event: 'approval.request',

				resumeUrl,

				content: message,

				data: {
					inputType: 'choice',

					choices,

					/*
					 * Useful for your Jarvis UI.
					 */
					approvalType,

					toolName: this.evaluateExpression('{{ $tool.name }}', 0),

					toolParameters: this.evaluateExpression(
						'{{ JSON.stringify($tool.parameters) }}',
						0,
					),
				},
			});

			// --------------------------------------------------------------
			// Wait
			// --------------------------------------------------------------

			let waitTill = WAIT_INDEFINITELY;

			if (
				this.getNodeParameter(
					'limitWaitTime',
					0,
					true,
				) as boolean
			) {
				const amount =
					this.getNodeParameter(
						'resumeAmount',
						0,
						1,
					) as number;

				const unit =
					this.getNodeParameter(
						'resumeUnit',
						0,
						'hours',
					) as string;

				const perUnit: Record<
					string,
					number
				> = {
					minutes: 60_000,
					hours: 3_600_000,
					days: 86_400_000,
				};

				waitTill = new Date(
					Date.now() +
						amount *
							(perUnit[unit] ??
								perUnit.hours),
				);
			}

			await this.putExecutionToWait(waitTill);

			/*
			 * When the Jarvis Gateway calls resumeUrl,
			 * n8n resumes through webhook().
			 */
			return [items];
		}

		// ==================================================================
		// NORMAL NOTIFICATION / PROGRESS
		// ==================================================================

		const results: INodeExecutionData[] = [];

		for (
			let i = 0;
			i < items.length;
			i++
		) {
			const sessionId = requireSession(
				this,
				this.getNodeParameter('sessionId', i),
				i,
			);

			let content = '';

			let event = 'notification';

			if (operation === 'notify') {
				content =
					this.getNodeParameter(
						'notifyContent',
						i,
					) as string;

				event = 'notification';
			} else {
				content =
					this.getNodeParameter(
						'content',
						i,
					) as string;

				event =
					this.getNodeParameter(
						'event',
						i,
						'tool.started',
					) as string;
			}

			try {
				const response = (await pushEvent(this, pushUrl, {
					sessionId,
					event,
					content,
				})) as IDataObject;

				results.push({
					json: response,

					pairedItem: {
						item: i,
					},
				});
			} catch (error) {
				if (this.continueOnFail()) {
					results.push({
						json: {
							error: (
								error as Error
							).message,
						},

						pairedItem: {
							item: i,
						},
					});

					continue;
				}

				throw error;
			}
		}

		return [results];
	}
}
