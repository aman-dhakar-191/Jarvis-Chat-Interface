import { SEND_AND_WAIT_OPERATION, type INodeProperties } from 'n8n-workflow';

/**
 * Fields shown only for Send and Wait for Approval.
 *
 * Mirrors `Telegram/hitl/descriptions.ts` upstream: the human-in-the-loop
 * properties live beside the HITL implementation rather than in the node file.
 */
export const humanReviewDescription: INodeProperties[] = [
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
