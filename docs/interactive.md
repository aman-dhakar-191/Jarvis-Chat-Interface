# Intermediate state, human-in-the-loop, and approvals

> There are two ways to build this. The **[community node](../n8n-node/README.md)**
> (`n8n-nodes-jarvis`) gives you real nodes and stores the push secret as a
> credential — nicer, but it needs installing. The HTTP Request + Wait approach
> below needs nothing and is proven end to end. Both drive the same gateway
> endpoints, so you can start with one and move to the other.

A plain request/response chat can only show a spinner while Jarvis works, and it
cannot ask you anything mid-run. The gateway supports both, because it holds a
socket the whole time and n8n can reach back into it.

Two mechanisms, and the difference matters:

| | Progress | Approval |
| --- | --- | --- |
| Direction | n8n → you | n8n → you → n8n |
| Blocks the workflow? | No | Yes, it parks |
| n8n side | HTTP Request | **Wait** node + HTTP Request |
| Use for | "Searching your email…" | "Send this email?" |

---

## 1. Progress updates

Any node, anywhere — including inside a subagent — can push a line to every
device in the session. Add an **HTTP Request** node wherever you want to report:

| Field | Value |
| --- | --- |
| Method | `POST` |
| URL | `https://jarvis.srv1918051.hstgr.cloud/api/push` |
| Headers | `x-gateway-secret: <PUSH_SECRET>` |
| Body (JSON) | see below |

```
={{ JSON.stringify({
  sessionId: $('Normalize Chat Input').first().json.sessionId,
  event: 'tool.started',
  content: 'Searching your email…'
}) }}
```

`event` may be `tool.started`, `tool.progress`, `tool.finished` or
`execution.progress` — the client renders any of them as a status line under the
typing indicator, replacing the previous one. It clears when the reply arrives.

Fire-and-forget: the workflow does not wait, and a failed push never breaks the
run. Use `notification` instead of a progress event to post a permanent chat
bubble rather than a transient line — that also works with no message in flight,
which is how a scheduled workflow pings your phone unprompted.

### Reaching the session id from a subagent

A sub-workflow cannot see `$('Normalize Chat Input')`. Pass `sessionId` down
through the subagent's own inputs (the Supervisor already does this — it
declares `sessionId` on its `When Called as Subworkflow` trigger), then use
`$json.sessionId`.

---

## 2. Approvals

The flow, and why it is shaped this way:

```text
Supervisor  ──► Wait node parks the execution, exposing $execution.resumeUrl
                     │
                     ▼
            HTTP Request → POST /api/push  { event: approval.request, resumeUrl }
                     │
                     ▼
            Gateway stores the resumeUrl, sends the phone only an approvalId
                     │
                     ▼
            Phone shows buttons; you tap one
                     │
                     ▼
            Gateway POSTs your answer to the stored resumeUrl
                     │
                     ▼
            Wait node resumes; the workflow continues with your decision
```

**The resume URL never leaves the gateway.** Anyone holding it can resume your
workflow, so the client only ever sees an opaque `approvalId`. The gateway also
refuses any resume URL that does not start with `N8N_RESUME_URL_PREFIX`
(defaulting to your n8n origin), so a mistyped or tampered workflow cannot turn
the gateway into an open relay.

### Building it in n8n

**Node 1 — Wait**

| Field | Value |
| --- | --- |
| Resume | `On webhook call` |
| HTTP Method | `POST` |
| Limit wait time | on — e.g. 1 hour, so a forgotten approval doesn't park forever |

If you have more than one Wait node in a workflow, set
**Options → Webhook Suffix** so their URLs differ.

**Node 2 — HTTP Request**, placed *before* the Wait node so the prompt goes out
while the Wait parks:

| Field | Value |
| --- | --- |
| Method | `POST` |
| URL | `https://jarvis.srv1918051.hstgr.cloud/api/push` |
| Headers | `x-gateway-secret: <PUSH_SECRET>` |

Body (JSON):

```
={{ JSON.stringify({
  sessionId: $('Normalize Chat Input').first().json.sessionId,
  event: 'approval.request',
  resumeUrl: $execution.resumeUrl,
  content: 'Send the follow-up email to the client?',
  data: { choices: [
    { value: 'approve', label: 'Send it' },
    { value: 'reject',  label: 'Cancel' }
  ] }
}) }}
```

Omit `choices` and you get Approve/Reject. Any number of choices works — they
render as buttons in order, and the one with `value: "approve"` is highlighted.

**After the Wait node**, your decision is on `$json`:

```
{{ $json.approved }}   // true / false
{{ $json.choice }}     // 'approve', 'reject', or your own value
{{ $json.comment }}    // optional free text, or null
{{ $json.userId }}     // who answered
{{ $json.respondedAt }}
```

Branch on it with an **IF** node: `{{ $json.approved }}` is boolean true.

### Behaviour worth knowing

- **Multi-device.** The prompt goes to every device in the session. The first
  answer wins; the others switch to "You chose: …" immediately.
- **Answered once.** A second tap gets `APPROVAL_NOT_FOUND` and the workflow is
  never resumed twice.
- **Survives reconnects.** Approvals are session-scoped, not tied to a socket —
  lock your phone, come back, and the buttons still work.
- **Expiry.** After `APPROVAL_TIMEOUT_MS` (default 1 hour) the gateway sends
  `approval.expired` and the card greys out. Set *Limit wait time* on the Wait
  node too, so n8n doesn't hold the execution open forever.
- **Restarts lose them.** Approvals are in memory. If the gateway restarts, the
  card stays until you tap it, then reports expired. The n8n side will time out
  via *Limit wait time*.

### Approving from somewhere else

The resume URL is an ordinary n8n webhook, so approving from a script is just:

```bash
curl -X POST "<the resumeUrl>" \
  -H 'content-type: application/json' \
  -d '{"approved":true,"choice":"approve"}'
```

That is exactly what the gateway does on your behalf.

---

## 3. Which one should Jarvis use?

Give the Supervisor the rule directly in its system prompt:

> Before any irreversible action — sending an email, deleting data, spending
> money, pushing code — park on the Wait node and ask for approval. For anything
> read-only, push a progress line instead and keep going.

The gateway does not decide this; it only carries whatever Jarvis chooses to
send. That keeps the policy where it belongs, in the Supervisor's prompt.
