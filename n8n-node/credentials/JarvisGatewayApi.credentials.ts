import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class JarvisGatewayApi implements ICredentialType {
	name = 'jarvisGatewayApi';

	displayName = 'Jarvis Gateway API';

	documentationUrl = 'https://github.com/aman-dhakar-191/Jarvis-Chat-Interface';

	properties: INodeProperties[] = [
		{
			displayName: 'Gateway URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			placeholder: 'https://jarvis.example.com',
			required: true,
			description: 'Base URL of the Jarvis Gateway, with no trailing slash',
		},
		{
			displayName: 'Push Secret',
			name: 'pushSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: "The gateway's PUSH_SECRET. Sent as the x-gateway-secret header.",
		},
	];

	// Stored once here instead of being pasted into a header on every HTTP node.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'x-gateway-secret': '={{$credentials.pushSecret}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/$/, "")}}',
			url: '/health',
			method: 'GET',
		},
	};
}
