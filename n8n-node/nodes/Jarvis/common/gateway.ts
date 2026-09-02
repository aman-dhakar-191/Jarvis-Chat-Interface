import { NodeOperationError, type IDataObject, type IExecuteFunctions } from 'n8n-workflow';

/**
 * The credential every Jarvis action node authenticates with. It carries the
 * gateway URL and the push secret, and sends the secret as `x-gateway-secret`
 * - never repeat that header here, and never read the secret into a node
 * parameter.
 */
export const JARVIS_CREDENTIAL = 'jarvisGatewayApi';

/**
 * Resolves the single endpoint every action node talks to: POST /api/push.
 * Read once per execution rather than per item.
 */
export async function getPushUrl(ctx: IExecuteFunctions): Promise<string> {
	const credentials = await ctx.getCredentials(JARVIS_CREDENTIAL);
	const baseUrl = String(credentials.baseUrl ?? '').replace(/\/+$/, '');

	if (!baseUrl) {
		throw new NodeOperationError(ctx.getNode(), 'The Jarvis Gateway credential has no URL');
	}

	return `${baseUrl}/api/push`;
}

/** Posts one event to the gateway with the credential's authentication applied. */
export async function pushEvent(
	ctx: IExecuteFunctions,
	pushUrl: string,
	body: IDataObject,
): Promise<IDataObject> {
	return (await ctx.helpers.httpRequestWithAuthentication.call(ctx, JARVIS_CREDENTIAL, {
		method: 'POST',
		url: pushUrl,
		body,
		json: true,
	})) as IDataObject;
}
