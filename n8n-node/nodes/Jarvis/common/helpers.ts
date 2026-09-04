import { NodeOperationError, type IDataObject, type IExecuteFunctions } from 'n8n-workflow';

/**
 * Every Jarvis event is addressed to a conversation. An empty session id is a
 * configuration mistake, not an empty result, so fail loudly with the same
 * message from every node rather than pushing an undeliverable event.
 */
export function requireSession(
	ctx: IExecuteFunctions,
	value: unknown,
	itemIndex: number,
): string {
	const sessionId = typeof value === 'string' ? value.trim() : '';

	if (!sessionId) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Session ID is empty, so the gateway cannot determine which Jarvis conversation should receive the event',
			{
				itemIndex,
				description:
					'Make sure the Jarvis sessionId is available. For sub-workflows use the sessionId supplied by the parent agent.',
			},
		);
	}

	return sessionId;
}

/**
 * The arguments a HITL call carries about the gated tool, in one shape.
 *
 * n8n merges the gated tool's arguments into the HITL call, and the shape
 * follows whatever the model emitted - the same tool in the same run has
 * arrived both flat:
 *
 *     { tool, action, command, extra, Message }
 *
 * and wrapped:
 *
 *     { tool, Message, toolParameters: { action, command, extra } }
 *
 * Either way the caller wants the arguments themselves, so a wrapper is folded
 * into the top level. Malformed JSON is reported as text rather than thrown:
 * a status message is not worth failing an approval over.
 *
 * Only the two wrapper keys are known here, and both are n8n's own. Nothing
 * about any particular workflow's field names belongs in this function - it has
 * to hold for whatever a node is wired to.
 */
const WRAPPER_KEYS = ['toolParameters', 'hitlParameters'];

/** How many times a wrapper may be nested before we stop digging. */
const MAX_UNWRAP_DEPTH = 5;

/**
 * The value as a plain object, parsing it first if it arrived as JSON text.
 * Anything that is not an object - an array, a number, unparseable text - has
 * no arguments in it, so it comes back undefined.
 */
function asObject(value: unknown): IDataObject | undefined {
	if (typeof value === 'string') {
		const text = value.trim();
		if (!text) return undefined;

		try {
			// Recursive because a value can arrive encoded more than once.
			return asObject(JSON.parse(text));
		} catch {
			return undefined;
		}
	}

	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

	return value as IDataObject;
}

export function normalizeToolArguments(raw: unknown): IDataObject {
	// Text that is not JSON at all stays visible rather than being dropped.
	if (typeof raw === 'string') {
		const text = raw.trim();
		if (!text) return {};

		try {
			JSON.parse(text);
		} catch {
			return { raw: text };
		}
	}

	const parsed = asObject(raw);
	if (!parsed) return {};

	let args: IDataObject = { ...parsed };

	for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
		let unwrapped = false;

		for (const wrapper of WRAPPER_KEYS) {
			const nested = asObject(args[wrapper]);
			if (!nested) continue;

			/*
			 * Drop the wrapper BEFORE merging its contents. Merging first and
			 * deleting after loses everything when a wrapper is nested inside
			 * itself: the inner object overwrites the key, and the delete then
			 * removes the arguments along with it.
			 */
			const rest: IDataObject = { ...args };
			delete rest[wrapper];

			// The wrapper's own contents win: they are the arguments, and the
			// outer level only carries the call's envelope.
			args = { ...rest, ...nested };
			unwrapped = true;
		}

		if (!unwrapped) break;
	}

	return args;
}

// ---------------------------------------------------------------------------
// The HITL wrapper contract
// ---------------------------------------------------------------------------

/*
 * n8n core - not this node - generates the HITL wrapper. In
 * `n8n-core/.../get-input-connection-data.js` (`createHitlToolkit`) every tool
 * connected to this node is republished under its own name with the schema
 *
 *     z.object({
 *       toolParameters: <the gated tool's own schema>,
 *       hitlParameters: <this node's $fromAI schema, minus toolParameters/tool>,
 *     })
 *
 * and on invocation `createEngineRequests` hands this node
 *
 *     { ...hitlParameters, tool: <tool name>, toolParameters: <the arguments> }
 *
 * which is what `$tool.name` and `$tool.parameters` read. So a call missing
 * `toolParameters` is a model mistake, never a shape this node has to repair:
 * repairing it would send an approval that does not describe what will run, and
 * `processHitlResponses` then executes the gated tool on `approved === true`
 * regardless.
 */

/** What the model is told when its call does not match the wrapper schema. */
export const HITL_CONTRACT_HINT =
	'This tool is an approval wrapper for another tool. Put the underlying tool arguments inside `toolParameters`, and approval settings inside `hitlParameters`. Do not call the underlying tool directly.';

/** n8n's own tool-name rule (`create-node-as-tool.ts`, `handleFromAi`). */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export type ToolParametersCheck =
	| { status: 'ok'; value: IDataObject }
	| { status: 'missing' | 'invalid'; reason: string };

/**
 * Whether `$tool.parameters` carries an argument object for the gated tool.
 *
 * `$tool.parameters` arrives as the JSON text of whatever the model put under
 * `toolParameters`; a key the model never sent resolves to the empty default,
 * which is why an empty string reads as missing rather than as no arguments.
 * An empty object is valid - a gated tool may legitimately take none.
 */
export function inspectToolParameters(raw: unknown): ToolParametersCheck {
	if (raw === undefined || raw === null) {
		return { status: 'missing', reason: '`toolParameters` is required' };
	}

	let value: unknown = raw;

	if (typeof raw === 'string') {
		const text = raw.trim();

		if (!text) {
			return { status: 'missing', reason: '`toolParameters` is required' };
		}

		try {
			value = JSON.parse(text);
		} catch {
			return { status: 'invalid', reason: '`toolParameters` is not valid JSON' };
		}
	}

	if (value === null || value === undefined || value === '') {
		return { status: 'missing', reason: '`toolParameters` is required' };
	}

	if (typeof value !== 'object' || Array.isArray(value)) {
		return {
			status: 'invalid',
			reason: `\`toolParameters\` must be an object, received ${Array.isArray(value) ? 'array' : typeof value}`,
		};
	}

	return { status: 'ok', value: value as IDataObject };
}

/**
 * The tool this call is about, or undefined when there is none.
 *
 * Anything that is not a syntactically valid n8n tool name is refused rather
 * than passed on: an approval has to name the tool it is approving, and a name
 * this node cannot vouch for is not one.
 */
export function readToolIdentity(value: unknown): { name?: string; invalid?: string } {
	if (value === undefined || value === null) return {};

	if (typeof value !== 'string') {
		return { invalid: `tool name must be a string, received ${typeof value}` };
	}

	const name = value.trim();
	if (!name) return {};

	if (!TOOL_NAME_PATTERN.test(name)) {
		return { invalid: `tool name ${JSON.stringify(name)} is not a valid tool identifier` };
	}

	return { name };
}
