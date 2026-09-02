# Extending the Jarvis nodes

How to add nodes, trigger nodes and credentials to this package later, and how
to get the result back into your n8n.

## Layout

One integration, one action node, with each action's implementation and fields
in their own module. This mirrors n8n's own Telegram node, which keeps
`Telegram.node.ts` beside a `hitl/` directory holding the send-and-wait
descriptions, setup and webhook.

```text
n8n-node/
├── package.json                    the `n8n` key lists what n8n loads
├── credentials/
│   └── JarvisGatewayApi.credentials.ts
├── nodes/Jarvis/
│   ├── Jarvis.node.ts              the action node: routes to an operation
│   ├── JarvisTrigger.node.ts       trigger node, starts a workflow
│   ├── normalize.ts                gateway/Telegram payload → one shape
│   ├── operations/                 what each action does
│   │   ├── notification.operation.ts
│   │   ├── progress.operation.ts
│   │   └── humanReview.operation.ts   execute() + webhook(), parks and resumes
│   ├── descriptions/               the fields each action shows
│   │   ├── notification.ts
│   │   ├── progress.ts
│   │   └── humanReview.ts
│   ├── common/
│   │   ├── gateway.ts              getPushUrl() + pushEvent()
│   │   ├── helpers.ts              requireSession()
│   │   └── types.ts                JarvisEvent, ApprovalChoice, ApprovalRequest
│   └── jarvis.svg                  icon, copied to dist by scripts/copy-icons.js
└── test.js                         structural checks on the built package
```

Anything new must be registered in `package.json`, or n8n will never see it:

```json
"n8n": {
  "n8nNodesApiVersion": 1,
  "credentials": ["dist/credentials/JarvisGatewayApi.credentials.js"],
  "nodes": [
    "dist/nodes/Jarvis/Jarvis.node.js",
    "dist/nodes/Jarvis/JarvisTrigger.node.js"
  ]
}
```

## Talking to the gateway

Never build the URL or the auth header in a node. `common/gateway.ts` owns both:

```ts
const pushUrl = await getPushUrl(this);          // once per execute()
await pushEvent(this, pushUrl, { sessionId, event, content });
```

`pushEvent` goes through `httpRequestWithAuthentication` with the
`jarvisGatewayApi` credential, so the `x-gateway-secret` header comes from the
credential and never from a node parameter. Validate the session with
`requireSession(this, value, itemIndex)` from `common/helpers.ts` so every node
fails the same way on an empty `sessionId`.

## The three kinds of node

| Kind | Implements | Use for |
| --- | --- | --- |
| **Action** | `execute()` | Doing something and returning data. Send Progress and Send Notification are ones. |
| **Trigger (webhook)** | `webhook()`, `group: ['trigger']`, `inputs: []` | Starting a workflow when something arrives. `Jarvis Trigger` is one. |
| **Action that waits** | `execute()` + `webhook()` + `restartWebhook` | Parking until a human answers. Send and Wait for Approval is one. |

A trigger and a waiting action both declare a `webhook`, but they are not the
same thing: only the waiting action sets `restartWebhook: true`, which is what
makes n8n expose `$execution.resumeUrl` and resume a parked execution rather
than start a new one.

## Adding an action

Add an operation to the existing node - not a new node type. The node creator
lists each operation's `action` separately, so a new action appears in the
picker on its own without becoming another node the user has to find.

1. Add it to the `operation` options in `Jarvis.node.ts`:

   ```ts
   {
     name: 'Clear Chat',
     value: 'clearChat',
     description: 'Wipe the transcript shown on the device',
     action: 'Clear chat',
   },
   ```

2. Put its fields in `descriptions/clearChat.ts`, each gated on the operation,
   and spread them into the node's `properties`:

   ```ts
   export const clearChatDescription: INodeProperties[] = [
     {
       displayName: 'Confirm',
       name: 'confirm',
       type: 'boolean',
       default: false,
       displayOptions: { show: { operation: ['clearChat'] } },
     },
   ];
   ```

