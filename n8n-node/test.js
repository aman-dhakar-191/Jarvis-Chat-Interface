// Structural checks on the built package. n8n itself cannot run here, so this
// verifies what is verifiable: that every compiled node loads, that each
// description satisfies n8n's contract, and that package.json points at files
// that actually exist.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('./package.json');
const { JarvisGatewayApi } = require('./dist/credentials/JarvisGatewayApi.credentials.js');
const { Jarvis } = require('./dist/nodes/Jarvis/Jarvis.node.js');
const { JarvisTrigger } = require('./dist/nodes/Jarvis/JarvisTrigger.node.js');
const { normalizeChatInput } = require('./dist/nodes/Jarvis/normalize.js');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log('PASS ', label); }
  catch (err) { failures++; console.log('FAIL ', label, '->', err.message); }
};

// Same reporting, but actually awaits the assertion instead of dropping a
// rejected promise on the floor.
const checkAsync = async (label, fn) => {
  try { await fn(); console.log('PASS ', label); }
  catch (err) { failures++; console.log('FAIL ', label, '->', err.message); }
};

// An icon has to resolve the way n8n resolves it: relative to the directory
// the node was loaded from.
const distDirOf = (nodeName) => {
  const file = nodeName[0].toUpperCase() + nodeName.slice(1);
  const rel = pkg.n8n.nodes.find((p) => path.basename(p) === `${file}.node.js`);
  assert.ok(rel, `${nodeName} is not registered in package.json`);
  return path.dirname(path.join(__dirname, rel));
};

check('package.json declares the community-node keyword', () => {
  assert.ok(pkg.keywords.includes('n8n-community-node-package'));
});

check('every path in the n8n manifest exists in dist', () => {
  for (const rel of [...pkg.n8n.nodes, ...pkg.n8n.credentials]) {
    assert.ok(fs.existsSync(path.join(__dirname, rel)), `missing ${rel}`);
  }
});

// ---- the two node types the package registers ---------------------------

const descriptions = {
  jarvis: new Jarvis().description,
  jarvisTrigger: new JarvisTrigger().description,
};

const d = descriptions.jarvis;
const operations = d.properties.find((p) => p.name === 'operation').options.map((o) => o.value);

check('every node description has the fields n8n requires', () => {
  for (const [name, desc] of Object.entries(descriptions)) {
    for (const key of ['displayName', 'name', 'group', 'version', 'defaults', 'inputs', 'outputs', 'properties']) {
      assert.ok(desc[key] !== undefined, `${name} is missing ${key}`);
    }
    assert.equal(desc.name, name);
  }
});

check('the icon every node references was copied into dist', () => {
  for (const [name, desc] of Object.entries(descriptions)) {
    const rel = desc.icon.replace(/^file:/, '');
    assert.ok(
      fs.existsSync(path.resolve(distDirOf(name), rel)),
      `${name} points at a missing icon ${desc.icon}`,
    );
  }
});

check('the action node is a main node bound to the gateway credential', () => {
  assert.deepEqual(d.inputs, ['main']);
  assert.deepEqual(d.outputs, ['main']);
  assert.deepEqual(d.credentials, [{ name: 'jarvisGatewayApi', required: true }]);
  assert.equal(d.name, 'jarvis', 'renaming it would orphan every saved Jarvis node');
  assert.notEqual(d.hidden, true, 'the action node must stay in the node creator');
});

check('the three actions are offered under one node', () => {
  assert.deepEqual(operations, ['sendProgress', 'notify', 'sendAndWait']);
  // `action` is what the node creator lists, which is how one node type still
  // shows up as three separate picker entries.
  for (const option of d.properties.find((p) => p.name === 'operation').options) {
    assert.ok(option.action, `${option.value} has no action label`);
  }
});

check('every displayOptions rule names a real operation', () => {
  for (const prop of d.properties) {
    for (const op of prop.displayOptions?.show?.operation ?? []) {
      assert.ok(operations.includes(op), `${prop.name} shows on unknown operation "${op}"`);
    }
  }
});

