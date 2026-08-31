# Gateway event protocol

Every frame is a JSON object. Client and gateway may send at any time — the
connection is full-duplex, not request/response.

```json
{
  "id": "evt_…",
  "type": "event",
  "event": "user.message",
  "timestamp": "2026-08-31T06:30:00.000Z",
  "sessionId": "session_aman",
  "data": {}
}
```

| Field | Meaning |
| --- | --- |
| `id` | Unique event id. The gateway generates one if you omit it. |
| `type` | `event`, `ack`, or `error`. |
| `event` | The event name, from the tables below. |
| `timestamp` | ISO-8601. |
| `sessionId` | The conversation key. Stable — see below. |
| `data` | Event-specific payload. |

## Client → Gateway

| Event | `data` | Notes |
| --- | --- | --- |
| `session.join` | — | `sessionId` on the envelope. Optional: the gateway falls back to your stable default. |
| `session.leave` | — | Detaches this connection from the session. |
| `user.message` | `{ messageId?, content }` | `content` is required, ≤ 8000 chars. A `messageId` is generated if omitted. |
| `connection.ping` | anything | Answered with `connection.pong`. |
| `approval.respond` | `{ approvalId, choice, comment? }` | Answers a human-in-the-loop prompt; the gateway resumes the parked n8n execution. |

A client **cannot** set its own `userId`. Identity comes from the token
presented at the handshake; anything you put in `data.userId` is ignored.

## Gateway → Client

| Event | `data` |
| --- | --- |
| `connection.ready` | `{ connectionId, userId, defaultSessionId, responseMode, authEnabled }` |
| `session.joined` | `{ connectionId, userId }` |
| `execution.started` | `{ messageId }` |
| `assistant.message` | `{ messageId, replyTo, content }` |
| `execution.completed` | `{ messageId, durationMs? }` |
| `execution.failed` | `{ messageId, code, message }` |
| `notification` | `{ content, … }` — unprompted, no request needed |
| `tool.started` / `tool.progress` / `tool.finished` / `execution.progress` | `{ content }` — transient status while Jarvis works |
| `approval.request` | `{ approvalId, content, choices: [{ value, label }] }` |
| `approval.resolved` | `{ approvalId, choice, by }` — also when another device answered |
| `approval.expired` | `{ approvalId }` |
| `error` | `{ code, message, messageId? }` |
| `connection.pong` | `{ echo }` |

Acknowledgements are their own frame shape:

```json
{ "type": "ack", "eventId": "evt_001", "status": "accepted", "messageId": "msg_001" }
```

### Error codes

`AUTH_FAILED`, `INVALID_MESSAGE`, `INVALID_SESSION`, `RATE_LIMITED`,
`N8N_UNAVAILABLE`, `EXECUTION_FAILED`, `EXECUTION_TIMEOUT`, `APPROVAL_NOT_FOUND`,
`APPROVAL_FAILED`, `INTERNAL_ERROR`.

## Identifiers

| Id | Lifetime | Purpose |
| --- | --- | --- |
| `sessionId` | **Permanent** | The conversation. Jarvis keys its memory on this, so it must never be regenerated. Defaults to `session_<userId>`, or pin it with `DEFAULT_SESSION_ID`. |
| `chatId` | = `sessionId` | The name n8n sees. The Telegram-equivalent routing key. |
| `messageId` | One message | Carried unchanged to n8n and back; replies quote it as `replyTo`. |
| `connectionId` | One socket | A single device's current connection. Changes on every reconnect. |

`sessionId` is stable across reloads, reconnects, and devices — open the app on
your phone and your laptop and both land in the same conversation.

## Authentication

The token is checked during the WebSocket handshake; a bad token never reaches
the message loop. Three ways to present it, in priority order:

1. `Authorization: Bearer <token>` — Android, CLI, anything that can set headers.
2. `Sec-WebSocket-Protocol: bearer, <token>` — what the browser client uses,
   because browsers cannot set headers on a WebSocket and this keeps the token
   out of URLs and access logs.
3. `?token=<token>` — convenient for `curl` and quick tests.

## Message flow

```text
CLIENT                       GATEWAY                        n8n
  │── user.message ─────────────►│                            │
  │◄─ ack ──────────────────────│                            │
  │◄─ execution.started ────────│                            │
  │                              │── POST webhook ───────────►│
  │                              │◄─ reply ──────────────────│
  │◄─ assistant.message ────────│                            │
  │◄─ execution.completed ──────│                            │
```

In `async` mode the gateway returns immediately and n8n calls
`POST /api/push` when Jarvis finishes; the client sees the same events.

## HTTP endpoints

### `GET /health`

```json
{ "ok": true, "connections": 1, "pendingExecutions": 0,
  "authEnabled": true, "n8nConfigured": true, "responseMode": "sync" }
```

### `POST /api/push`

n8n → gateway → device. Requires the `x-gateway-secret` header (`PUSH_SECRET`).

```json
{
  "messageId": "msg_001",
  "chatId": "session_aman",
  "event": "assistant.message",
  "content": "Here is your answer."
}
```

Routing target, first match wins: `connectionId` → `sessionId`/`chatId` →
`userId`. If `messageId` matches an execution the gateway is waiting on, it
inherits that execution's routing and closes it out, so `messageId` alone is
enough. Any event name works — use `notification` for unprompted messages.

### Approvals over `POST /api/push`

Sending `event: "approval.request"` additionally requires `resumeUrl` (from
n8n's `{{ $execution.resumeUrl }}`). The gateway stores it, strips it, and sends
the client only an `approvalId` — a resume capability never reaches a browser.
The URL must start with `N8N_RESUME_URL_PREFIX` or the push is rejected with 400.
See [interactive.md](interactive.md).

Responds `{ "ok": true, "delivered": <n> }`. `delivered: 0` means nothing was
connected; the push is not queued.
