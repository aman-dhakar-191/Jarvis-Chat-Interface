# n8n-nodes-jarvis

An n8n community node for the [Jarvis Gateway](../README.md). Replaces the
HTTP Request + Wait pair with real nodes, and moves the push secret out of node
parameters into a proper n8n credential.

## Operations

| Operation | What it does | Blocks? |
| --- | --- | --- |
| **Send Progress** | Transient status line in the app while Jarvis works | No |
| **Send Notification** | A chat bubble, even with nothing in flight | No |
| **Ask for Approval** | Buttons in the app; parks the execution until answered | **Yes** |

*Ask for Approval* parks the execution itself — no separate Wait node. It sends
n8n's `$execution.resumeUrl` to the gateway, which **stores it server-side and
never sends it to a browser**; the app only ever sees an opaque `approvalId`.

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
docker exec -u node $N8N ls /home/node/.n8n/nodes/node_modules/n8n-nodes-jarvis/dist/nodes/Jarvis
docker logs $N8N 2>&1 | grep -i -E 'jarvis|community' | tail -20
```

`/home/node/.n8n` is the persisted volume, so the node survives restarts. It
does **not** survive the volume being recreated — re-run the above if that
happens.

Confirm it loaded: the node picker should list **Jarvis**, and
`docker logs $N8N | grep -i jarvis` should be free of load errors.

## Credential

Create one **Jarvis Gateway API** credential:

| Field | Value |
| --- | --- |
| Gateway URL | `https://jarvis.srv1918051.hstgr.cloud` |
| Push Secret | your gateway's `PUSH_SECRET` |

Hit **Test** — it calls `/health` and should come back green. Every Jarvis node
then reuses it; the secret never appears in a workflow again.

## Gateway requirements

- `PUSH_SECRET` set.
- `N8N_RESUME_URL_PREFIX` must allow the resume URL. It defaults to the origin
  of `N8N_WEBHOOK_URL`, which is correct when both are the same n8n instance.

## Development

```bash
npm install
npm run typecheck
npm test          # builds, then runs structural checks on the built package
```

## Status

Typechecked against `n8n-workflow` 2.16.0, built, and structurally validated —
the compiled node loads, its description satisfies n8n's contract, the resume
webhook is declared correctly, and the manifest paths resolve.

It has **not** been exercised inside a running n8n. The first install is the
real test; the fallback if anything misbehaves is the HTTP Request + Wait node
pair documented in [docs/interactive.md](../docs/interactive.md), which is
proven end to end.
