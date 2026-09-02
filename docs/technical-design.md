# Jarvis Full-Duplex Custom Chat — Technical Design

## 1. Purpose

Replace Telegram as the current Jarvis entry point with a custom Android/Web chat application using a persistent, full-duplex WebSocket connection.

The existing Jarvis system inside n8n is already working. Therefore, this design does **not** redesign the Supervisor, memory, skills, MCP, tools, or AI orchestration.

The primary requirement is:

> Build a custom real-time chat entry point that can connect to the existing n8n Jarvis workflow.

Current:

```text
User
  ↓
Telegram
  ↓
Telegram Trigger
  ↓
Existing Jarvis n8n Workflow
```

Target:

```text
User
  ↓
Android / Web Chat
  ↕
WebSocket
  ↕
Jarvis Gateway
  ↓
n8n Jarvis Entry Point
  ↓
Existing Jarvis Workflow
```

---

# 2. Scope

## In scope

- Custom Web chat client
- Custom Android chat client
- Persistent WebSocket connection
- Full-duplex communication
- Authentication
- Session identification
- Message/event protocol
- Jarvis Gateway
- Connection between Gateway and existing n8n workflow
- Streaming responses
- Reconnection
- Message acknowledgements
- Cancellation/interruption
- Replacing Telegram as the input/output transport

## Out of scope

The following are already implemented in Jarvis/n8n and should remain unchanged:

- Supervisor
- Long-term memory
- Session memory/state
- Skills
- MCP
- LLM orchestration
- Existing tools
- Existing business logic
- Existing n8n subworkflows

---

# 3. Current Architecture

The current system uses Telegram as the external communication layer.

```text
┌──────────────┐
│    User      │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Telegram   │
└──────┬───────┘
       │
       ▼
┌──────────────────┐
│ Telegram Trigger │
│      (n8n)       │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Existing Jarvis  │
│    Workflow      │
│                  │
│ Supervisor       │
│ Memory           │
│ Skills           │
│ MCP              │
│ Tools            │
└────────┬─────────┘
         │
         ▼
┌──────────────┐
│   Telegram   │
└──────────────┘
```

Telegram is currently acting as the **transport and entry point**.

The goal is to replace only this transport layer.

---

# 4. Target Architecture

```text
                         ┌─────────────────┐
                         │    Web Client   │
                         └────────┬────────┘
                                  │
                                  │ WSS
                                  │
                         ┌────────▼────────┐
                         │ Android Client  │
                         └────────┬────────┘
                                  │
                                  │ WSS
                                  ▼
                       ┌──────────────────────┐
                       │    Jarvis Gateway    │
                       │                      │
                       │ WebSocket Server     │
                       │ Authentication       │
                       │ Connection Manager   │
                       │ Session Routing      │
                       │ Event Routing        │
                       └──────────┬───────────┘
                                  │
                                  │ HTTP/Webhook
                                  ▼
                       ┌──────────────────────┐
                       │         n8n          │
                       │                      │
                       │  Jarvis Entry Point  │
                       │          ↓           │
                       │  Existing Workflow  │
                       │                      │
                       │  Supervisor          │
                       │  Memory              │
                       │  Skills              │
                       │  MCP                 │
                       │  Tools               │
                       └──────────────────────┘
```

The **Jarvis Gateway owns the WebSocket connection**.

n8n remains the existing Jarvis orchestration engine.

---

# 5. Why a Gateway Is Needed

The custom Android/Web application should not communicate directly with n8n's internal workflow execution model.

Instead:

```text
Client
  ↕
WebSocket
  ↕
Jarvis Gateway
  ↓
n8n
```

The Gateway is responsible for real-time communication.

n8n is responsible for processing the request.

This keeps the responsibilities separated.

## Gateway responsibilities

- Maintain WebSocket connections
- Authenticate clients
- Identify users
- Identify sessions
- Receive client events
- Send Jarvis events to clients
- Handle reconnections
- Route events
- Handle acknowledgements
- Handle cancellation
- Translate between WebSocket events and n8n requests

## n8n responsibilities

No major architectural change is required.

n8n continues to handle:

- Supervisor
- Memory
- Skills
- MCP
- Tools
- LLM
- Existing workflows
- Existing Jarvis logic

---

# 6. Full-Duplex Requirement

The connection must be persistent and bidirectional.

A request/response-only architecture is not sufficient.

