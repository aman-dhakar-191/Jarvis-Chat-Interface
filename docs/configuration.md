# Configuration and operations

Everything the gateway reads lives in `gateway/.env`. Nothing is baked into the
image, so a config change is an edit plus `docker compose up -d`.

## Applying a change

```bash
cd /docker/jarvis/gateway
nano .env
docker compose up -d --force-recreate      # picks up the new .env
docker compose logs -f jarvis-gateway
```

`--force-recreate` matters. Plain `up -d` often prints `Started` and reuses the
existing container with the **old** environment, so an edited `.env` appears to
do nothing. If Compose says `Started` rather than `Recreated`, your change did
not land.

`docker compose up -d` is a no-op when nothing changed, so it is safe to repeat.

## Updating to a new version

```bash
cd /docker/jarvis/gateway
git pull
docker compose up -d --build
curl -s https://jarvis.srv1918051.hstgr.cloud/health
```

Which command you need depends on what changed:

| Changed | Command |
| --- | --- |
| `.env` only | `docker compose up -d --force-recreate` |
| Gateway code (after `git pull`) | `docker compose up -d --build` |
| Nothing | neither — `up -d` is a no-op |

`--build` matters because the image is built locally from source. Without it,
Compose restarts the *old* image and your pull appears to do nothing.

`.env` is gitignored, so your tokens and secrets survive every pull untouched.

Downtime is about a second, and the web client reconnects on its own with
exponential backoff — in practice the status pill blinks and nothing is lost.
Anything mid-flight is not resumed, though: an in-progress message fails with a
retry button, and pending approvals are dropped, since both live in memory.

### Hostinger's Docker Manager rewrites docker-compose.yml

If the VPS panel is used to edit this app's **Environment** table, Hostinger
rewrites `gateway/docker-compose.yml`, replacing `env_file` usage with an
`environment:` block of `${VAR}` interpolations. Any variable missing from that
block then never reaches the container, however correct `.env` is - which is
maddening to debug, because `.env` looks right and the container simply does not
have the value.

Check for it with:

```bash
git -C /docker/jarvis status --short          # gateway/docker-compose.yml modified?
grep -n 'environment\|env_file' gateway/docker-compose.yml
```

Restore the repo's version and go back to `.env` as the only source of truth:

```bash
git -C /docker/jarvis checkout -- gateway/docker-compose.yml
docker compose up -d --force-recreate
```

**Edit `.env` over SSH, not the panel's Environment table.** The panel is fine
for reading state, starting and stopping.

The same applies to `docker-compose.override.yml`: an `environment:` entry there
outranks `env_file`, so a value pinned in it silently wins over `.env`. Use the
override for ports and other structure, not for secrets.

### Local-only changes to docker-compose.yml

`docker-compose.yml` is tracked, so editing it directly makes `git pull`
conflict. Put machine-specific tweaks in `docker-compose.override.yml` instead —
Compose merges it automatically and it is gitignored:

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
```

If you have already edited the tracked file, discard it first:

```bash
git checkout docker-compose.yml && git pull
```

### Rolling back

```bash
git log --oneline -5
git checkout <sha> -- .          # or: git checkout <sha>
docker compose up -d --build
```

Reclaim space from superseded images now and then:

```bash
docker image prune -f
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

### Voice

Voice is off unless `VOICE_ENABLED=true`. With it off the gateway behaves
exactly as it did before the voice path existed.

| Variable | Default | Notes |
| --- | --- | --- |
| `VOICE_ENABLED` | `false` | Master switch. |
| `VOICE_PROVIDER` | `gemini` | `gemini` connects a realtime model; `echo` mirrors your microphone back with no model and no API key. |
| `GEMINI_API_KEY` | — | Required for `gemini`. Never reaches the browser — the gateway holds the engine connection. |
| `VOICE_MODEL` | `models/gemini-3.1-flash-live-preview` | A preview model. Pin it and expect to change it; fallback is `models/gemini-2.5-flash-native-audio-preview-09-2025`. |
| `VOICE_NAME` | `Puck` | Prebuilt voice. |
| `VOICE_LANGUAGE` | `en-US` | Sent as `speechConfig.languageCode`. **Without it the model picks a language from the audio** — an accented greeting is enough to tip it into the wrong one. |
| `VOICE_INSTRUCTIONS` | built-in | Blank uses a spoken-style default: English, one or two short sentences, no lists or markdown. An empty prompt makes a realtime model write like a chat model, which is unbearable read aloud. |
| `VOICE_MEMORY_URL` | — | The **Voice Memory Snapshot** n8n webhook. Blank runs voice without memory. |
| `VOICE_MEMORY_TIMEOUT_MS` | `2500` | Short by intent — this sits between the button press and the session opening. |
| `VOICE_INPUT_SAMPLE_RATE` | `16000` | What the engine accepts. |
| `VOICE_OUTPUT_SAMPLE_RATE` | `24000` | What the engine returns. **Not the same as input** — one shared rate sounds like chipmunk audio. |
| `VOICE_SILENCE_MS` | `700` | Always-on mode only. Below ~500 ms a natural mid-sentence pause reads as end-of-turn. |
| `VOICE_PREFIX_PADDING_MS` | `300` | Always-on mode only. |
| `VOICE_MAX_SESSION_MS` | `1800000` | Gateway-side session cap. |
| `VOICE_MAX_RECONNECTS` | `20` | Upstream drops a connection roughly every 10 minutes and is resumed transparently; bounded so a revoked key surfaces instead of looping. |
| `VOICE_MAX_AUDIO_BYTES_PER_SECOND` | `96000` | Flood guard. 16 kHz PCM16 is ~32 kB/s. |