3. Put the work in `operations/clearChat.operation.ts`, exporting an `execute`
   with the same shape as the other per-item operations:

   ```ts
   export async function execute(
     this: IExecuteFunctions,
     itemIndex: number,
     sessionId: string,
     pushUrl: string,
   ): Promise<INodeExecutionData> { … }
   ```

   The node owns the item loop, the session validation and `continueOnFail`, so
   an operation module only builds its body and pushes it.

4. Dispatch to it in `Jarvis.node.ts`.

5. Extend `test.js` - the existing checks already assert that every
   `displayOptions` rule names a real operation, that each operation can reach
   the fields it needs, and that the wait controls stay on `sendAndWait` only.

## Adding a trigger node

Use `JarvisTrigger.node.ts` as the template. The essentials:

```ts
group: ['trigger'],
inputs: [],                       // a trigger has none
outputs: ['main'] as INodeTypeDescription['outputs'],
webhooks: [{
  name: 'default',
  httpMethod: 'POST',
  responseMode: '={{$parameter["responseMode"]}}',
  path: '={{$parameter["path"]}}',
}],
```

and a `webhook()` returning `{ workflowData: [[{ json: … }]] }`.

Then add the compiled path to `package.json`'s `n8n.nodes`.

For a trigger that is **not** webhook-driven, implement `poll()` with
`polling: true` (n8n calls it on a schedule), or `trigger()` for a long-lived
connection such as a WebSocket client. A `trigger()` implementation must return
a `closeFunction` so n8n can tear the connection down.

## Adding an action that waits for a human

Follow `operations/humanReview.operation.ts`:

```ts
webhooks: [{ name: 'default', httpMethod: 'POST',
             responseMode: 'onReceived', path: '', restartWebhook: true }],
```

```ts
const resumeUrl = this.evaluateExpression('{{ $execution.resumeUrl }}', 0) as string;
this.setMetadata({ resumeUrl });         // editor shows the waiting tooltip
// … send resumeUrl somewhere that can call it back …
await this.putExecutionToWait(WAIT_INDEFINITELY);   // or a Date
return [items];
```

Resuming re-enters through `webhook()`, whose `workflowData` becomes the node's
output. Keep `group: ['output']` and `inputs: ['main']`: a waiting node is an
action, and turning it into a trigger would start a new execution on every
resume instead of continuing the parked one.

### The AI Agent HITL tool

n8n — not this package — generates the Human-in-the-Loop tool variant
(`jarvisHitlTool`) that an AI Agent connects to. It does that by scanning node
descriptions for an `operation` option whose value is exactly `sendAndWait`
(exported as `SEND_AND_WAIT_OPERATION` by `n8n-workflow`), and it carries over
the `message` and `approvalOptions` properties onto the generated tool.

Renaming that operation, or changing its value, silently removes the node from
the agent's tool list.

It is also kept **out** of the node creator's Actions list, because approval is
only meaningful under an agent. That is done by naming the option `*`:
`useActionsGeneration.ts` builds the Actions list with

```ts
options.filter((item) => !['*', '', ' '].includes(item.name))
```

so the operation stays in the description - and keeps generating the tool -
without being offered as something to drop onto a canvas. Note that dropping the
option's `action` property does **not** hide it; that field only supplies the
label, falling back to `startCase(item.name)`.

Whether a call waits is decided per invocation by the agent, through a
`$fromAI()` default on `approvalRequired`. `$fromAI(key, description, type)`
lets the model fill a node parameter when it calls the tool; the description is
prompt text, so it is written for the model. Resolving it fails outside a tool
context, so the operation catches that and defaults to asking for approval -
never to skipping it. `Message` is also deliberately **not** gated on the
operation: the generated tool replaces that property with its own HITL-aware
version, and a `displayOptions` rule naming `operation` would depend on a field
the variant may not carry. Its default references `$tool.name` and
`$tool.parameters`, which only resolve inside the generated tool; the operation
falls back to evaluating them directly, so it also works when wired by hand.

