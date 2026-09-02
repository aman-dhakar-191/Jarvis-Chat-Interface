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
		description: 'Which stage of the run this update reports',

		options: [
			{ name: 'Tool Started', value: 'tool.started' },
			{ name: 'Tool Progress', value: 'tool.progress' },
			{ name: 'Tool Finished', value: 'tool.finished' },
			{ name: 'Execution Progress', value: 'execution.progress' },
		],

		displayOptions: {
			show: { operation: ['sendProgress'] },
		},
	},
];
