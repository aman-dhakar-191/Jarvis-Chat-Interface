# Jarvis Chat Interface

A custom chat front end for Jarvis, replacing Telegram as the transport. Your
existing n8n workflow — Supervisor, memory, skills, MCP, tools — is untouched.

```text
   Phone / laptop browser
            ↕  WebSocket (wss)
      Jarvis Gateway
            ↓  HTTP POST
      n8n webhook  →  existing Jarvis workflow
            ↓
      Jarvis Gateway
            ↕  WebSocket
   Phone / laptop browser
```

## Why a web app rather than native Android

An installable **PWA**, served by the gateway itself. Open the URL on your
phone, *Add to Home Screen*, and you get an icon and a full-screen app with no
Play Store, no signing, and no build pipeline. One codebase serves phone and
desktop.

The one thing native buys you is **background push** — a browser's WebSocket
closes when the app is backgrounded, so unprompted messages only arrive while
the app is open. Everything here is transport-agnostic, so an Android client can
be added later against the same protocol without touching the gateway or n8n.

## Why a gateway rather than calling n8n directly

You could POST to the n8n webhook straight from the phone. Then the webhook URL
and its secret ship inside the client, anyone who finds them can drive Jarvis,
there is no persistent connection, and n8n can never reach you unprompted. The
gateway is a few hundred lines and buys authentication, one stable session
across devices, and a socket n8n can push into.

## Quick start

```bash
cd gateway
npm install
cp .env.example .env      # then edit it
npm start                 # http://localhost:3000
```

Set at minimum:

```bash
AUTH_TOKENS=a-long-random-string:aman
N8N_WEBHOOK_URL=https://your-n8n/webhook/jarvis-chat
PUSH_SECRET=another-long-random-string
```

Open the URL, tap the gear, paste the token, and send a message.

Set up the n8n side with **[docs/n8n-setup.md](docs/n8n-setup.md)** — it ships
importable workflows that run end to end before you connect Jarvis, so you can
prove the transport first.

## Deploying with Docker

Built for a VPS that already runs Traefik and n8n in Docker — Traefik terminates
TLS and upgrades the WebSocket automatically, so there is no proxy config to
write.

```bash
cd gateway
cp .env.example .env       # fill it in
docker compose up -d --build
```

Before the first run, edit `docker-compose.yml`:

- **`traefik.http.routers.jarvis.rule`** — your domain, e.g.
  ``Host(`jarvis.yourdomain.com`)``. Point that DNS record at the VPS first.
- **`traefik.http.routers.jarvis.tls.certresolver`** — must match the resolver
  your Traefik already uses. Check with
  `docker inspect traefik | grep -i certificatesresolvers`.
- **`networks`** — `proxy` must be the network your Traefik container is on, and
  `n8n` the one n8n is on. List them with `docker network ls`, and confirm with
  `docker inspect <container> | grep -A5 Networks`.

Because the gateway shares a network with n8n, point it at the container rather
than back out through the internet:

```bash
N8N_WEBHOOK_URL=http://n8n:5678/webhook/jarvis-chat
```

Then open `https://jarvis.yourdomain.com` on your phone and *Add to Home Screen*.

Check it came up with `docker compose logs -f jarvis-gateway` and
`curl https://jarvis.yourdomain.com/health`. The image runs as a non-root user
and carries a `HEALTHCHECK`, so `docker ps` reports health directly.

## Using it from your phone

The gateway must be reachable from the phone over **HTTPS/WSS** — a service
worker, *Add to Home Screen*, and (on iOS) WebSockets all require a secure
origin. `http://` works only on `localhost`.

- **Permanent:** the Docker + Traefik setup above.
- **Quick test, no DNS:** a tunnel — `cloudflared tunnel --url http://localhost:3000`
  or `ngrok http 3000`. Open the https URL on your phone.

Any reverse proxy other than Traefik must forward the `Upgrade` and `Connection`
headers, or the WebSocket will not connect.

