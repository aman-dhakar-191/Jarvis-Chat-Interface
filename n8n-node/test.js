// Structural checks on the built package. n8n itself cannot run here, so this
// verifies what is verifiable: that every compiled node loads, that each
// description satisfies n8n's contract, and that package.json points at files
// that actually exist.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('./package.json');
const { JarvisGatewayApi } = require('./dist/credentials/JarvisGatewayApi.credentials.js');
const { JarvisTrigger } = require('./dist/nodes/Jarvis/Trigger/JarvisTrigger.node.js');
const { normalizeChatInput } = require('./dist/nodes/Jarvis/Trigger/normalize.js');
const { JarvisNotification } = require('./dist/nodes/Jarvis/Notification/JarvisNotification.node.js');
const { JarvisProgress } = require('./dist/nodes/Jarvis/Progress/JarvisProgress.node.js');
const { JarvisHumanReview } = require('./dist/nodes/Jarvis/HumanReview/JarvisHumanReview.node.js');
const { Jarvis } = require('./dist/nodes/Jarvis/Jarvis.node.js');

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

// Every node is loaded from its own dist directory, so a `file:../jarvis.svg`
// icon has to resolve the way n8n resolves it: relative to that directory.
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

// ---- the four nodes the picker should expose ----------------------------

const descriptions = {
  jarvisTrigger: new JarvisTrigger().description,
  jarvisNotification: new JarvisNotification().description,
  jarvisProgress: new JarvisProgress().description,
  jarvisHumanReview: new JarvisHumanReview().description,
  jarvis: new Jarvis().description,
};

check('every node description has the fields n8n requires', () => {
  for (const [name, d] of Object.entries(descriptions)) {
    for (const key of ['displayName', 'name', 'group', 'version', 'defaults', 'inputs', 'outputs', 'properties']) {
      assert.ok(d[key] !== undefined, `${name} is missing ${key}`);
    }
    assert.equal(d.name, name);
  }
});

check('the icon every node references was copied into dist', () => {
  for (const [name, d] of Object.entries(descriptions)) {
    const rel = d.icon.replace(/^file:/, '');
    assert.ok(
      fs.existsSync(path.resolve(distDirOf(name), rel)),
      `${name} points at a missing icon ${d.icon}`,
    );
  }
});

check('the action nodes are main nodes bound to the gateway credential', () => {
  for (const name of ['jarvisNotification', 'jarvisProgress', 'jarvisHumanReview']) {
    const d = descriptions[name];
    assert.deepEqual(d.inputs, ['main'], `${name} inputs`);
    assert.deepEqual(d.outputs, ['main'], `${name} outputs`);
    assert.deepEqual(d.credentials, [{ name: 'jarvisGatewayApi', required: true }], `${name} credentials`);
  }
});

check('each action node exposes exactly the parameters it needs', () => {
  const names = (d) => d.properties.map((p) => p.name);
  assert.deepEqual(names(descriptions.jarvisNotification), ['sessionId', 'content']);
  assert.deepEqual(names(descriptions.jarvisProgress), ['sessionId', 'event', 'content']);
  assert.deepEqual(names(descriptions.jarvisHumanReview), [
    'operation', 'sessionId', 'message', 'approvalOptions',
    'limitWaitTime', 'resumeAmount', 'resumeUnit', 'toolName', 'toolParameters',
  ]);
});

check('notification and progress carry no operation switch', () => {
  for (const name of ['jarvisNotification', 'jarvisProgress']) {
    assert.equal(descriptions[name].properties.find((p) => p.name === 'operation'), undefined, name);
    assert.equal(descriptions[name].webhooks, undefined, `${name} must not declare a webhook`);
  }
});

check('progress keeps the stages the Jarvis client renders', () => {
  const stage = descriptions.jarvisProgress.properties.find((p) => p.name === 'event');
  assert.deepEqual(stage.options.map((o) => o.value), [
    'tool.started', 'tool.progress', 'tool.finished', 'execution.progress',
  ]);
  assert.equal(stage.default, 'tool.started');
});

// ---- human review: the HITL contract ------------------------------------

const hr = descriptions.jarvisHumanReview;

check('human review still declares the sendAndWait operation n8n generates its HITL tool from', () => {
  const operation = hr.properties.find((p) => p.name === 'operation');
  assert.deepEqual(operation.options.map((o) => o.value), ['sendAndWait']);
  assert.equal(operation.default, 'sendAndWait');
});

check('human review declares the resume webhook, not a trigger webhook', () => {
  assert.equal(hr.webhooks.length, 1, 'exactly one output/webhook, per n8n#12823');
  const [hook] = hr.webhooks;
  assert.equal(hook.restartWebhook, true, 'without this the gateway would start a new execution');
  assert.equal(hook.httpMethod, 'POST');
  assert.equal(hook.responseMode, 'onReceived');
  assert.equal(hook.name, 'default');
  assert.equal(hook.path, '');
  assert.notDeepEqual(hr.group, ['trigger']);
});

check('human review keeps the approvalOptions collection n8n carries onto the tool', () => {
  const approval = hr.properties.find((p) => p.name === 'approvalOptions');
  assert.equal(approval.type, 'fixedCollection');
  const values = approval.options[0].values.map((v) => v.name);
  assert.deepEqual(values, ['approvalType', 'approveLabel', 'disapproveLabel']);
  assert.equal(approval.options[0].values.find((v) => v.name === 'approvalType').default, 'double');
});

check('human review exposes the wait controls behind Limit Wait Time', () => {
  assert.equal(hr.properties.find((p) => p.name === 'limitWaitTime').default, true);
  for (const field of ['resumeAmount', 'resumeUnit']) {
    const prop = hr.properties.find((p) => p.name === field);
    assert.deepEqual(prop.displayOptions.show.limitWaitTime, [true], `${field} misses the guard`);
  }
  assert.deepEqual(
    hr.properties.find((p) => p.name === 'resumeUnit').options.map((o) => o.value),
    ['minutes', 'hours', 'days'],
  );
});

const asyncChecks = checkAsync('human review turns the resume payload into workflow data', async () => {
  const ctx = { getBodyData: () => ({ approvalId: 'apr_1', choice: 'approve', approved: true }) };
  const r = await new JarvisHumanReview().webhook.call(ctx);
  assert.deepEqual(r.webhookResponse, { ok: true });
  assert.equal(r.workflowData[0][0].json.approvalId, 'apr_1');
  assert.equal(r.workflowData[0][0].json.approved, true);
});

// ---- legacy node --------------------------------------------------------

check('the legacy node stays loadable so saved workflows do not orphan', () => {
  const d = descriptions.jarvis;
  assert.equal(d.name, 'jarvis', 'renaming it would orphan every saved Jarvis node');
  assert.equal(d.hidden, true, 'it must not appear in the node creator any more');
  const operations = d.properties.find((p) => p.name === 'operation').options.map((o) => o.value);
  assert.deepEqual(operations, ['sendProgress', 'notify', 'sendAndWait']);
  assert.equal(d.webhooks[0].restartWebhook, true);
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
