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

import { getPushUrl, pushEvent } from '../common/gateway';
import { requireSession } from '../common/helpers';
import type { ApprovalChoice, ApprovalOptions } from '../common/types';

const MS_PER_UNIT: Record<string, number> = {
	minutes: 60_000,
	hours: 3_600_000,
	days: 86_400_000,
};

/**
 * Human-in-the-loop approval.
 *
 * This node parks the execution and is resumed by the gateway, so it is a
 * normal `main` node with a restart webhook - NOT a trigger. The flow is:
 *
 *     AI Agent -> this node -> approval.request -> execution waits
 *       -> user answers in Jarvis -> gateway POSTs the resume URL
 *       -> webhook() -> execution resumes -> AI Agent continues
 */
export class JarvisHumanReview implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Jarvis Human Review',
		name: 'jarvisHumanReview',
		icon: 'file:../jarvis.svg',
		group: ['output'],
		version: 1,
		description: 'Request human approval through the Jarvis chat app and pause until the user answers',
		defaults: { name: 'Jarvis Human Review' },

		/*
		 * IMPORTANT:
		 *
		 * Keep this as a normal `main` node. n8n itself generates
		 *
		 *     jarvisHumanReviewHitlTool
		 *
		 * from the `sendAndWait` operation declared below, and that generated
		 * node is what the AI Agent connects to as ai_tool. Turning this into a
		 * tool node by hand would break that.
		 */
		inputs: ['main'] as INodeTypeDescription['inputs'],
		outputs: ['main'] as INodeTypeDescription['outputs'],

		credentials: [{ name: 'jarvisGatewayApi', required: true }],

		/*
		 * Resume webhook. While the execution is parked n8n exposes it as
		 * $execution.resumeUrl; restartWebhook makes it resume this execution
		 * instead of starting a new one.
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
			/*
			 * DO NOT REMOVE.
			 *
			 * n8n scans node descriptions for an `operation` option whose value
			 * is exactly `sendAndWait` and only then generates the Human-in-the-
			 * Loop tool variant of the node. Without this single-option field
			 * the node still works when wired by hand, but the AI Agent can no
			 * longer use it for tool approval.
			 */
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'sendAndWait',
				options: [
					{
						name: 'Send and Wait for Approval',
						value: 'sendAndWait',
						description: 'Request approval and pause the execution until the user responds',
						action: 'Send and wait for approval',
					},
				],
			},

			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '={{ $json.sessionId }}',
				required: true,
				description: 'Jarvis conversation/session that should receive the approval request',
			},

			/*
			 * The generated HITL tool replaces this property with its own
			 * HITL-aware Message property, which can reference $tool.name and
			 * $tool.parameters.
			 */
			{
				displayName: 'Message',
				name: 'message',
				type: 'string',
				default:
					'=The agent wants to use {{ $tool.name }}\\n\\nInput:\\n{{ JSON.stringify($tool.parameters, null, 2) }}',
				required: true,
				typeOptions: { rows: 4 },
				description: 'Message shown to the user before the tool is executed',
			},

			/*
			 * n8n's HITL generator looks specifically for a property called
			 * `approvalOptions` and preserves it on the generated tool.
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
									{ name: 'Approve Only', value: 'single' },
									{ name: 'Approve and Disapprove', value: 'double' },
								],
							},
							{
								displayName: 'Approve Button Label',
								name: 'approveLabel',
								type: 'string',
								default: 'Approve',
								displayOptions: { show: { approvalType: ['single', 'double'] } },
							},
							{
								displayName: 'Disapprove Button Label',
								name: 'disapproveLabel',
								type: 'string',
								default: 'Reject',
								displayOptions: { show: { approvalType: ['double'] } },
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
				description: 'Whether to give up after a specified amount of time',
			},
			{
				displayName: 'Wait For',
				name: 'resumeAmount',
				type: 'number',
				default: 1,
				typeOptions: { minValue: 1 },
				displayOptions: { show: { limitWaitTime: [true] } },
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
				displayOptions: { show: { limitWaitTime: [true] } },
			},

			/*
			 * Shown to the user alongside the message. Both default to the
			 * expressions the generated HITL tool resolves; when the tool
			 * strips them, execute() falls back to evaluating the same
			 * expressions directly, which is what this node always did.
			 */
			{
				displayName: 'Tool Name',
				name: 'toolName',
				type: 'string',
				default: '={{ $tool.name }}',
				description: 'Name of the tool the agent is asking to run. Leave as is to take it from the agent.',
			},
			{
				displayName: 'Tool Parameters',
				name: 'toolParameters',
				type: 'string',
				default: '={{ JSON.stringify($tool.parameters) }}',
				description:
					'Parameters the agent wants to call the tool with. Leave as is to take them from the agent.',
			},
		],
	};

	// ======================================================================
	// RESUME WEBHOOK
	// ======================================================================

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = (this.getBodyData() ?? {}) as IDataObject;

		/*
		 * The gateway posts the settled approval:
		 *
		 *   { approvalId, choice, approved, answer, comment, userId,
		 *     sessionId, respondedAt }
		 *
		 * which becomes the output of this node when the execution resumes.
		 */
		return {
			webhookResponse: { ok: true },
			workflowData: [[{ json: body }]],
		};
	}

	// ======================================================================
	// EXECUTE
	// ======================================================================

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const pushUrl = await getPushUrl(this);

		const sessionId = requireSession(this, this.getNodeParameter('sessionId', 0), 0);
		const message = this.getNodeParameter('message', 0) as string;

		// ------------------------------------------------------------------
		// Approval options
		// ------------------------------------------------------------------

		const approvalOptions = this.getNodeParameter('approvalOptions', 0, {}) as ApprovalOptions;
		const approvalValues = approvalOptions?.values ?? {};
		const approvalType = approvalValues.approvalType ?? 'double';
		const approveLabel = approvalValues.approveLabel ?? 'Approve';
		const disapproveLabel = approvalValues.disapproveLabel ?? 'Reject';

		const choices: ApprovalChoice[] = [
			{ value: 'approve', label: approveLabel },
			...(approvalType === 'double'
				? [{ value: 'reject' as const, label: disapproveLabel }]
				: []),
		];

		// ------------------------------------------------------------------
		// Resume URL
		// ------------------------------------------------------------------

		const resumeUrl = this.evaluateExpression('{{ $execution.resumeUrl }}', 0) as string;

		// Makes the n8n editor show the node as waiting.
		this.setMetadata({ resumeUrl });

		// The generated HITL tool may not carry these properties; fall back to
		// the agent's own tool context, exactly as before the split.
		const toolName =
			(this.getNodeParameter('toolName', 0, '') as string) ||
			this.evaluateExpression('{{ $tool.name }}', 0);

		const toolParameters =
			(this.getNodeParameter('toolParameters', 0, '') as string) ||
			this.evaluateExpression('{{ JSON.stringify($tool.parameters) }}', 0);

		// ------------------------------------------------------------------
		// Send the approval request to Jarvis
		// ------------------------------------------------------------------

		await pushEvent(this, pushUrl, {
			sessionId,
			event: 'approval.request',
			resumeUrl,
			content: message,
			data: {
				inputType: 'choice',
				choices,
				approvalType,
				toolName,
				toolParameters,
			},
		});

		// ------------------------------------------------------------------
		// Wait
		// ------------------------------------------------------------------

		let waitTill = WAIT_INDEFINITELY;

		if (this.getNodeParameter('limitWaitTime', 0, true) as boolean) {
			const amount = this.getNodeParameter('resumeAmount', 0, 1) as number;
			const unit = this.getNodeParameter('resumeUnit', 0, 'hours') as string;

			waitTill = new Date(Date.now() + amount * (MS_PER_UNIT[unit] ?? MS_PER_UNIT.hours));
		}

		await this.putExecutionToWait(waitTill);

		/*
		 * When the gateway calls resumeUrl, n8n resumes through webhook() and
		 * the approval response replaces these items.
		 */
		return [items];
	}
}
