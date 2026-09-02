import type { INodeProperties } from 'n8n-workflow';

/** Fields shown only for the Send Progress operation. */
export const progressDescription: INodeProperties[] = [
	{
		displayName: 'Status',
		name: 'content',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'Searching your email…',
		description: 'Progress/status message',

		displayOptions: {
			show: { operation: ['sendProgress'] },
		},
	},

	{
		displayName: 'Stage',
		name: 'event',
		type: 'options',
		default: 'tool.started',
		description:
			'Which stage of the run this update reports. The first three replace the status line; Tool Finished clears it.',

		options: [
			{
				name: 'Tool Started',
				value: 'tool.started',
				description: 'A step is beginning. Replaces the status line.',
			},
			{
				name: 'Tool Progress',
				value: 'tool.progress',
				description:
					'A step is still running. Replaces the status line, so send it as often as there is something new to say.',
			},
			{
				name: 'Tool Finished',
				value: 'tool.finished',
				description: 'The step is over. Clears the status line.',
			},
			{
				name: 'Execution Progress',
				value: 'execution.progress',
				description:
					'Progress of the run as a whole rather than one step. Replaces the status line.',
			},
		],

		displayOptions: {
			show: { operation: ['sendProgress'] },
		},
	},
];
