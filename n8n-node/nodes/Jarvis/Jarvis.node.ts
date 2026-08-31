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

/** Shape of a choice row in the Choices fixedCollection. */
interface ChoiceRow {
	value: string;
	label: string;
}

export class Jarvis implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Jarvis',
		name: 'jarvis',
		icon: 'file:jarvis.svg',
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Send progress, notifications and approval requests to the Jarvis chat app',
		defaults: { name: 'Jarvis' },
		// String literals rather than the NodeConnectionType enum, which was
		// renamed across n8n versions; the literals are accepted by both.
		inputs: ['main'] as INodeTypeDescription['inputs'],
		outputs: ['main'] as INodeTypeDescription['outputs'],
		credentials: [{ name: 'jarvisGatewayApi', required: true }],
		// `restartWebhook` marks this as a resume webhook: n8n exposes it as
		// $execution.resumeUrl while the execution is parked.
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
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'sendProgress',
				options: [
					{
						name: 'Ask for Approval',
						value: 'askApproval',
						description: 'Pause the workflow until the user answers in the Jarvis app',
						action: 'Ask for approval',
					},
					{
						name: 'Ask a Question',
						value: 'askQuestion',
						description: 'Pause and ask the user to type an answer',
						action: 'Ask a question',
					},
					{
						name: 'Send Notification',
						value: 'notify',
						description: 'Post a chat message, even with nothing in flight',
						action: 'Send a notification',
					},
					{
						name: 'Send Progress',
						value: 'sendProgress',
						description: 'Show a transient status line while Jarvis works',
						action: 'Send progress',
					},
				],
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '={{ $json.sessionId }}',
				required: true,
				description: 'Conversation to deliver to. Every device in it receives the event.',
			},

			// --- send progress -------------------------------------------------
			{
				displayName: 'Status',
				name: 'content',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'Searching your email…',
				description: 'Replaces the previous status line, and clears when the reply arrives',
				displayOptions: { show: { operation: ['sendProgress'] } },
			},
			{
				displayName: 'Stage',
				name: 'event',
				type: 'options',
				default: 'tool.started',
				options: [
					{ name: 'Tool Started', value: 'tool.started' },
					{ name: 'Tool Progress', value: 'tool.progress' },
					{ name: 'Tool Finished', value: 'tool.finished' },
					{ name: 'Execution Progress', value: 'execution.progress' },
				],
				displayOptions: { show: { operation: ['sendProgress'] } },
			},

			// --- notify --------------------------------------------------------
			{
				displayName: 'Message',
				name: 'content',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				description: 'Posted as a chat bubble. Works with no message in flight.',
				displayOptions: { show: { operation: ['notify'] } },
			},

			// --- ask for approval ----------------------------------------------
			{
				displayName: 'Question',
				name: 'content',
				type: 'string',
				typeOptions: { rows: 2 },
				default: '',
				required: true,
				placeholder: 'Send the follow-up email to the client?',
				displayOptions: { show: { operation: ['askApproval'] } },
			},
			{
				displayName: 'Question',
				name: 'content',
				type: 'string',
				typeOptions: { rows: 2 },
				default: '',
				required: true,
				placeholder: 'Which repository should I open the PR against?',
				displayOptions: { show: { operation: ['askQuestion'] } },
			},
			{
				displayName: 'Placeholder',
				name: 'placeholder',
				type: 'string',
				default: '',
				placeholder: 'owner/repo',
				description: 'Hint text shown in the answer box',
				displayOptions: { show: { operation: ['askQuestion'] } },
			},
			{
				displayName: 'Choices',
				name: 'choices',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				default: {},
				placeholder: 'Add Choice',
				description: 'Buttons shown in the app. Leave empty for Approve and Reject.',
				displayOptions: { show: { operation: ['askApproval'] } },
				options: [
					{
						name: 'choice',
						displayName: 'Choice',
						values: [
							{
								displayName: 'Label',
								name: 'label',
								type: 'string',
								default: '',
								placeholder: 'Send it',
								description: 'Text on the button',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								placeholder: 'approve',
								description:
									'Returned as `choice`. Use `approve` to have the button highlighted and set `approved` to true.',
							},
						],
					},
				],
			},
			{
				displayName: 'Limit Wait Time',
				name: 'limitWaitTime',
				type: 'boolean',
				default: true,
				description:
					'Whether to give up after a while. Without this the execution stays parked indefinitely.',
				displayOptions: { show: { operation: ['askApproval', 'askQuestion'] } },
			},
			{
				displayName: 'Wait For',
				name: 'resumeAmount',
				type: 'number',
				default: 1,
				typeOptions: { minValue: 1 },
				displayOptions: { show: { operation: ['askApproval', 'askQuestion'], limitWaitTime: [true] } },
			},
			{
				displayName: 'Unit',
				name: 'resumeUnit',
				type: 'options',
				default: 'hours',
				options: [
					{ name: 'Minutes', value: 'minutes' },
					{ name: 'Hours', value: 'hours' },
					{ name: 'Days', value: 'days' },
				],
				displayOptions: { show: { operation: ['askApproval', 'askQuestion'], limitWaitTime: [true] } },
			},
		],
	};

	/**
	 * The gateway POSTs the user's decision here, which resumes the parked
	 * execution. Only one output is declared on purpose: n8n fires only the
	 * first output of a webhook-wait node, so branching is done downstream with
	 * an IF on `approved` (see n8n-io/n8n#12823).
	 */
	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = (this.getBodyData() ?? {}) as IDataObject;
		return {
			webhookResponse: { ok: true },
			workflowData: [[{ json: body }]],
		};
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const operation = this.getNodeParameter('operation', 0) as string;

		const credentials = await this.getCredentials('jarvisGatewayApi');
		const baseUrl = String(credentials.baseUrl ?? '').replace(/\/+$/, '');
		if (!baseUrl) {
			throw new NodeOperationError(this.getNode(), 'The Jarvis Gateway credential has no URL');
		}
		const pushUrl = `${baseUrl}/api/push`;

		// An empty sessionId reaches the gateway as a bare 400, which says nothing
		// about the cause. The usual reason is reading $json.sessionId at a point
		// where $json is something else - a data-table row exposes session_id, not
		// sessionId - so name that rather than let the HTTP error surface.
		const requireSession = (value: unknown, itemIndex: number): string => {
			const sessionId = typeof value === 'string' ? value.trim() : '';
			if (!sessionId) {
				throw new NodeOperationError(
					this.getNode(),
					'Session ID is empty, so the gateway cannot tell which conversation to deliver to',
					{
						itemIndex,
						description:
							"The expression resolved to nothing. Inside a sub-workflow read it from the trigger, e.g. {{ $('When Executed by Main Agent').first().json.sessionId }}. Note a data-table row exposes `session_id`, not `sessionId`.",
					},
				);
			}
			return sessionId;
		};

		// ---- approval or question: push the prompt, then park the execution --
		if (operation === 'askApproval' || operation === 'askQuestion') {
			const asksForText = operation === 'askQuestion';
			const sessionId = requireSession(this.getNodeParameter('sessionId', 0), 0);
			const content = this.getNodeParameter('content', 0) as string;
			const rows = asksForText ? [] : (this.getNodeParameter('choices.choice', 0, []) as ChoiceRow[]);

			const choices = rows
				.filter((row) => row.value || row.label)
				.map((row) => ({ value: row.value || row.label, label: row.label || row.value }));

			// The gateway stores this and never sends it to a client.
			const resumeUrl = this.evaluateExpression('{{ $execution.resumeUrl }}', 0) as string;
			// Lets the editor show the "waiting" tooltip, exactly as the Wait node does.
			this.setMetadata({ resumeUrl });

			await this.helpers.httpRequestWithAuthentication.call(this, 'jarvisGatewayApi', {
				method: 'POST',
				url: pushUrl,
				body: {
					sessionId,
					event: 'approval.request',
					resumeUrl,
					content,
					data: asksForText
						? {
								inputType: 'text',
								placeholder: this.getNodeParameter('placeholder', 0, '') as string,
							}
						: { inputType: 'choice', ...(choices.length ? { choices } : {}) },
				},
				json: true,
			});

			let waitTill = WAIT_INDEFINITELY;
			if (this.getNodeParameter('limitWaitTime', 0, true) as boolean) {
				const amount = this.getNodeParameter('resumeAmount', 0, 1) as number;
				const unit = this.getNodeParameter('resumeUnit', 0, 'hours') as string;
				const perUnit: Record<string, number> = {
					minutes: 60_000,
					hours: 3_600_000,
					days: 86_400_000,
				};
				waitTill = new Date(Date.now() + amount * (perUnit[unit] ?? perUnit.hours));
			}

			await this.putExecutionToWait(waitTill);
			// Resuming re-enters through webhook(), whose output replaces this.
			return [items];
		}

		// ---- fire-and-forget pushes, one per item ----------------------------
		const results: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			const sessionId = requireSession(this.getNodeParameter('sessionId', i), i);
			const content = this.getNodeParameter('content', i) as string;
			const event =
				operation === 'notify'
					? 'notification'
					: (this.getNodeParameter('event', i, 'tool.started') as string);

			try {
				const response = (await this.helpers.httpRequestWithAuthentication.call(
					this,
					'jarvisGatewayApi',
					{
						method: 'POST',
						url: pushUrl,
						body: { sessionId, event, content },
						json: true,
					},
				)) as IDataObject;
				results.push({ json: response, pairedItem: { item: i } });
			} catch (error) {
				// A status line that fails to deliver must never break the run.
				if (this.continueOnFail()) {
					results.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw error;
			}
		}

		return [results];
	}
}
