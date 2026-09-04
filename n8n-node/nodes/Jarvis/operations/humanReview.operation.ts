import {
	NodeOperationError,
	WAIT_INDEFINITELY,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';

import { pushEvent } from '../common/gateway';
import {
	HITL_CONTRACT_HINT,
	inspectToolParameters,
	normalizeToolArguments,
	readToolIdentity,
	requireSession,
} from '../common/helpers';
import type { ApprovalChoice, ApprovalOptions } from '../common/types';

/**
 * The shape n8n's own sendAndWait nodes answer with:
 *
 *     { json: { data: { approved, respondedAt } } }
 *
 * The HITL engine runs the gated tool only when it reads an approval back, so
 * an answer without `approved` silently ends the agent's call - the tool is
 * simply never run.
 *
 * The fields are also copied flat because workflows branch on
 * `{{ $json.approved }}`, which is what this node has always emitted and what
 * the README documents.
 */
function approvalResult(fields: IDataObject): IDataObject {
	return { ...fields, data: { ...fields } };
}

/**
 * `$tool` only resolves inside a tool call. A hand-wired node has no tool
 * context, and asking for one there throws rather than answering nothing - so
 * an unresolvable expression reads as absent, which is what it means.
 */
function evaluate(ctx: IExecuteFunctions, expression: string): unknown {
	try {
		return ctx.evaluateExpression(expression, 0);
	} catch {
		return undefined;
	}
}

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

	/*
	 * Read from the agent's tool context. Sent as data rather than written into
	 * the message, so the client can label it as its own element instead of the
	 * model having to remember to prefix the text with a tool name.
	 */
	/*
	 * Read as a parameter: $tool is in scope when n8n resolves this node's
	 * parameters for a tool call, but not for evaluateExpression() here. The
	 * expression fallback covers a hand-wired node, where neither resolves and
	 * the label is simply absent.
	 */
	let declaredToolName: unknown = '';

	try {
		declaredToolName = this.getNodeParameter('toolName', 0, '');
	} catch {
		// The default is an expression over $tool, which a hand-wired node
		// cannot resolve. No tool context is not a failure, just no tool.
		declaredToolName = '';
	}

	const toolNameValue = declaredToolName || evaluate(this, '{{ $tool.name }}');

	const identity = readToolIdentity(toolNameValue);

	if (identity.invalid) {
		throw new NodeOperationError(
			this.getNode(),
			`Invalid HITL tool call: ${identity.invalid}.`,
			{ description: HITL_CONTRACT_HINT },
		);
	}

	const toolLabel = identity.name ?? '';

	// ------------------------------------------------------------------
	// The gated tool's own arguments
	// ------------------------------------------------------------------

	/*
	 * Never declared as node parameters. A property named `toolParameters`
	 * collides with the key n8n uses when it merges the gated tool's arguments
	 * into the HITL call: the model's arguments land in this node's display
	 * field instead of reaching the gated tool, which then runs with nothing.
	 * Seen live as Web Search failing with "Missing parameter query" while
	 * search_query sat on this node's input.
	 */
	const rawToolParameters = evaluate(this, '{{ JSON.stringify($tool.parameters) }}');

	/*
	 * Fail closed, but only where the contract applies. A tool name means this
	 * run came through the generated HITL wrapper, so the wrapper's schema is
	 * what the model was given and a call that does not match it is a mistake
	 * to report - not one to guess at. A hand-wired node has no tool context at
	 * all and keeps behaving as it always has.
	 *
	 * The check sits before the informational branch on purpose: that branch
	 * answers `approved: true`, and n8n runs the gated tool on that answer.
	 */
	if (toolLabel) {
		const check = inspectToolParameters(rawToolParameters);

		if (check.status !== 'ok') {
			throw new NodeOperationError(
				this.getNode(),
				`Invalid HITL tool call for ${toolLabel}: ${check.reason}.`,
				{ description: HITL_CONTRACT_HINT },
			);
		}
	}

	const toolParameters = normalizeToolArguments(rawToolParameters);

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
		const answer = this.getNodeParameter('approvalRequired', 0, true);

		/*
		 * Only an explicit yes asks. n8n renders an empty stored value - left
		 * behind by the old expression default - as a toggle in the off
		 * position, so anything that is not a real true must behave as off.
		 * Contradicting the toggle the user is looking at is its own bug.
		 */
		approvalRequired = answer === true || answer === 'true';
	} catch {
		approvalRequired = true;
	}

	if (!approvalRequired) {
		/*
		 * Nothing to approve: tell the user what is happening and let the agent
		 * carry on. No resume URL, no parked execution, so the gateway sees an
		 * ordinary notification.
		 */
		const informational: IDataObject = {
			sessionId,
			event: 'notification',
			content: message,
		};

		// Only when there is one: outside a tool context there is no tool to name.
		if (toolLabel) informational.data = { toolName: toolLabel };

		const response = await pushEvent(this, pushUrl, informational);

		/*
		 * `approved: true` is the whole point: the agent asked whether it may
		 * proceed, the answer was that it did not need to ask, so it proceeds.
		 * Returning the gateway's own {ok, delivered} instead carries no
		 * approval, and the gated tool never runs.
		 */
		/*
		 * Only claim a paired item when one actually arrived. Under an agent this
		 * operation can run with no input items, and pointing at item 0 of an
		 * empty input leaves a dangling link that breaks `.item` lookups
		 * elsewhere - which surfaces as "Can't get data for expression".
		 */
		const informed: INodeExecutionData = {
			json: approvalResult({
				approved: true,
				informed: true,
				delivered: response.delivered ?? null,
				respondedAt: new Date().toISOString(),
			}),
		};

		if (items.length > 0) {
			informed.pairedItem = { item: 0 };
		}

		return [[informed]];
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
			toolName: toolLabel,
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
		workflowData: [[{ json: approvalResult(body) }]],
	};
}
