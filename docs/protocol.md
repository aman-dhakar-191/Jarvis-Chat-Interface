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
| `user.message` | `{ messageId?, content, useTestWebhook? }` | `content` is required, ≤ 8000 chars. A `messageId` is generated if omitted. `useTestWebhook: true` routes just this message to n8n's `/webhook-test/` path. |
| `connection.ping` | anything | Answered with `connection.pong`. |
| `approval.respond` | `{ approvalId, choice?, text?, comment? }` | Answers a human-in-the-loop prompt; the gateway resumes the parked n8n execution. Send `choice` for a decision, `text` for a question. |
| `voice.session.start` | `{ mode? }` | Opens a voice session. Requires `VOICE_ENABLED=true`. `mode` is `ptt` (default) or `open`; anything else falls back to `ptt`. Starting twice replaces the first. |
| `voice.session.end` | `{ voiceSessionId }` | Idempotent. Disconnecting does the same thing. |
| `voice.activity.start` | `{ voiceSessionId }` | Push-to-talk pressed. In `ptt` mode the engine's own VAD is off, so this marks the start of a turn. Ignored in `open` mode. |
| `voice.activity.end` | `{ voiceSessionId }` | Released. Marks the end of the turn. Ignored in `open` mode. |

A client **cannot** set its own `userId`. Identity comes from the token
presented at the handshake; anything you put in `data.userId` is ignored.

## Gateway → Client

| Event | `data` |
| --- | --- |
| `connection.ready` | `{ connectionId, userId, defaultSessionId, responseMode, authEnabled, testWebhookAvailable }` |
| `session.joined` | `{ connectionId, userId }` |
| `execution.started` | `{ messageId }` |
| `assistant.message` | `{ messageId, replyTo, content }` |
| `execution.completed` | `{ messageId, durationMs? }` |
| `execution.failed` | `{ messageId, code, message }` |
| `notification` | `{ content, … }` — unprompted, no request needed |
| `tool.started` / `tool.progress` / `execution.progress` | `{ content }` — transient status while Jarvis works; each replaces the last |
| `tool.finished` | `{ content }` — the step is over; clears the status line |
| `approval.request` | `{ approvalId, content, inputType: 'choice' \| 'text', choices?, placeholder? }` |
| `approval.resolved` | `{ approvalId, choice, answer, by }` — also when another device answered |
| `approval.expired` | `{ approvalId }` |
| `error` | `{ code, message, messageId? }` |
| `connection.pong` | `{ echo }` |
| `voice.session.started` | `{ voiceSessionId, inputSampleRate, outputSampleRate, frameMs, engine, mode, expiresAt }` |
| `voice.transcript` | `{ voiceSessionId, role, text, final }` |
| `voice.interrupted` | `{ voiceSessionId }` — **drop buffered playback immediately** |
| `voice.turn.complete` | `{ voiceSessionId }` |
| `voice.engine.reconnected` | `{ voiceSessionId, resumed }` — upstream was replaced; the user should hear nothing |
| `voice.session.ended` | `{ voiceSessionId, reason }` — `client`, `expired`, `flood`, `replaced` or `disconnected` |
| `voice.error` | `{ code, message, voiceSessionId? }` |

## Voice audio frames

Audio does not travel as JSON. While a voice session is open, **binary**
WebSocket frames on the same connection carry PCM16:

```text
byte  0      frame type   0x01 client mic audio, 0x02 assistant audio
bytes 1..4   uint32 BE    sequence number, per direction
bytes 5..    PCM16 LE, mono, at the session's sampleRate
```

Base64-in-JSON would cost ~33% bandwidth and a parse every 20 ms, which is the
wrong trade on a stream that runs for minutes. The sequence number is not used
for reordering — a WebSocket is ordered — but it makes drops and duplicates
visible in logs.

**The two rates differ.** Gemini takes 16 kHz and returns 24 kHz, so
`voice.session.started` reports `inputSampleRate` and `outputSampleRate`
separately. Treating them as one value sounds like chipmunk audio in whichever
direction is wrong. The client learns both rather than hard-coding them, so
changing engines does not require a client release.

`engine: "echo"` means the gateway is mirroring your microphone back with no
model attached (`VOICE_PROVIDER=echo`). It is the quickest way to tell a broken
browser audio pipeline from a broken model connection.

## Voice and approvals

Human-in-the-loop approvals are rendered in the chat transcript, which
full-screen voice mode covers. When an `approval.request` arrives during a
voice session the client **minimises voice rather than ending it** — the
session, socket and audio graph all keep running, and the overlay shrinks to a
corner so the approval can be read and answered underneath. It restores when
the approval resolves or expires, but only if it minimised itself: a user who
minimised deliberately is not yanked back.

Nothing about the approval protocol changes. `approval.request`,
`approval.respond` and `approval.resolved` behave exactly as they do for text,
and the answer may come from either channel.

## Turn-taking modes

`ptt` — push-to-talk. The client owns the turn edges via `voice.activity.*` and
the engine's own detection is disabled, so silence never reaches the model.
That matters on a tier billed by session time.

`open` — always listening. The microphone stays live while the assistant is
speaking and the engine detects turns itself. This is the only mode with
genuine barge-in: the user interrupts by speaking, without pressing anything.
It is also the mode where echo cancellation becomes load-bearing — on speakers
rather than headphones, the assistant hears itself and interrupts its own turn.

The mode is fixed for the life of a session, because it changes how the engine
is configured upstream.

The upstream engine connection is capped at roughly 10 minutes. The gateway
re-establishes it with a session-resumption handle and emits
`voice.engine.reconnected`; the conversation continues and the user should hear
nothing. See `docs/voice-design.md`.

Binary frames sent with no open voice session are dropped silently: that is the
expected shape of a race between `voice.session.end` and frames already in
flight.

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