### Request/response model

```text
Client
  │
  │ request
  ▼
Server
  │
  │ response
  ▼
Client
```

### Required full-duplex model

```text
Client                         Jarvis
  │                              │
  │──── user.message ──────────►│
  │                              │
  │◄──── execution.started ─────│
  │                              │
  │◄──── tool.started ───────────│
  │                              │
  │◄──── assistant.chunk ────────│
  │                              │
  │──── execution.cancel ───────►│
  │                              │
  │◄──── execution.cancelled ────│
  │                              │
  │◄──── notification ───────────│
```

Either side must be able to send events independently.

---

# 7. WebSocket

Use a secure WebSocket connection in production:

```text
wss://api.example.com/ws
```

Development:

```text
ws://localhost:8000/ws
```

The WebSocket connection remains open while the application is connected.

---

# 8. Connection Lifecycle

```text
                  ┌─────────────┐
                  │ Disconnected│
                  └──────┬──────┘
                         │
                         │ connect
                         ▼
                  ┌─────────────┐
                  │ Connecting  │
                  └──────┬──────┘
                         │
                         │ authenticate
                         ▼
                  ┌─────────────┐
                  │ Authenticated│
                  └──────┬──────┘
                         │
                         │ session.join
                         ▼
                  ┌─────────────┐
                  │   Active    │
                  └──────┬──────┘
                         │
                    connection lost
                         │
                         ▼
                  ┌─────────────┐
                  │ Reconnecting│
                  └──────┬──────┘
                         │
                         └──────────► Active
```

---

# 9. Authentication

Authentication should occur when establishing the WebSocket connection.

Example:

```http
GET /ws
Authorization: Bearer <ACCESS_TOKEN>
```

The Gateway validates the token.

The Gateway derives the authenticated identity from the token.

The client must not be allowed to impersonate another user by simply sending:

```json
{
  "userId": "another-user"
}
```

The Gateway should establish:

```text
authenticatedUserId
deviceId
connectionId
permissions
```

---

# 10. Session Model

Jarvis already uses session concepts.

The custom chat application should send a stable `sessionId`.

Example:

```json
{
  "sessionId": "session_123"
}
```

The session represents the conversation/context being used by Jarvis.

Conceptually:

```text
User
 │
 ├── Session A
 │    ├── Messages
 │    ├── Session state
 │    └── Active skills/state
 │
 └── Session B
      ├── Messages
      ├── Session state
      └── Active skills/state
```

The Gateway should pass the session ID unchanged to the existing n8n Jarvis workflow.

---

# 11. Connection ID

Every WebSocket connection should have its own `connectionId`.

Example:

```text
conn_001
conn_002
conn_003
```

This allows multiple devices to connect.

Example:

```text
User
 │
 ├── Web Browser
 │      └── conn_001
 │
 ├── Android
 │      └── conn_002
 │
 └── Laptop
        └── conn_003
```

---

# 12. Event Protocol

All messages should use a common event envelope.

Example:

```json
{
  "id": "evt_001",
  "type": "event",
  "event": "user.message",
  "timestamp": "2026-08-29T16:30:00.000Z",
  "sessionId": "session_123",
  "data": {}
}
```

## Required fields

| Field | Description |
|---|---|
| `id` | Unique event ID |
| `type` | Message category |
| `event` | Specific event name |
| `timestamp` | Event timestamp |
| `sessionId` | Associated Jarvis session |
| `data` | Event-specific payload |

---

# 13. Message Types

Initial protocol:

```text
Connection
├── connection.ping
├── connection.pong
└── connection.close

Session
├── session.join
└── session.leave

Message
├── user.message
├── assistant.message
├── assistant.chunk
└── message.cancel

Execution
├── execution.started
├── execution.completed
├── execution.cancelled
└── execution.failed

Tool
├── tool.started
├── tool.progress
└── tool.finished

Skill
├── skill.loaded
├── skill.unloaded
└── skill.updated

Memory
├── memory.created
├── memory.updated
└── memory.deleted

System
├── notification
└── error
```

The first implementation does not need to support every event.

Start with:

```text
connection
session.join
user.message
assistant.message
assistant.chunk
error
ping/pong
```

---

# 14. User Message

The client sends:

```json
{
  "id": "evt_001",
  "type": "event",
  "event": "user.message",
  "timestamp": "2026-08-29T16:30:00.000Z",
  "sessionId": "session_123",
  "data": {
    "messageId": "msg_001",
    "content": "Hello Jarvis"
  }
}
```