Then: open the URL → browser menu → *Add to Home Screen*.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WebSocket port. |
| `AUTH_TOKENS` | — | `token:userId` pairs, comma separated. Empty disables auth (dev only). |
| `ALLOWED_ORIGINS` | — | Browser origins allowed to connect. Empty allows any. |
| `N8N_WEBHOOK_URL` | — | Your Jarvis Chat webhook. |
| `N8N_WEBHOOK_SECRET` | — | Sent as `x-jarvis-secret` so n8n can reject strangers. |
| `N8N_RESPONSE_MODE` | `sync` | `sync` waits for n8n's HTTP response; `async` waits for a callback. |
| `N8N_TIMEOUT_MS` | `120000` | How long to wait for Jarvis. |
| `N8N_RESPONSE_PATH` | — | Dot-path to the reply text, if auto-detection misses it. |
| `PUSH_SECRET` | — | Shared secret for `POST /api/push`. |
| `DEFAULT_SESSION_ID` | `session_<userId>` | The stable conversation key. |
| `MAX_MESSAGE_BYTES` | `32768` | Largest accepted frame. |
| `MAX_INFLIGHT_PER_CONNECTION` | `4` | Concurrent messages before `RATE_LIMITED`. |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Ping interval; silent sockets are dropped. |

## Session identity

`sessionId` is **stable and never regenerated** — Jarvis keys its memory on it.
It defaults to `session_<userId>` and is the same on every device and after every
reinstall, so your phone and laptop share one conversation. Pin it explicitly
with `DEFAULT_SESSION_ID`, or override per device in the app's settings.

n8n sees the same value as `chatId`, the Telegram-equivalent routing key: reply
with `chatId` (or `messageId`) and the gateway knows which device to deliver to.

The **+** button clears what this device shows. It does not change the session —
Jarvis keeps its memory.

## What the gateway does

- Terminates WebSocket connections and authenticates them at the handshake, so
  an unauthenticated client never reaches the message loop.
- Derives identity from the token — a client cannot claim another `userId`.
- Translates `user.message` into the payload your n8n webhook expects, and n8n's
  response back into `assistant.message`, preserving `sessionId` and `messageId`.
- Surfaces every failure as a typed error instead of a hung spinner.
- Accepts pushes from n8n (`POST /api/push`) for async replies and for
  unprompted notifications.
- Heartbeats connections and serves the web client.

- Carries human-in-the-loop approvals: n8n parks a Wait node, your phone shows
  buttons, and the gateway resumes the workflow with your answer — without ever
  handing the resume URL to a browser.

Full event reference: **[docs/protocol.md](docs/protocol.md)**.
Config and day-to-day operations: **[docs/configuration.md](docs/configuration.md)**.
Progress updates and approvals: **[docs/interactive.md](docs/interactive.md)**.
Optional n8n community node: **[n8n-node/README.md](n8n-node/README.md)**.

## Tests

```bash
cd gateway && npm test
```

21 end-to-end tests run a real gateway against a stub n8n over real WebSockets:
the full round trip, identity spoofing, handshake rejection, n8n being down or
erroring, malformed frames, async callbacks, push routing and authorization,
rate limiting, session stability, and the approval round trip — including that
the resume URL never reaches a client, that an approval cannot be answered
twice, and that it survives a reconnect.

## Layout

```text
gateway/
  src/
    index.js        bootstrap and graceful shutdown
    server.js       HTTP + WebSocket wiring, /health, /api/push
    handlers.js     the event loop: session.join, user.message, ping
    n8n.js          webhook client and reply extraction
    protocol.js     envelopes, validation, error codes
    auth.js         token checks, origin checks
    connections.js  connection registry and fan-out
    executions.js   in-flight executions for async mode
    approvals.js    parked human-in-the-loop approvals
    config.js       environment parsing
  public/           the web client (PWA)
  test/             end-to-end tests
  Dockerfile        production image, non-root, healthchecked
  docker-compose.yml  deployment behind Traefik
n8n-node/           optional n8n community node (n8n-nodes-jarvis)
  credentials/      Jarvis Gateway credential
  nodes/Jarvis/     Send Progress / Notify / Ask for Approval
docs/
  n8n-setup.md      wiring this to your existing Jarvis
  configuration.md  every setting, test vs production URLs, troubleshooting
  interactive.md    progress updates and human-in-the-loop approvals
  protocol.md       event reference
  technical-design.md  the original design document
  n8n/              importable workflows + standalone Code nodes
```

## Status

Working today: the full loop, stable sessions, multi-device delivery,
reconnection, async replies, unprompted notifications, live progress updates,
human-in-the-loop approvals, typed errors.

Not built yet: token streaming (`assistant.chunk`), cancelling a running
execution, attachments, and a native Android client — all of which the protocol
already has room for.
