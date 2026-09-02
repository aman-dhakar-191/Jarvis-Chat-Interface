# Wiring the gateway to your existing Jarvis workflow

Your Jarvis workflow does not change. You add a **new entry point** beside the
Telegram Trigger — a webhook that normalizes the incoming message into the same
shape Jarvis already receives. Telegram keeps working the whole time.

```text
Telegram Trigger ──┐
                   ├──► Normalize Chat Input ──► Existing Jarvis ──► reply
Jarvis Chat Webhook┘
```

## 1. Import the workflow

Two ready-to-import files:

| File | Use when |
| --- | --- |
| `n8n/jarvis-chat-sync.workflow.json` | **Start here.** n8n answers on the same HTTP request. |
| `n8n/jarvis-chat-async.workflow.json` | Jarvis takes longer than your HTTP timeout, or you want true full-duplex. |

In n8n: **Workflows → … → Import from File**.

Both arrive with five nodes:

```text
Jarvis Chat Webhook → Normalize Chat Input → Existing Jarvis Workflow
                    → Format Reply → Respond to Gateway / Push Reply to Gateway
```

**"Existing Jarvis Workflow" ships disabled on purpose.** A disabled n8n node
passes data straight through, so the workflow works end to end the moment you
import it and echoes your message back. That lets you prove the transport before
involving Jarvis at all.

## 2. Prove the transport works

Activate the workflow, copy the production webhook URL, and point the gateway at
it (`N8N_WEBHOOK_URL`). Send a message from the app — you should get your own
text echoed back. If that works, the whole chain
(phone → gateway → n8n → gateway → phone) is proven.

You can also test n8n on its own:

```bash
curl -X POST https://your-n8n/webhook/jarvis-chat \
  -H 'content-type: application/json' \
  -d '{"source":"custom_chat","userId":"aman","sessionId":"session_aman",
       "chatId":"session_aman","messageId":"msg_001","message":"Hello Jarvis"}'
```

## 3. Connect the real Jarvis

Open **Existing Jarvis Workflow**, pick your Jarvis workflow in the *Workflow*
field, and enable the node. If your Jarvis lives in the same workflow rather
than a sub-workflow, delete this node and wire **Normalize Chat Input** straight
into your Supervisor instead.

Jarvis receives:

```json
{
  "source": "custom_chat",
  "userId": "aman",
  "sessionId": "session_aman",
  "chatId": "session_aman",
  "messageId": "msg_001",
  "connectionId": "conn_…",
  "message": "Hello Jarvis",
  "content": "Hello Jarvis",
  "chatInput": "Hello Jarvis",
  "timestamp": "2026-08-31T06:30:00.000Z"
}
```

`message`, `content` and `chatInput` all hold the text, so whichever field your
existing nodes already reference keeps working. Point your memory node's session
key at `{{ $json.sessionId }}`.

## 4. Replying to the right chat

**Format Reply** puts the routing ids back on the response:

```json
{
  "reply": "Here is your answer.",
  "messageId": "msg_001",
  "replyTo": "msg_001",
  "chatId": "session_aman",
  "sessionId": "session_aman"
}
```

- **sync mode** — *Respond to Gateway* returns this as the HTTP response. The
  gateway matches it to the waiting request, so `messageId` is belt-and-braces.
- **async mode** — *Push Reply to Gateway* POSTs it to `/api/push`, and there the
  ids are what actually routes the message. `messageId` alone is enough; `chatId`
  reaches every device in that conversation.

The gateway is forgiving about the reply shape. It looks for `reply`, `output`,
`text`, `answer`, `response`, `message`, `content` or `result`, unwraps arrays
and `json`/`data`/`body` containers, and accepts a bare string. An AI Agent node's
`{"output": "…"}` works untouched. If your workflow buries the text somewhere
unusual, set `N8N_RESPONSE_PATH=some.deep.field` instead of reshaping n8n.

## 5. Async mode

Use it when Jarvis is slow enough to risk an HTTP timeout, or when you want n8n
to message you unprompted.

1. Import `jarvis-chat-async.workflow.json`.
2. In **Push Reply to Gateway**, set the URL to `https://your-gateway/api/push`
   and paste your `PUSH_SECRET` into the `x-gateway-secret` header.
3. Set `N8N_RESPONSE_MODE=async` on the gateway.

The webhook now returns `{"accepted":true}` immediately; the gateway holds the
execution open (up to `N8N_TIMEOUT_MS`) and delivers the reply when the push
arrives. If the push never comes, the client gets `EXECUTION_TIMEOUT` rather
than hanging.

### Unprompted messages

Once async is wired, any n8n workflow can reach your phone:

```bash
curl -X POST https://your-gateway/api/push \
  -H 'content-type: application/json' \
  -H 'x-gateway-secret: YOUR_PUSH_SECRET' \
  -d '{"chatId":"session_aman","event":"notification","content":"Your build finished."}'
```

This is the piece Telegram gave you for free, and the main reason the gateway
exists as a separate process.

## 6. Locking down the webhook

The gateway sends `x-jarvis-secret` when `N8N_WEBHOOK_SECRET` is set. To enforce
it, open **Normalize Chat Input** and set:

```js
const EXPECTED_SECRET = 'the same value as N8N_WEBHOOK_SECRET';
```

Requests without a matching header then fail the execution. Alternatively use
the Webhook node's built-in **Header Auth** with an n8n credential.

## Reusing the code nodes

If you would rather paste into a workflow you already have:

- `n8n/normalize-chat-input.js` — handles both the gateway payload **and** a
  Telegram Trigger item, emitting the same normalized shape either way. This is
  the adapter that lets one Jarvis serve both transports.
- `n8n/format-reply.js` — extracts the reply text and re-attaches
  `sessionId` / `chatId` / `messageId`.

Both are plain Code nodes set to *Run Once for All Items*.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `EXECUTION_FAILED: Jarvis returned no reply text` | The workflow has no *Respond to Webhook* node, or the webhook's Respond mode is not "Using Respond to Webhook node". |
| `N8N_UNAVAILABLE` | Wrong `N8N_WEBHOOK_URL`, or n8n unreachable from the gateway. |
| `EXECUTION_TIMEOUT` | Jarvis took longer than `N8N_TIMEOUT_MS` — raise it, or switch to async mode. |
| Reply arrives but Jarvis has no memory | The memory node is not keyed on `{{ $json.sessionId }}`. |
| Works from `curl`, not the app | Test URL vs production URL — the workflow must be **Active** for the production path. |
