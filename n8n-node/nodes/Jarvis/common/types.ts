import type { IDataObject } from 'n8n-workflow';

/** Every event name the Jarvis Gateway accepts on POST /api/push. */
export type JarvisEvent =
	| 'notification'
	| 'tool.started'
	| 'tool.progress'
	| 'tool.finished'
	| 'execution.progress'
	| 'approval.request';

/** One button the Jarvis client renders under an approval prompt. */
export interface ApprovalChoice {
	value: 'approve' | 'reject';
	label: string;
}

/**
 * n8n's human-in-the-loop generator looks for a `fixedCollection` named
 * `approvalOptions` and carries it over onto the generated HITL tool, so the
 * shape below is dictated by n8n, not by the gateway.
 */
export interface ApprovalOptions {
	values?: {
		approvalType?: 'single' | 'double';
		approveLabel?: string;
		disapproveLabel?: string;
	};
}

/** The body posted to /api/push for a plain (non-blocking) event. */
export interface JarvisPushBody extends IDataObject {
	sessionId: string;
	event: JarvisEvent;
	content: string;
}

/** The body posted to /api/push when the execution is about to park. */
export interface ApprovalRequest extends IDataObject {
	sessionId: string;
	event: 'approval.request';
	resumeUrl: string;
	content: string;
	data: {
		inputType: 'choice';
		choices: ApprovalChoice[];
		approvalType: 'single' | 'double';
		toolName: unknown;
		toolParameters: unknown;
	};
}
