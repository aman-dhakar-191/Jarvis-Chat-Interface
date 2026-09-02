import {
	WAIT_INDEFINITELY,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';

import { pushEvent } from '../common/gateway';
import { requireSession } from '../common/helpers';
import type { ApprovalChoice, ApprovalOptions } from '../common/types';

const MS_PER_UNIT: Record<string, number> = {
	minutes: 60_000,
	hours: 3_600_000,
	days: 86_400_000,
};

/**
 * Send and Wait for Approval - the human-in-the-loop operation.
 *
 * Unlike the other two operations this one owns the whole execution: it parks
 * it and is resumed by the gateway, so it takes no item index and returns the
 * node's full output. The flow is:
 *
 *     AI Agent -> this operation -> approval.request -> execution waits
 *       -> user answers in Jarvis -> gateway POSTs the resume URL
 *       -> webhook() -> execution resumes -> AI Agent continues
 */
export async function execute(
	this: IExecuteFunctions,
	pushUrl: string,
): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();

	const sessionId = requireSession(this, this.getNodeParameter('sessionId', 0), 0);

	/*
	 * The generated HITL node provides this property. It normally contains
	 * "The agent wants to use {{ $tool.name }}" plus the actual $tool.parameters.
	 */
	const message = this.getNodeParameter('message', 0) as string;

	// ------------------------------------------------------------------
	// Inform, or ask?
	// ------------------------------------------------------------------

	/*
	 * Normally answered by the agent through $fromAI. Outside a tool context
	 * that expression cannot resolve and getNodeParameter throws, so fall back
	 * to asking: failing to work out whether something needs approval must
	 * never be the same as deciding it does not.
	 */
	let approvalRequired = true;

	try {
		approvalRequired = this.getNodeParameter('approvalRequired', 0, true) as boolean;
	} catch {
		approvalRequired = true;
	}

	if (!approvalRequired) {
		/*
		 * Nothing to approve: tell the user what is happening and let the agent
		 * carry on. No resume URL, no parked execution, so the gateway sees an
		 * ordinary notification.
		 */
		const response = await pushEvent(this, pushUrl, {
			sessionId,
			event: 'notification',
			content: message,
		});

		return [[{ json: response, pairedItem: { item: 0 } }]];
	}

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
		...(approvalType === 'double' ? [{ value: 'reject' as const, label: disapproveLabel }] : []),
	];

	// ------------------------------------------------------------------
	// Resume URL
	// ------------------------------------------------------------------

	const resumeUrl = this.evaluateExpression('{{ $execution.resumeUrl }}', 0) as string;

	// Makes the n8n editor show the node as waiting.
	this.setMetadata({ resumeUrl });

	// The generated HITL tool may not carry these properties; fall back to the
	// agent's own tool context.
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
	 * When the gateway calls resumeUrl, n8n resumes through webhook() and the
	 * approval response replaces these items.
	 */
	return [items];
}

/**
 * The resume webhook. The gateway posts the settled approval:
 *
 *   { approvalId, choice, approved, answer, comment, userId, sessionId,
 *     respondedAt }
 *
 * which becomes the output of the node when the execution resumes.
 */
export async function webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
	const body = (this.getBodyData() ?? {}) as IDataObject;

	return {
		webhookResponse: { ok: true },
		workflowData: [[{ json: body }]],
	};
}