check('each operation can reach a Session ID and a body field', () => {
  const bodyField = { sendProgress: 'content', notify: 'notifyContent', sendAndWait: 'message' };
  for (const op of operations) {
    const visible = d.properties
      .filter((p) => {
        const show = p.displayOptions?.show?.operation;
        return !show || show.includes(op);
      })
      .map((p) => p.name);
    assert.ok(visible.includes('sessionId'), `${op} cannot set sessionId`);
    assert.ok(visible.includes(bodyField[op]), `${op} cannot set ${bodyField[op]}`);
  }
});

check('the non-blocking operations do not show the wait controls', () => {
  for (const field of ['limitWaitTime', 'resumeAmount', 'resumeUnit', 'approvalOptions']) {
    const shown = d.properties.find((p) => p.name === field).displayOptions.show.operation;
    assert.deepEqual(shown, ['sendAndWait'], `${field} leaks into another operation`);
  }
});

check('progress keeps the stages the Jarvis client renders', () => {
  const stage = d.properties.find((p) => p.name === 'event');
  assert.deepEqual(stage.options.map((o) => o.value), [
    'tool.started', 'tool.progress', 'tool.finished', 'execution.progress',
  ]);
  assert.equal(stage.default, 'tool.started');
});

// ---- human review: the HITL contract ------------------------------------

check('the sendAndWait value n8n generates its HITL tool from is intact', () => {
  const { SEND_AND_WAIT_OPERATION } = require('n8n-workflow');
  assert.equal(SEND_AND_WAIT_OPERATION, 'sendAndWait');
  assert.ok(operations.includes(SEND_AND_WAIT_OPERATION));
});

check('the resume webhook is declared, and is not a trigger webhook', () => {
  assert.equal(d.webhooks.length, 1, 'exactly one output/webhook, per n8n#12823');
  const [hook] = d.webhooks;
  assert.equal(hook.restartWebhook, true, 'without this the gateway would start a new execution');
  assert.equal(hook.httpMethod, 'POST');
  assert.equal(hook.responseMode, 'onReceived');
  assert.equal(hook.name, 'default');
  assert.equal(hook.path, '');
  assert.notDeepEqual(d.group, ['trigger']);
});

check('the approvalOptions collection n8n carries onto the tool is intact', () => {
  const approval = d.properties.find((p) => p.name === 'approvalOptions');
  assert.equal(approval.type, 'fixedCollection');
  const values = approval.options[0].values.map((v) => v.name);
  assert.deepEqual(values, ['approvalType', 'approveLabel', 'disapproveLabel']);
  assert.equal(approval.options[0].values.find((v) => v.name === 'approvalType').default, 'double');
});

check('Message stays ungated so the generated HITL tool can replace it', () => {
  const message = d.properties.find((p) => p.name === 'message');
  assert.equal(message.displayOptions, undefined, 'gating Message on operation risks hiding it on the tool');
  assert.equal(message.required, true);
});

check('the wait controls sit behind Limit Wait Time', () => {
  assert.equal(d.properties.find((p) => p.name === 'limitWaitTime').default, true);
  for (const field of ['resumeAmount', 'resumeUnit']) {
    const prop = d.properties.find((p) => p.name === field);
    assert.deepEqual(prop.displayOptions.show.limitWaitTime, [true], `${field} misses the guard`);
  }
  assert.deepEqual(
    d.properties.find((p) => p.name === 'resumeUnit').options.map((o) => o.value),
    ['minutes', 'hours', 'days'],
  );
});

const asyncChecks = checkAsync('the resume payload becomes workflow data', async () => {
  const ctx = { getBodyData: () => ({ approvalId: 'apr_1', choice: 'approve', approved: true }) };
  const r = await new Jarvis().webhook.call(ctx);
  assert.deepEqual(r.webhookResponse, { ok: true });
  assert.equal(r.workflowData[0][0].json.approvalId, 'apr_1');
  assert.equal(r.workflowData[0][0].json.approved, true);
});

