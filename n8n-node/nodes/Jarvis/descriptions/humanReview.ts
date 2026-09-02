import { SEND_AND_WAIT_OPERATION, type INodeProperties } from 'n8n-workflow';

/**
 * Fields shown only for Send and Wait for Approval.
 *
 * Mirrors `Telegram/hitl/descriptions.ts` upstream: the human-in-the-loop
 * properties live beside the HITL implementation rather than in the node file.
 */
export const humanReviewDescription: INodeProperties[] = [
	{
		displayName: 'Approval Decided By',
		name: 'approvalMode',
		type: 'options',
		default: 'agent',

		description:
			'Who decides whether this step needs approval. Fix it yourself for anything consequential: leaving it to the agent means the thing being policed also decides whether policing applies.',

		options: [
			{
				name: 'The Agent',
				value: 'agent',
				description: 'The model decides per call, from what it is about to do',
			},
			{
				name: 'Always Ask',
				value: 'always',
				description: 'Every call waits for the user to approve',
			},
			{
				name: 'Never Ask, Just Inform',
				value: 'never',
				description: 'Every call tells the user what is happening and continues',
			},
		],

		displayOptions: {
			show: { operation: [SEND_AND_WAIT_OPERATION] },
		},
	},

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

		default:
			"={{ $fromAI('approvalRequired', 'Whether this step needs the user to approve it before it happens. Use false to simply tell the user what you are doing when the step only reads or looks something up, such as searching the web or reading emails. Use true when the step changes, sends, deletes or spends something, such as sending an email or a message.', 'boolean') }}",

		description:
			'Whether to wait for the user to approve. When false the node only tells the user what is happening and continues immediately. Left as is, the agent decides per call.',

		displayOptions: {
			show: {
				operation: [SEND_AND_WAIT_OPERATION],
				approvalMode: ['agent'],
			},
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

	/*
	 * Shown to the user alongside the message. Both default to the expressions
	 * the generated HITL tool resolves; when the tool strips them, execute()
	 * falls back to evaluating the same expressions directly.
	 */
	{
		displayName: 'Tool Name',
		name: 'toolName',
		type: 'string',
		default: '={{ $tool.name }}',
		description:
			'Name of the tool the agent is asking to run. Leave as is to take it from the agent.',

		displayOptions: {
			show: { operation: [SEND_AND_WAIT_OPERATION] },
		},
	},

	{
		displayName: 'Tool Parameters',
		name: 'toolParameters',
		type: 'string',
		default: '={{ JSON.stringify($tool.parameters) }}',
		description:
			'Parameters the agent wants to call the tool with. Leave as is to take them from the agent.',

		displayOptions: {
			show: { operation: [SEND_AND_WAIT_OPERATION] },
		},
	},
];
