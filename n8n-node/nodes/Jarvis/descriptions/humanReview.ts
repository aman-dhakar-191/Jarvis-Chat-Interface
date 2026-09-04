import { SEND_AND_WAIT_OPERATION, type INodeProperties } from 'n8n-workflow';

/**
 * Fields shown only for Send and Wait for Approval.
 *
 * Mirrors `Telegram/hitl/descriptions.ts` upstream: the human-in-the-loop
 * properties live beside the HITL implementation rather than in the node file.
 */
export const humanReviewDescription: INodeProperties[] = [
	/*
	 * What the agent is asking for, decided per call rather than configured
	 * once on the node.
	 *
	 * `$fromAI` makes the LLM fill this in when it invokes the tool, so one
	 * Human Review tool covers both jobs: telling the user what it is about to
	 * do (reading mail, searching the web - nothing to approve) and asking
	 * permission for something consequential (sending that mail).
	 *
	 * The description is the prompt the model actually sees, so it is written
	 * for the model, not for the node's UI.
	 */
	{
		displayName: 'Approval Required',
		name: 'approvalRequired',
		type: 'boolean',

		/*
		 * A real boolean, not an expression. It was previously defaulted to a
		 * `$fromAI()` string, which left the stored value as '' once the
		 * override was removed - and n8n renders '' as a toggle in the off
		 * position while the value is not actually `false`. A node whose
		 * behaviour disagrees with the toggle the user is looking at is worse
		 * than either behaviour on its own.
		 *
		 * On by default because this operation exists to ask. Turn it off to
		 * only inform, or use the sparkle override to let the agent decide per
		 * call - that override is n8n's own, and carries its own description
		 * for the model.
		 */
		default: true,

		description:
			'Whether to wait for the user to approve. Turn off to simply tell the user what is happening and continue - right for a step that only reads or looks something up. Use the sparkle override to let the agent decide per call, describing to it that false is for read-only steps and true for anything that changes, sends, deletes or spends.',

		displayOptions: {
			show: { operation: [SEND_AND_WAIT_OPERATION] },
		},
	},

	/*
	 * The tool the agent is asking about, sent as data so the client can label
	 * the message with it.
	 *
	 * It must be a PARAMETER, not an evaluateExpression() call in execute():
	 * n8n injects $tool when it resolves a node's parameters for a tool call,
	 * and reading it from code instead yields nothing.
	 *
	 * There is deliberately no `toolParameters` and no `tool` counterpart.
	 * Those are the keys n8n merges the gated tool's own call into
	 * (`createEngineRequests` builds `{ tool, ...hitlParameters,
	 * toolParameters }`), so declaring either captures them here and the gated
	 * tool then runs with nothing. `toolName` is not one of the keys n8n
	 * merges, so it is safe - if a future version adds one, this has to go the
	 * same way.
	 */
	{
		displayName: 'Tool Name',
		name: 'toolName',
		type: 'string',
		default: '={{ $tool.name }}',
		description: 'Name of the tool the agent is asking about. Leave as is to take it from the agent.',

		displayOptions: {
			show: { operation: [SEND_AND_WAIT_OPERATION] },
		},
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

		displayOptions: {
			show: { operation: [SEND_AND_WAIT_OPERATION] },
		},
	},

	{
		displayName: 'Limit Wait Time',
		name: 'limitWaitTime',
		type: 'boolean',
		default: true,
		description: 'Whether to give up after a specified amount of time',

		displayOptions: {
			show: { operation: [SEND_AND_WAIT_OPERATION] },
		},
	},

	{
		displayName: 'Wait For',
		name: 'resumeAmount',
		type: 'number',
		default: 1,
		typeOptions: { minValue: 1 },

		displayOptions: {
			show: {
				operation: [SEND_AND_WAIT_OPERATION],
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
			{ name: 'Minutes', value: 'minutes' },
			{ name: 'Hours', value: 'hours' },
			{ name: 'Days', value: 'days' },
		],

		displayOptions: {
			show: {
				operation: [SEND_AND_WAIT_OPERATION],
				limitWaitTime: [true],
			},
		},
	},

];

