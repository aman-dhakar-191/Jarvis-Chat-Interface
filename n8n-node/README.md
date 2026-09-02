# n8n-nodes-jarvis

An n8n community node package for the [Jarvis Gateway](../README.md). Replaces
the HTTP Request + Wait pair with real nodes, and moves the push secret out of
node parameters into a proper n8n credential.

## Nodes

Two node types, laid out the way n8n's own Telegram integration is: one action
node carrying several actions, plus a separate trigger.

| Node | Internal name | Purpose |
| --- | --- | --- |
| **Jarvis** | `jarvis` | Sends progress, notifications and approval requests back to the app. |
| **Jarvis Trigger** | `jarvisTrigger` | **Starts a workflow** when a message arrives from the app. Replaces the Webhook + Normalize Chat Input pair, and accepts Telegram Trigger payloads too. Set **Respond → When Last Node Finishes** for sync mode. |

The trigger **starts** a workflow; the Jarvis node's approval action **pauses
and resumes one that is already running**. They both declare a webhook, but
they are not interchangeable - see [EXTENDING.md](EXTENDING.md).

## Actions

Each action carries an `action` label, so the node creator lists all three as
separate entries even though they are one node type.

| Action | What it does | Blocks? |
| --- | --- | --- |
| **Send Progress** | Transient status line in the app while Jarvis works | No |
| **Send Notification** | A chat bubble, even with nothing in flight | No |
| **Send and Wait for Approval** | Buttons in the app; parks the execution until answered | **Yes** |

Under an AI Agent, reach the third one through the generated **Jarvis Human
Review** tool rather than placing the node by hand - see below.

### Progress stages

A status line lives under the typing indicator, so it is only visible while a
turn is in flight, and only one shows at a time.

| Stage | Effect |
| --- | --- |
| **Tool Started** | Replaces the status line - "Searching your email…" |
| **Tool Progress** | Replaces it again. Send as often as there is something new to say. |
| **Tool Finished** | **Clears** it. The step is over. |
| **Execution Progress** | Replaces it, for the run as a whole rather than one step. |

Anything that should survive the run belongs in a **notification**, which writes
a real message.


All three POST to the gateway's `/api/push` with the credential's
`x-gateway-secret` header:

```jsonc
// Send Notification
{ "sessionId": "session_aman", "event": "notification", "content": "Done." }

// Send Progress
{ "sessionId": "session_aman", "event": "tool.started", "content": "Searching your email…" }

// Send and Wait for Approval
{
  "sessionId": "session_aman",
  "event": "approval.request",
  "resumeUrl": "https://n8n.example.com/webhook-waiting/…",
  "content": "The agent wants to use gmail_send…",
  "data": {
    "inputType": "choice",
    "choices": [{ "value": "approve", "label": "Approve" },
                { "value": "reject",  "label": "Reject" }],
    "approvalType": "double",
    "toolName": "gmail_send",
    "toolParameters": "{\"to\":\"…\"}"
  }
}
```

## Human Review

Connect the tool n8n generates from this node (`jarvisHitlTool`, shown as
**Jarvis - Request human approval for tools**) to an AI Agent. It does two jobs,
and **the agent picks which one per call**:

| The agent is about to… | Approval Required | What happens |
| --- | --- | --- |
| read or look something up - search the web, read email | `false` | The user is told what is happening. Nothing to approve, so the agent continues immediately. |
| change, send, delete or spend something - send that email | `true` | Buttons in the app; the execution parks until the user answers. |

**Approval Decided By** controls who makes that call:

| Setting | Behaviour |
| --- | --- |
| **The Agent** (default) | `Approval Required` is filled per call by `$fromAI()` |
| **Always Ask** | Every call waits for the user |
| **Never Ask, Just Inform** | Every call tells the user and continues |

Fix it yourself for anything consequential. Leaving it to the agent means the
thing being policed also decides whether policing applies, and a model that
misjudges once sends the email with no human in the loop. A practical split is
two Human Review nodes on the same agent - **Always Ask** gating what leaves the
building, **The Agent** gating the read-only tools.

If the value cannot be resolved - the node used outside a tool context, where
`$fromAI` has nothing to resolve against - it falls back to **asking**. Failing
to work out whether something needs approval must never be the same as deciding
it does not.

When approval *is* required, the node parks the execution itself - no separate
Wait node. It sends n8n's `$execution.resumeUrl` to the gateway, which **stores
it server-side and never sends it to a browser**; the app only ever sees an
opaque `approvalId`.

```text
AI Agent
   ↓
Jarvis (Send and Wait)       → POST /api/push  (approval.request + resumeUrl)
   ↓
execution parked             ← putExecutionToWait(), up to the Wait For limit
   ↓
user approves in Jarvis      → gateway POSTs the resume URL
   ↓
webhook() → workflowData     ← the approval payload becomes the node's output
   ↓
AI Agent continues
```

n8n generates that tool by detecting the `sendAndWait` operation value - do not
rename or remove the operation, and note that hiding it from the Actions list
is done by naming it `*`, not by deleting it.

Output after resuming - the same fields flat and under `data`:

