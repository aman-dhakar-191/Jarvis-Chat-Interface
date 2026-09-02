import {
	NodeOperationError,
	WAIT_INDEFINITELY,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';

interface ApprovalOptions {
	values?: {
		approvalType?: 'single' | 'double';
		approveLabel?: string;
		disapproveLabel?: string;
	};
}

export class Jarvis implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Jarvis',
		name: 'jarvis',
		icon: 'file:jarvis.svg',
		group: ['output'],
		version: 1,

		subtitle: '={{$parameter["operation"]}}',

		description:
			'Send notifications and request human approval through the Jarvis chat app',

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

					/*
					 * Keep your old operation if you still want to use
					 * the Jarvis node directly in normal workflows.
					 */
					/*
{
						name: 'Ask for Approval',
						value: 'LEGACY_ASK_APPROVAL',
						description:
							'Pause the workflow until the user answers in Jarvis',
						action: 'Ask for approval',
					},
*/

					/*
{
						name: 'Ask a Question',
						value: 'LEGACY_ASK_QUESTION',
						description:
							'Pause the workflow and ask the user for text',
						action: 'Ask a question',
					},
*/
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
		// Gateway credentials
		// ------------------------------------------------------------------

		const credentials = await this.getCredentials(
			'jarvisGatewayApi',
		);

		const baseUrl = String(
			credentials.baseUrl ?? '',
		).replace(/\/+$/, '');

		if (!baseUrl) {
			throw new NodeOperationError(
				this.getNode(),
				'The Jarvis Gateway credential has no URL',
			);
		}

		const pushUrl = `${baseUrl}/api/push`;

		// ------------------------------------------------------------------
		// Session helper
		// ------------------------------------------------------------------

		const requireSession = (
			value: unknown,
			itemIndex: number,
		): string => {
			const sessionId =
				typeof value === 'string'
					? value.trim()
					: '';

			if (!sessionId) {
				throw new NodeOperationError(
					this.getNode(),

					'Session ID is empty, so the gateway cannot determine which Jarvis conversation should receive the event',

					{
						itemIndex,

						description:
							'Make sure the Jarvis sessionId is available. For sub-workflows use the sessionId supplied by the parent agent.',
					},
				);
			}

			return sessionId;
		};

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

			await this.helpers.httpRequestWithAuthentication.call(
				this,
				'jarvisGatewayApi',
				{
					method: 'POST',

					url: pushUrl,

					body: {
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

							toolName: this.evaluateExpression(
								'{{ $tool.name }}',
								0,
							),

							toolParameters:
								this.evaluateExpression(
									'{{ JSON.stringify($tool.parameters) }}',
									0,
								),
						},
					},

					json: true,
				},
			);

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
				this.getNodeParameter(
					'sessionId',
					i,
				),
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
				const response =
					(await this.helpers.httpRequestWithAuthentication.call(
						this,
						'jarvisGatewayApi',
						{
							method: 'POST',

							url: pushUrl,

							body: {
								sessionId,
								event,
								content,
							},

							json: true,
						},
					)) as IDataObject;

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
