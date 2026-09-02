import type { INodeProperties } from 'n8n-workflow';

/** Fields shown only for the Send Notification operation. */
export const notificationDescription: INodeProperties[] = [
	{
		displayName: 'Message',
		name: 'notifyContent',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '',
		required: true,
		description: 'Text shown to the user in the Jarvis chat app',

		displayOptions: {
			show: { operation: ['notify'] },
		},
	},
];