The Gateway validates the event and forwards the relevant data to n8n.

---

# 15. Gateway → n8n

The Gateway should convert the WebSocket event into the input expected by the existing Jarvis workflow.

For example:

```json
{
  "source": "custom_chat",
  "userId": "authenticated_user",
  "sessionId": "session_123",
  "messageId": "msg_001",
  "content": "Hello Jarvis"
}
```

The existing n8n workflow can then continue using the existing Supervisor architecture.

The objective is to make this new payload equivalent to the data currently supplied by Telegram.

---

# 16. n8n Entry Point

The current Telegram Trigger should be replaced or supplemented by a custom entry point.

Recommended initial approach:

```text
Jarvis Gateway
       │
       │ POST
       ▼
┌──────────────────┐
│ n8n Webhook      │
│ Jarvis Chat      │
└────────┬─────────┘
         │
         ▼
Existing Jarvis Workflow
```

The n8n side should remain as simple as possible.

The Webhook should act as the new **transport adapter**.

---

# 17. Existing n8n Workflow

The desired structure is:

```text
┌────────────────────────┐
│ Jarvis Chat Webhook    │
│       NEW ENTRY        │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│ Normalize Chat Input   │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│ Existing Jarvis        │
│ Workflow               │
│                        │
│ Supervisor             │
│ Memory                 │
│ Skills                 │
│ MCP                    │
│ Tools                  │
└───────────┬────────────┘
            │
            ▼
      Jarvis Response
```

The existing logic should not need to know whether the message originated from:

```text
Telegram
Web
Android
```

The entry-point adapter should normalize the input.

---

# 18. Response Path

The response path is:

```text
n8n
 │
 │ Jarvis response
 ▼
Jarvis Gateway
 │
 │ WebSocket
 ▼
Client
```

Example Gateway event:

```json
{
  "id": "evt_002",
  "type": "event",
  "event": "assistant.message",
  "timestamp": "2026-08-29T16:31:00.000Z",
  "sessionId": "session_123",
  "data": {
    "messageId": "msg_002",
    "content": "Hello. How can I help?"
  }
}
```

---

# 19. Full-Duplex Example

```text
CLIENT                         GATEWAY                       n8n
  │                               │                           │
  │── user.message ──────────────►│                           │
  │                               │── webhook ───────────────►│
  │                               │                           │
  │                               │                           │
  │                               │◄──── processing ─────────│
  │◄── execution.started ─────────│                           │
  │                               │                           │
  │                               │◄──── response ───────────│
  │◄── assistant.chunk ───────────│                           │
  │◄── assistant.chunk ───────────│                           │
  │◄── assistant.message ─────────│                           │
  │                               │                           │
```

For asynchronous events:

```text
n8n / Jarvis
      │
      ▼
Gateway
      │
      │ WebSocket event
      ▼
Client
```

The client does not need to request those events first.

---

# 20. Streaming

For a ChatGPT-like experience, responses should support streaming.

Example:

```json
{
  "event": "assistant.chunk",
  "sessionId": "session_123",
  "data": {
    "messageId": "msg_002",
    "sequence": 1,
    "content": "Hello"
  }
}
```

Then:

```json
{
  "event": "assistant.chunk",
  "sessionId": "session_123",
  "data": {
    "messageId": "msg_002",
    "sequence": 2,
    "content": " Aman"
  }
}
```

The client reconstructs the final response.

If the current n8n workflow only returns a final response, streaming can be added later.

---

# 21. Sequence Numbers

Streaming events should include:

```text
messageId
sequence
```

Example:

```text
msg_002 / 1
msg_002 / 2
msg_002 / 3
msg_002 / 4
```

This allows the client to detect missing events.

---

# 22. Acknowledgements

Important client events can be acknowledged.

Client:

```json
{
  "id": "evt_001",
  "type": "event",
  "event": "user.message",
  "sessionId": "session_123",
  "data": {
    "messageId": "msg_001",
    "content": "Hello"
  }
}
```

Gateway:

```json
{
  "type": "ack",
  "eventId": "evt_001",
  "status": "accepted"
}
```

This confirms that the Gateway accepted the event.

---

# 23. Reconnection

The client must reconnect automatically when the WebSocket connection is lost.