// ---- credential ---------------------------------------------------------

const cred = new JarvisGatewayApi();

check('the credential sends the push secret as a header, not a query param', () => {
  assert.equal(cred.name, 'jarvisGatewayApi');
  assert.equal(cred.authenticate.properties.headers['x-gateway-secret'], '={{$credentials.pushSecret}}');
  assert.equal(cred.properties.find((p) => p.name === 'pushSecret').typeOptions.password, true);
});

check('the credential test hits /health', () => {
  assert.equal(cred.test.request.url, '/health');
});

// ---- trigger node -------------------------------------------------------

const t = descriptions.jarvisTrigger;

check('the trigger declares itself as a trigger with no inputs', () => {
  assert.deepEqual(t.group, ['trigger']);
  assert.deepEqual(t.inputs, []);
  assert.deepEqual(t.outputs, ['main']);
});

check('the trigger webhook is a normal webhook, not a resume webhook', () => {
  assert.equal(t.webhooks.length, 1);
  const [hook] = t.webhooks;
  assert.equal(hook.httpMethod, 'POST');
  assert.equal(hook.restartWebhook, undefined, 'a trigger must not set restartWebhook');
  assert.equal(hook.path, '={{$parameter["path"]}}');
  // Without this n8n registers at /webhook/<webhookId>/<path> and the gateway 404s.
  assert.equal(hook.isFullPath, true, 'a fixed-path trigger must set isFullPath');
});

check('the trigger cannot offer responseNode, which cannot work behind it', () => {
  const modes = t.properties.find((p) => p.name === 'responseMode');
  const values = modes.options.map((o) => o.value);
  assert.ok(!values.includes('responseNode'), 'Respond to Webhook only supports the core Webhook node');
  assert.deepEqual(values, ['lastNode', 'onReceived']);
  assert.equal(modes.default, 'lastNode');
});

check('the trigger defaults to the path the gateway expects', () => {
  assert.equal(t.properties.find((p) => p.name === 'path').default, 'jarvis-chat');
});

check('the shared secret is masked in the UI', () => {
  assert.equal(t.properties.find((p) => p.name === 'sharedSecret').typeOptions.password, true);
});

check('normalize handles the gateway payload', () => {
  const n = normalizeChatInput({
    source: 'custom_chat', userId: 'aman', sessionId: 'session_aman',
    chatId: 'session_aman', messageId: 'msg_001', message: 'Hello Jarvis',
  });
  assert.equal(n.source, 'custom_chat');
  assert.equal(n.sessionId, 'session_aman');
  assert.equal(n.chatId, 'session_aman');
  assert.equal(n.messageId, 'msg_001');
  assert.equal(n.content, 'Hello Jarvis');
  assert.equal(n.chatInput, 'Hello Jarvis');
});

check('normalize handles a Telegram Trigger item', () => {
  const n = normalizeChatInput({
    message: { message_id: 4242, from: { id: 111222 }, chat: { id: 111222 }, text: 'Hi from Telegram' },
  });
  assert.equal(n.source, 'telegram');
  assert.equal(n.chatId, '111222');
  assert.equal(n.sessionId, '111222', 'sessionId falls back to chatId');
  assert.equal(n.messageId, '4242');
  assert.equal(n.content, 'Hi from Telegram');
});

check('normalize does not mistake a string message for a Telegram object', () => {
  const n = normalizeChatInput({ sessionId: 's1', message: 'plain string' });
  assert.equal(n.source, 'custom_chat');
  assert.equal(n.content, 'plain string');
});

check('normalize reports empty text so the trigger can reject it', () => {
  assert.equal(normalizeChatInput({ sessionId: 's1' }).content, '');
});

check('normalize never regenerates a supplied sessionId', () => {
  const n = normalizeChatInput({ sessionId: 'session_aman', chatId: 'other', message: 'x' });
  assert.equal(n.sessionId, 'session_aman');
});

asyncChecks.then(() => {
  console.log(failures ? `\n${failures} FAILURES` : '\nALL STRUCTURAL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
});