**On the VPS, these go in `gateway/.env` over SSH** — the deploy pipeline does
`git reset --hard`, which never touches `.env` because it is gitignored. That
also means a deploy alone does **not** turn voice on: add the variables first,
then `docker compose up -d --force-recreate`.

Watch for the Hostinger Docker Manager trap above: if the panel has rewritten
`docker-compose.yml` into an `environment:` block, every `VOICE_*` variable is
missing from that block and silently never reaches the container. `.env` will
look perfectly correct while voice refuses to start.

Confirm it took:

```bash
curl -s https://jarvis.srv1918051.hstgr.cloud/health | grep -o '"voiceEnabled":[a-z]*'
docker exec jarvis-gateway printenv | grep VOICE_
```

### Voice memory

Voice does not retrieve memory per turn. A retrieval tool costs an embedding
call plus a vector scan — seconds — which in a spoken conversation is a dead
pause where the assistant should be talking. Instead the **Voice Memory
Snapshot** workflow (`XOjMjglzrhSVkpb2`) returns durable facts plus recent
conversation as one compact block, and the gateway folds it into the session's
system instruction at start. Recall is then free for the rest of the session.

It is refreshed on every upstream reconnect — the link is replaced roughly
every 10 minutes anyway — so a long session picks up anything learned since it
opened.

Every failure is non-fatal: an unreachable or slow snapshot logs a warning and
the session opens without memory. A voice session with no memory is worth far
more than no voice session.

Deep or rare lookups still belong in a tool call (Phase 4), not in the
snapshot — the system instruction sits in context for the whole session, so
every line is paid for on every turn in latency and audio tokens. The snapshot
is capped at 3500 characters and drops lowest-confidence facts first.

```bash
curl -sX POST https://n8n-z44q.srv1918051.hstgr.cloud/webhook/voice-memory-snapshot \
  -H 'content-type: application/json' -d '{"source":"voice"}'
```

The container also needs outbound WSS to `generativelanguage.googleapis.com`.
Normal Docker bridge egress covers this, but a locked-down egress policy would
show up as `VOICE_UNAVAILABLE` on every session start with a connect error in
the logs.

## Test URL vs Production URL

n8n exposes every webhook twice, and the difference trips everyone up once.

| | Production | Test |
| --- | --- | --- |
| Path | `/webhook/jarvis-chat` | `/webhook-test/jarvis-chat` |
| Works when | The workflow is **Active** | You clicked **Execute workflow** |
| Lifetime | Always | **One request**, then dead |
| Where you see the run | Executions tab | Live on the canvas |

### Switching from the app

Open the app's settings and turn on **Use n8n test webhook**. That message, and
every one after it, goes to `/webhook-test/` instead - no redeploy, and it is
per device, so your phone can be in test mode while the gateway keeps serving
production to everything else.

A **test** badge sits next to the connection status while it is on, because
leaving it on by accident produces 404s that look like a broken gateway. If the
test webhook is not armed, the app says so instead of showing a bare 404:

> The n8n test webhook is not listening. Click "Execute workflow" in n8n before
> each message, or turn off test mode.

The toggle is hidden when the gateway has no test URL to derive.

### Switching the whole gateway, in one word

```bash
cd /docker/jarvis/gateway
./jarvis status      # which mode am I in, and is the gateway healthy?
./jarvis test        # point at /webhook-test/ and restart
./jarvis prod        # point back at /webhook/ and restart
```

It edits `N8N_WEBHOOK_URL` and recreates the container with `--force-recreate`,
then prints the live value read back out of the container. Add `--no-restart`
to change `.env` without recreating.

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
  "voiceEnabled": true, "voiceSessions": 0,
  "authEnabled": true, "n8nConfigured": true, "responseMode": "sync" }
```

`voiceEnabled` is the fastest check that a voice deploy actually took;
`voiceSessions` counts live audio sessions.

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
| `No Webhook node found in the workflow` | A Respond to Webhook node sits behind the Jarvis Trigger. It only supports the core Webhook node - set the trigger's Respond to *When Last Node Finishes* and delete the Respond node. |
| Approval buttons do nothing | `PUSH_SECRET` unset, or the resume URL is outside `N8N_RESUME_URL_PREFIX`. |
| An `.env` edit had no effect | Compose reused the old container. Use `--force-recreate` and confirm with `docker compose config \| grep <VAR>`. |
| Traefik returns `404 page not found` | The container has not been recreated since its labels changed, so Traefik never saw the new rule. `--force-recreate` re-fires the Docker event. |