```text
Connected
    │
    X
    │
    ▼
Connection lost
    │
    ▼
Wait
    │
    ▼
Reconnect
    │
    ▼
Authenticate
    │
    ▼
session.join
    │
    ▼
Resume
```

Use exponential backoff:

```text
1 sec
2 sec
4 sec
8 sec
16 sec
...
```

with a reasonable maximum.

---

# 24. Heartbeat

The Gateway and client should maintain a heartbeat.

```text
Gateway ─── ping ───► Client
Gateway ◄── pong ──── Client
```

If the connection becomes unresponsive, the Gateway can close it.

The client then reconnects.

---

# 25. Cancellation

Full-duplex communication allows the user to interrupt Jarvis.

Example:

```text
User
 │
 │ "STOP"
 ▼
Client
 │
 │ execution.cancel
 ▼
Gateway
 │
 ▼
n8n / execution layer
```

Example:

```json
{
  "type": "command",
  "event": "execution.cancel",
  "sessionId": "session_123",
  "data": {
    "executionId": "exec_001"
  }
}
```

Cancellation support depends on how the existing n8n execution is exposed and should be implemented after the basic communication path works.

---

# 26. Error Protocol

Errors should use a standard format.

```json
{
  "id": "evt_error_001",
  "type": "error",
  "event": "error",
  "sessionId": "session_123",
  "data": {
    "code": "INVALID_MESSAGE",
    "message": "Message content is required"
  }
}
```

Recommended error codes:

```text
AUTH_FAILED
INVALID_MESSAGE
INVALID_SESSION
SESSION_NOT_FOUND
RATE_LIMITED
N8N_UNAVAILABLE
EXECUTION_FAILED
EXECUTION_CANCELLED
INTERNAL_ERROR
```

---

# 27. Security

Production communication should use:

```text
HTTPS
WSS
```

Required protections:

- Authentication
- Authorization
- Token expiration
- Input validation
- Rate limiting
- Maximum message size
- Session authorization
- Origin validation for Web clients
- Secure secret management

---

# 28. Attachments

Large files should not normally be sent through the WebSocket.

Preferred architecture:

```text
Client
  │
  │ upload
  ▼
Upload API / Object Storage
  │
  ▼
fileId / metadata
  │
  ▼
WebSocket
  │
  ▼
n8n
```

Example:

```json
{
  "event": "user.message",
  "sessionId": "session_123",
  "data": {
    "content": "Analyze this image",
    "attachments": [
      {
        "id": "file_123",
        "mimeType": "image/png"
      }
    ]
  }
}
```

---

# 29. Suggested Gateway Technology

A small Python service is sufficient.

Recommended:

```text
Python
FastAPI
WebSocket
Redis
```

Basic architecture:

```text
jarvis-gateway/
│
├── app/
│   ├── main.py
│   │
│   ├── websocket/
│   │   ├── manager.py
│   │   ├── connection.py
│   │   └── handlers.py
│   │
│   ├── auth/
│   │   └── service.py
│   │
│   ├── sessions/
│   │   └── manager.py
│   │
│   ├── events/
│   │   ├── models.py
│   │   └── router.py
│   │
│   └── n8n/
│       └── client.py
│
├── tests/
├── Dockerfile
└── requirements.txt
```

---

# 30. n8n Integration Strategy

The simplest initial integration is:

```text
WebSocket
    │
    ▼
Jarvis Gateway
    │
    │ HTTP POST
    ▼
n8n Webhook
    │
    ▼
Existing Jarvis Workflow
```

The Gateway can call the n8n Webhook using a normalized payload.

Example:

```json
{
  "source": "custom_chat",
  "userId": "user_123",
  "sessionId": "session_123",
  "messageId": "msg_001",
  "message": "Hello Jarvis"
}
```

The existing workflow should process this the same way it currently processes the Telegram input.

---

# 31. Response Integration

There are two possible initial designs.

## Option A — Synchronous response

```text
Gateway
   │
   │ POST
   ▼
n8n
   │
   │ HTTP response
   ▼
Gateway
   │
   │ WebSocket
   ▼
Client
```

This is the easiest MVP.

## Option B — Asynchronous response

```text
Gateway
   │
   │ start execution
   ▼
n8n
   │
   │ event/callback
   ▼
Gateway
   │
   │ WebSocket
   ▼
Client
```

This is preferable for a true full-duplex architecture.

