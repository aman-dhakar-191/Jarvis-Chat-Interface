# Configuration and operations

Everything the gateway reads lives in `gateway/.env`. Nothing is baked into the
image, so a config change is an edit plus `docker compose up -d`.

## Applying a change

```bash
cd /docker/jarvis/gateway
nano .env
docker compose up -d          # recreates the container with the new env
docker compose logs -f jarvis-gateway
```

`docker compose up -d` is a no-op when nothing changed, so it is safe to repeat.
Only `git pull` + `--build` rebuilds the image:

```bash
git pull && docker compose up -d --build
```

## Environment reference

### Identity and access

| Variable | Default | Notes |
| --- | --- | --- |
| `AUTH_TOKENS` | — | `token:userId`, comma separated for several devices or people. Empty disables auth entirely — dev only. |
| `ALLOWED_ORIGINS` | — | Browser origins allowed to open a socket. Must match exactly, scheme included. Empty allows any. Non-browser clients send no `Origin` and are unaffected. |
| `DEFAULT_SESSION_ID` | `session_<userId>` | The stable conversation key. Change it and you start a new Jarvis memory thread. |

Rotating a token is two steps — edit `AUTH_TOKENS`, `docker compose up -d`, then
paste the new value into each device. Old tokens stop working the moment the
container restarts.

### n8n connection

| Variable | Default | Notes |
| --- | --- | --- |
| `N8N_WEBHOOK_URL` | — | Where user messages go. Use the container name (`http://n8n:5678/...`) so traffic stays on the Docker network. |
| `N8N_WEBHOOK_SECRET` | — | Sent as `x-jarvis-secret`. Enforce it in *Normalize Chat Input*. |
| `N8N_RESPONSE_MODE` | `sync` | `sync` waits for the HTTP response; `async` waits for a callback to `/api/push`. |
| `N8N_TIMEOUT_MS` | `120000` | Raise it if Jarvis routinely thinks for longer than two minutes. |
| `N8N_RESPONSE_PATH` | — | Dot-path to the reply text, only if auto-detection misses it. |
| `N8N_RESUME_URL_PREFIX` | n8n origin | Approval resume URLs must start with this. `*` disables the check. |

### Push and approvals

| Variable | Default | Notes |
| --- | --- | --- |
| `PUSH_SECRET` | — | Required as `x-gateway-secret` on `POST /api/push`. Empty disables the endpoint. |
| `APPROVAL_TIMEOUT_MS` | `3600000` | How long an unanswered approval stays answerable. |

### Limits

| Variable | Default | Notes |
| --- | --- | --- |
| `MAX_MESSAGE_BYTES` | `32768` | Largest accepted WebSocket frame. |
| `MAX_INFLIGHT_PER_CONNECTION` | `4` | Concurrent messages before `RATE_LIMITED`. |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Ping interval; silent sockets are dropped and the client reconnects. |

## Test URL vs Production URL

n8n exposes every webhook twice, and the difference trips everyone up once.

| | Production | Test |
| --- | --- | --- |
| Path | `/webhook/jarvis-chat` | `/webhook-test/jarvis-chat` |
| Works when | The workflow is **Active** | You clicked **Execute workflow** |
| Lifetime | Always | **One request**, then dead |
| Where you see the run | Executions tab | Live on the canvas |

### Normal development — production plus the Executions tab

Leave the workflow Active and watch **Executions** in the left sidebar. Every
message from your phone shows up, and opening one gives the same node-by-node
view with full input and output. No re-arming, no `.env` edits. This is the
right default.

### When you need the canvas — test URL

Use it to step through a half-built branch or to work with pinned data.

```bash
cd /docker/jarvis/gateway
sed -i 's|/webhook/|/webhook-test/|' .env && docker compose up -d
```

Then, **for each message**: click *Execute workflow* in n8n, send exactly one
message from the app, watch the canvas. It catches one request and goes dead —
re-click to re-arm.

Switch back when you are done:

```bash
sed -i 's|/webhook-test/|/webhook/|' .env && docker compose up -d
```

Forgetting to switch back is the single most common cause of
`N8N_UNAVAILABLE`/404 after a debugging session.

## Sync vs async

**Sync** (default) — n8n answers on the same HTTP request via *Respond to
Webhook*. Simple, and the right choice until it isn't.

**Async** — the webhook returns immediately and n8n calls `POST /api/push` when
Jarvis finishes. Switch when Jarvis regularly outruns `N8N_TIMEOUT_MS`, or when
you want n8n to message you unprompted.

```bash
# .env
N8N_RESPONSE_MODE=async
```

Then activate the async workflow instead, and set the *Push Reply to Gateway*
node's URL to `https://jarvis.srv1918051.hstgr.cloud/api/push` with your
`PUSH_SECRET` in the `x-gateway-secret` header. Only one of the two workflows
may be Active — they share the `jarvis-chat` path.

## Health and logs

```bash
curl -s https://jarvis.srv1918051.hstgr.cloud/health
docker compose logs -f jarvis-gateway
docker ps --filter name=jarvis-gateway --format '{{.Names}}\t{{.Status}}'
```

`/health` reports live counts:

```json
{ "ok": true, "connections": 1, "pendingExecutions": 0, "pendingApprovals": 0,
  "authEnabled": true, "n8nConfigured": true, "responseMode": "sync" }
```

Logs are one JSON object per line, so they grep well:

```bash
docker logs jarvis-gateway 2>&1 | grep '"level":"error"'
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Status pill stuck on *retrying* | Wrong token, or `ALLOWED_ORIGINS` doesn't match the URL you're browsing exactly. |
| `404 ... not registered` | Workflow not Active, or `.env` still points at `/webhook-test/`. |
| `not registered for GET requests` | You opened the webhook in a browser. It's POST-only — this message means it *is* working. |
| `EXECUTION_FAILED: no reply text` | The workflow has no *Respond to Webhook* node, or the webhook's Respond mode isn't set to use one. |
| `EXECUTION_TIMEOUT` | Jarvis exceeded `N8N_TIMEOUT_MS`. Raise it or switch to async. |
| `N8N_UNAVAILABLE` | Wrong `N8N_WEBHOOK_URL`, or the gateway isn't on n8n's Docker network. |
| Replies work, memory doesn't | The memory node isn't keyed on `{{ $json.sessionId }}`, or the session id changed. |
| Approval buttons do nothing | `PUSH_SECRET` unset, or the resume URL is outside `N8N_RESUME_URL_PREFIX`. |