```json
{
  "approvalId": "apr_…",
  "choice": "approve",
  "approved": true,
  "comment": null,
  "userId": "aman",
  "sessionId": "session_aman",
  "respondedAt": "2026-08-31T08:15:00.000Z",
  "data": { "approved": true, "…": "…" }
}
```

The flat copy is what workflows branch on. The `data` copy is what the HITL
engine reads: it runs the gated tool only when it finds an approval there, so an
answer without one ends the agent's call and the tool never runs. When
`Approval Required` is false the node answers `approved: true` with
`informed: true`, because the agent asked whether it may proceed and the answer
was that it did not need to ask.

The node has a **single output** on purpose: n8n only ever fires the first
output of a webhook-wait node ([n8n#12823](https://github.com/n8n-io/n8n/issues/12823)).
Branch downstream with an **IF** on `{{ $json.approved }}`.

## Install

### Option A — from npm (once published)

n8n → **Settings → Community Nodes → Install** → `n8n-nodes-jarvis`.

Requires an Owner/Admin account on self-hosted n8n.

### Option B — from source, no npm account

Build a tarball and install it into n8n's nodes directory. A VPS running only
Docker usually has no Node or npm on the host, so build inside a throwaway
container rather than installing a toolchain:

```bash
cd /docker/jarvis/n8n-node

# Build the tarball. Nothing is installed on the host; the container is discarded.
docker run --rm -v "$PWD":/src -w /src node:22-alpine \
  sh -c 'npm install && npm run build && npm pack'
ls -l n8n-nodes-jarvis-*.tgz          # should exist now

N8N=n8n-z44q-n8n-1                    # your n8n container name
docker cp n8n-nodes-jarvis-0.1.0.tgz $N8N:/tmp/
docker exec -u node $N8N sh -c '
  mkdir -p /home/node/.n8n/nodes &&
  cd /home/node/.n8n/nodes &&
  npm install /tmp/n8n-nodes-jarvis-0.1.0.tgz'
docker restart $N8N
```

If the host *does* have npm, `npm install && npm run build && npm pack` works
directly and you can skip the first container.

Verify it registered:

```bash
docker exec -u node $N8N ls -R /home/node/.n8n/nodes/node_modules/n8n-nodes-jarvis/dist/nodes/Jarvis
docker logs $N8N 2>&1 | grep -i -E 'jarvis|community' | tail -20
```

`/home/node/.n8n` is the persisted volume, so the node survives restarts. It
does **not** survive the volume being recreated — re-run the above if that
happens.

Confirm it loaded: the node picker should list **Jarvis** (with its three
actions) and **Jarvis Trigger**, and `docker logs $N8N | grep -i jarvis`
should be free of load errors.

## Credential

Create one **Jarvis Gateway API** credential:

| Field | Value |
| --- | --- |
| Gateway URL | `https://jarvis.srv1918051.hstgr.cloud` |
| Push Secret | your gateway's `PUSH_SECRET` |

Hit **Test** — it calls `/health` and should come back green. Every Jarvis node
then reuses it; the secret never appears in a workflow again.

## The immediate reply

In **Respond → Immediately** (async) mode the trigger answers the moment the
message arrives, before the workflow runs, and **Immediate Reply** is what it
sends. It defaults to `Working on it...`.

There is no workflow data at that point - the workflow has not started, so
`$json` is empty and nothing from a Set node or the incoming message is
reachable. But the expression is evaluated per request, so anything
self-contained still varies message to message:

```js
={{ ["Working on it...", "On it...", "Give me a sec..."][Math.floor(Math.random() * 3)] }}
```

In **When Last Node Finishes** (sync) mode the field is hidden and irrelevant:
the reply is the final node's first item.

## Respond to Webhook does not work behind this trigger

n8n's **Respond to Webhook** node only recognises the core `n8n-nodes-base.webhook`
node. Behind a community trigger it fails with *"No Webhook node found in the
workflow"*.

So in sync mode set the trigger's **Respond** to **When Last Node Finishes** and
end the workflow with the node that produces the reply - n8n returns that node's
first item by itself. `responseNode` is therefore not offered as an option.

```text
Jarvis Trigger → … → Format Reply        ← the reply is this node's output
```

If you would rather keep a Respond to Webhook node, use the core **Webhook**
node as the trigger instead, with a Code node for normalization - the
arrangement in [docs/n8n-setup.md](../docs/n8n-setup.md).

## Gateway requirements

- `PUSH_SECRET` set.
- `N8N_RESUME_URL_PREFIX` must allow the resume URL. It defaults to the origin
  of `N8N_WEBHOOK_URL`, which is correct when both are the same n8n instance.

## Extending it

Adding nodes, trigger nodes, or another credential:
**[EXTENDING.md](EXTENDING.md)**.

## Development

```bash
npm install
npm run typecheck
npm test          # builds, then runs structural checks on the built package
```

## Status

Both nodes are typechecked, built and structurally validated. Confirm in the
UI that the picker lists all three Jarvis actions, that the AI Agent offers the
generated **Jarvis Human Review** (`jarvisHitlTool`) tool, and that an approval
round-trips. If either misbehaves, the fallback is the Webhook + Code + Wait +
HTTP Request arrangement in [docs/interactive.md](../docs/interactive.md) and
[docs/n8n-setup.md](../docs/n8n-setup.md), which is proven end to end.
