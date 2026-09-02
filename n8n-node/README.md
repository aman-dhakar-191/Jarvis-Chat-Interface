# n8n-nodes-jarvis

An n8n community node package for the [Jarvis Gateway](../README.md). Replaces
the HTTP Request + Wait pair with real nodes, and moves the push secret out of
node parameters into a proper n8n credential.

## Nodes

Each node does one thing, so the node picker lists them separately instead of
hiding them behind an operation dropdown.

| Node | Internal name | Purpose | Blocks? |
| --- | --- | --- | --- |
| **Jarvis Trigger** | `jarvisTrigger` | **Starts a workflow** when a message arrives from the app. Replaces the Webhook + Normalize Chat Input pair, and accepts Telegram Trigger payloads too. Set **Respond → When Last Node Finishes** for sync mode. | — |
| **Jarvis Notification** | `jarvisNotification` | Sends a chat bubble to a session, even with nothing in flight. | No |
| **Jarvis Progress** | `jarvisProgress` | Sends a transient status line while Jarvis works (`tool.started`, `tool.progress`, `tool.finished`, `execution.progress`). | No |
| **Jarvis Human Review** | `jarvisHumanReview` | **Pauses the running execution**, asks the user to approve or reject in the app, and resumes when they answer. | **Yes** |
| ~~**Jarvis (Legacy)**~~ | `jarvis` | Deprecated. The old single node with the Send Progress / Send Notification / Send and Wait operations. Still loads so saved workflows keep working, but hidden from the node picker. | — |

The trigger **starts** a workflow; Human Review **pauses and resumes one that is
already running**. They both declare a webhook, but they are not
interchangeable — see [EXTENDING.md](EXTENDING.md).

### What each action node sends

All three POST to the gateway's `/api/push` with the credential's
`x-gateway-secret` header:

```jsonc
// Jarvis Notification
{ "sessionId": "session_aman", "event": "notification", "content": "Done." }

// Jarvis Progress
{ "sessionId": "session_aman", "event": "tool.started", "content": "Searching your email…" }

// Jarvis Human Review
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

Human Review parks the execution itself — no separate Wait node. It sends
n8n's `$execution.resumeUrl` to the gateway, which **stores it server-side and
never sends it to a browser**; the app only ever sees an opaque `approvalId`.

```text
AI Agent
   ↓
Jarvis Human Review          → POST /api/push  (approval.request + resumeUrl)
   ↓
execution parked             ← putExecutionToWait(), up to the Wait For limit
   ↓
user approves in Jarvis      → gateway POSTs the resume URL
   ↓
webhook() → workflowData     ← the approval payload becomes the node's output
   ↓
AI Agent continues
```

Under an **AI Agent**, connect the tool variant n8n generates from this node
(`jarvisHumanReviewHitlTool`, shown as a Human Review tool) rather than the node
itself. That variant only exists because the node declares the `sendAndWait`
operation — do not remove it.

Output after resuming:

```json
{
  "approvalId": "apr_…",
  "choice": "approve",
  "approved": true,
  "comment": null,
  "userId": "aman",
  "sessionId": "session_aman",
  "respondedAt": "2026-08-31T08:15:00.000Z"
}
```

Human Review has a **single output** on purpose: n8n only ever fires the first
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

Confirm it loaded: the node picker should list **Jarvis Trigger**, **Jarvis
Notification**, **Jarvis Progress** and **Jarvis Human Review**, and
`docker logs $N8N | grep -i jarvis` should be free of load errors. *Jarvis
(Legacy)* is deliberately absent from the picker — it still loads for workflows
that already contain it.

## Credential

Create one **Jarvis Gateway API** credential:

| Field | Value |
| --- | --- |
| Gateway URL | `https://jarvis.srv1918051.hstgr.cloud` |
| Push Secret | your gateway's `PUSH_SECRET` |

Hit **Test** — it calls `/health` and should come back green. Every Jarvis node
then reuses it; the secret never appears in a workflow again.

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

## Migrating off the legacy node

Existing workflows containing the old **Jarvis** node keep running untouched;
nothing about `jarvis`, its operation values or its `jarvisHitlTool` variant
changed. To move one over, replace it with:

| Old operation | New node |
| --- | --- |
| Send Progress | Jarvis Progress |
| Send Notification | Jarvis Notification |
| Send and Wait for Approval | Jarvis Human Review |

Field values carry over as-is, except the notification body, which moved from
`notifyContent` to `content`. There is no deadline to migrate, but the legacy
node will not gain features.

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

The four nodes are typechecked, built and structurally validated. The split
into separate nodes has not yet been exercised in a live n8n instance: confirm
in the UI that all four appear in the picker, that the AI Agent offers the
generated **Jarvis Human Review** tool, and that an approval round-trips. If either misbehaves, the fallback is the Webhook + Code + Wait +
HTTP Request arrangement in [docs/interactive.md](../docs/interactive.md) and
[docs/n8n-setup.md](../docs/n8n-setup.md), which is proven end to end.