**Declare exactly one output.** n8n fires only the first output of a
webhook-wait node ([n8n#12823](https://github.com/n8n-io/n8n/issues/12823)), so
a two-output approve/reject node would silently half-work. Branch downstream
with an IF instead.

## Adding a credential

Copy `JarvisGatewayApi.credentials.ts`. Use `authenticate` so the secret is
injected as a header rather than read in node code, and give it a `test` request
so the **Test** button works:

```ts
authenticate: IAuthenticateGeneric = {
  type: 'generic',
  properties: { headers: { 'x-gateway-secret': '={{$credentials.pushSecret}}' } },
};
test: ICredentialTestRequest = {
  request: { baseURL: '={{$credentials.baseUrl}}', url: '/health', method: 'GET' },
};
```

Nodes then call it with `this.helpers.httpRequestWithAuthentication.call(this, 'jarvisGatewayApi', {…})`
and never touch the secret.

## Build, test, reinstall

```bash
cd /docker/jarvis/n8n-node
npm run typecheck
npm test                      # builds, then checks the built package
```

A Docker-only host has no npm, so build there in a container:

```bash
docker run --rm -v "$PWD":/src -w /src node:22-alpine \
  sh -c 'npm install && npm run build && npm pack'
```

Then reinstall. **Bump `version` in `package.json` first** — npm will not
replace an already-installed package with an identical version, and the symptom
is confusing: the install succeeds and your change is simply absent.

```bash
N8N=n8n-z44q-n8n-1
docker cp n8n-nodes-jarvis-0.2.0.tgz $N8N:/tmp/
docker exec -u node $N8N sh -c '
  cd /home/node/.n8n/nodes &&
  npm install /tmp/n8n-nodes-jarvis-0.2.0.tgz'
docker restart $N8N
```

n8n loads nodes at startup, so the restart is required — a rebuild alone
changes nothing.

Check it took:

```bash
docker exec -u node $N8N cat /home/node/.n8n/nodes/node_modules/n8n-nodes-jarvis/package.json | grep version
docker logs $N8N 2>&1 | grep -iE 'jarvis|error' | tail -20
```

### Removing it

```bash
docker exec -u node $N8N sh -c 'cd /home/node/.n8n/nodes && npm uninstall n8n-nodes-jarvis'
docker restart $N8N
```

Workflows using the node will show it as unrecognised but are not damaged —
reinstalling restores them.

## Gotchas

- **Changing a node's `name`** orphans it in existing workflows. Treat
  `jarvis` and `jarvisTrigger` as permanent, and the same goes for the
  operation values `sendProgress`, `notify` and `sendAndWait`.
- **`sendAndWait`** is load-bearing; see above.
- **Prefer an action over a node.** A new node type is a new thing users must
  find and a new name that can never change. n8n's own integrations add
  operations instead, and the picker lists them separately anyway.
- **Renaming a parameter** silently loses its saved value. Add a new one and
  keep reading the old as a fallback if it matters.
- **`displayName` vs `name`**: `displayName` is the label, `name` is the key
  used in expressions and storage.
- **Icons** are not TypeScript, so `tsc` ignores them; `scripts/copy-icons.js`
  copies them into `dist`. A missing icon shows as a blank square.
- **`N8N_UNVERIFIED_PACKAGES_ENABLED`** must stay `true` for a locally
  installed package. n8n warns that the default flips to `false` in a future
  version, at which point an unpinned instance stops loading this node.
- **The volume**: `/home/node/.n8n` persists across restarts but not across
  volume recreation. Keep the tarball build reproducible from this repo.

## Reference

- [Creating nodes](https://docs.n8n.io/integrations/creating-nodes/) — official guide
- [Community node install](https://docs.n8n.io/integrations/community-nodes/installation/) — GUI and manual
- n8n's own `Wait` node is the reference implementation for parking and resuming