Start with Option A if the current Jarvis workflow naturally returns a response. Move to Option B when asynchronous events and streaming are required.

---

# 32. Important n8n Design Principle

Do not rewrite the existing Jarvis logic to support the custom app.

Instead create an **input/output adapter**.

```text
                 Transport Layer

Telegram ────────┐
                 │
WebSocket ───────┼──► Normalize Input ──► Jarvis
                 │
Android ─────────┘
```

The Jarvis core should receive a consistent structure regardless of source.

For example:

```json
{
  "source": "web",
  "userId": "user_123",
  "sessionId": "session_123",
  "messageId": "msg_001",
  "message": "Hello"
}
```

---

# 33. Recommended Migration

Do not immediately remove Telegram.

Run both entry points during development.

```text
                    ┌── Telegram Trigger ──┐
                    │                      │
                    │                      ▼
User ── Telegram ───┘                Normalize Input
                                           │
Web ── WebSocket ── Gateway ── n8n ────────┤
                                           │
Android ─────────── Gateway ───────────────┘
                                           │
                                           ▼
                                   Existing Jarvis
```

Once the custom application is stable:

```text
Telegram
   │
   X
   │
   removed
```

---

# 34. MVP Development Plan

## Phase 1 — WebSocket Gateway

Implement:

```text
WebSocket server
connection management
ping/pong
basic authentication
```

Test:

```text
Browser ↔ Gateway
```

---

## Phase 2 — n8n Connection

Implement:

```text
Gateway
   ↓
n8n Webhook
```

Test:

```text
Browser
   ↓
WebSocket
   ↓
Gateway
   ↓
n8n
   ↓
Existing Jarvis
```

---

## Phase 3 — Response

Implement:

```text
n8n
 ↓
Gateway
 ↓
WebSocket
 ↓
Browser
```

At this point Telegram can already be replaced for basic chat.

---

## Phase 4 — Session Support

Add:

```text
userId
sessionId
messageId
connectionId
```

Integrate with the existing Jarvis session architecture.

---

## Phase 5 — Full-Duplex Events

Add:

```text
assistant.chunk
execution.started
execution.completed
tool.started
tool.finished
notification
message.cancel
```

---

## Phase 6 — Reliability

Add:

```text
acknowledgements
reconnection
event sequence numbers
duplicate detection
event replay
```

---

## Phase 7 — Android

Use the same protocol:

```text
Android
   ↕
WSS
   ↕
Jarvis Gateway
```

No separate backend protocol should be created for Android.

---

# 35. Final Architecture

```text
                           ┌─────────────────┐
                           │    Web Client   │
                           └────────┬────────┘
                                    │
                                    │ WSS
                                    │
                           ┌────────▼────────┐
                           │ Android Client  │
                           └────────┬────────┘
                                    │
                                    │ WSS
                                    ▼
                         ┌─────────────────────┐
                         │   JARVIS GATEWAY    │
                         │                     │
                         │ WebSocket Server    │
                         │ Authentication      │
                         │ Connection Manager  │
                         │ Session Routing     │
                         │ Event Router        │
                         │ Streaming           │
                         │ Reconnection        │
                         └──────────┬──────────┘
                                    │
                                    │ HTTP
                                    ▼
                         ┌─────────────────────┐
                         │        n8n          │
                         │                     │
                         │  Jarvis Entry Point │
                         │          ↓          │
                         │  Existing Jarvis    │
                         │                     │
                         │  Supervisor         │
                         │  Memory             │
                         │  Skills             │
                         │  MCP                │
                         │  Tools              │
                         └─────────────────────┘
```

# 36. Final Design Decision

The existing Jarvis implementation in n8n is treated as the **core processing engine**.

Only the current Telegram transport/trigger needs to be replaced.

The target architecture is therefore:

```text
CURRENT

Telegram
   ↓
Telegram Trigger
   ↓
Jarvis


TARGET

Android/Web
    ↕
WebSocket
    ↕
Jarvis Gateway
    ↓
n8n Webhook / Entry Point
    ↓
Existing Jarvis
```

The first implementation should focus on only this path:

```text
Web App
   ↕
WebSocket
   ↕
FastAPI Gateway
   ↓
n8n Webhook
   ↓
Existing Jarvis
   ↓
Gateway
   ↕
Web App
```

Once this works reliably, add streaming, cancellation, notifications, multi-device support, event replay, and the Android client.
