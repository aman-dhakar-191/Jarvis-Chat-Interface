'use strict';

/**
 * Spoken approvals.
 *
 * A human-in-the-loop request renders as buttons in the chat transcript, which
 * is useless mid-conversation: you would have to find the screen, read it, and
 * tap. Instead the request is handed to the model as a turn, it reads the
 * question out, and the answer comes back as a tool call.
 *
 * The resume URL never leaves the gateway, exactly as on the text path. The
 * model can only say "approve" or "reject" for an id the gateway raised.
 *
 * ── On remembering decisions ──────────────────────────────────────────────
 * Standing rules are the dangerous part. Speech is misheard; a misheard "yeah"
 * that approves one action is recoverable, one that permanently auto-approves a
 * class of actions is not. So:
 *
 *   - Creating a rule is a SEPARATE decision from the approval. The model must
 *     ask again, in its own turn, and pass remember:true explicitly.
 *   - Rules are scoped to a kind of request, never "approve everything".
 *   - Every automatic approval is announced aloud and written to the chat
 *     transcript, so it is never silent.
 *   - Rules are listable and revocable by voice.
 */

const logger = require('../logger');
const protocol = require('../protocol');

const TOOLS = [
  {
    name: 'resolve_approval',
    description:
      'Answer a pending approval request that you read out to Aman. Call this only after he has clearly said yes or no. Never call it to ask a question, and never guess his answer.',
    parameters: {
      type: 'object',
      properties: {
        approvalId: { type: 'string', description: 'The id of the approval you were asked about.' },
        decision: {
          type: 'string',
          enum: ['approve', 'reject'],
          description: 'What Aman decided.',
        },
        answer: {
          type: 'string',
          description: 'For a free-text question, what he actually said. Omit for a yes/no decision.',
        },
      },
      required: ['approvalId', 'decision'],
    },
  },
  {
    name: 'remember_approval_choice',
    description:
      'Stop asking about a kind of request in future. Call this ONLY after separately asking Aman whether he wants it remembered and hearing him agree - it is a different question from the approval itself, so never infer it from a yes to the action. Describe the kind narrowly.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description:
            'A short, narrow label for this class of request, e.g. "calendar event created" or "draft email saved". Never something broad like "everything" or "all actions".',
        },
        decision: { type: 'string', enum: ['approve', 'reject'] },
      },
      required: ['kind', 'decision'],
    },
  },
  {
    name: 'list_approval_rules',
    description: 'Read back the standing approval rules Aman has asked you to remember, so he can change or clear them.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'forget_approval_rule',
    description: 'Remove a standing approval rule, so Aman is asked about that kind of request again.',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string' } },
      required: ['kind'],
    },
  },
];

// Broad rules defeat the point of asking at all, so they are refused at the
// gateway rather than trusted to the model's judgement.
const TOO_BROAD = /^(all|any|every|everything|anything|always)\b/i;
// Anything shorter than this is either a wildcard or so vague it would match
// half of what Aman is asked. It is also below the length `rules.match` will
// act on, so storing one would create a rule that silently never fires.
const MIN_KIND_LENGTH = 4;

function tooBroad(kind) {
  return kind.length < MIN_KIND_LENGTH || TOO_BROAD.test(kind);
}

function normaliseKind(kind) {
  return String(kind || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
}

/**
 * Speak an approval request into a live voice session.
 * Returns true if it was handled by voice, false if the caller should leave it
 * to the chat UI.
 */
function speak(ctx, connection, session, data) {
  if (!session?.engine) return false;

  const question = String(data.content || 'A workflow is asking for your approval.');
  const choices = Array.isArray(data.choices) && data.choices.length
    ? data.choices.map((c) => c.label || c.value).join(' or ')
    : 'approve or reject';

  session.pendingApprovalId = data.approvalId;

  session.engine.sendText([
    'SYSTEM: A workflow is waiting on Aman and cannot continue until he answers.',
    `Approval id: ${data.approvalId}`,
    `Question: ${question}`,
    data.inputType === 'text'
      ? 'He should answer in his own words.'
      : `He should choose: ${choices}.`,
    'Read the question to him now, briefly and in your own words. When he answers,',
    'call resolve_approval with that id. Do not decide for him, and do not call',
    'the tool until he has actually answered.',
  ].join('\n'));

  logger.info('approval spoken to voice session', {
    approvalId: data.approvalId,
    voiceSessionId: session.voiceSessionId,
  });
  return true;
}

/** Resolve an approval on the user's behalf, reusing the text path's handler. */
async function resolve(ctx, connection, { approvalId, decision, answer }) {
  const { dispatch } = require('../handlers');
  await dispatch(ctx, connection, {
    id: protocol.eventId(),
    event: 'approval.respond',
    data: {
      approvalId,
      choice: decision === 'approve' ? 'approve' : 'reject',
      ...(answer ? { text: String(answer) } : {}),
    },
  });
}

async function handleToolCall(ctx, connection, session, call, rules) {
  const { name, args } = call;

  if (name === 'resolve_approval') {
    const approvalId = String(args.approvalId || session.pendingApprovalId || '');
    if (!approvalId) return { ok: false, error: 'No approval is pending.' };
    await resolve(ctx, connection, { approvalId, decision: args.decision, answer: args.answer });
    session.pendingApprovalId = null;
    return { ok: true, resolved: approvalId, decision: args.decision };
  }

  if (name === 'remember_approval_choice') {
    const kind = normaliseKind(args.kind);
    if (!kind) return { ok: false, error: 'That rule needs a description.' };
    if (tooBroad(kind)) {
      // Refused at the gateway rather than trusted to the model's judgement.
      return {
        ok: false,
        error: 'That rule is too broad to store. Ask Aman to name the specific kind of request.',
      };
    }
    await rules.add(kind, args.decision === 'reject' ? 'reject' : 'approve', connection.userId);
    return { ok: true, remembered: kind, decision: args.decision };
  }

  if (name === 'list_approval_rules') {
    return { ok: true, rules: await rules.list(connection.userId) };
  }

  if (name === 'forget_approval_rule') {
    const kind = normaliseKind(args.kind);
    await rules.remove(kind, connection.userId);
    return { ok: true, forgotten: kind };
  }

  return { ok: false, error: `Unknown tool ${name}` };
}

module.exports = { TOOLS, speak, resolve, handleToolCall, normaliseKind, tooBroad, MIN_KIND_LENGTH };
