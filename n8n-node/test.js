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
const { normalizeToolArguments } = require('./dist/nodes/Jarvis/common/helpers.js');
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

const operationOptions = d.properties.find((p) => p.name === 'operation').options;

check('all three operations exist on the one node', () => {
  assert.deepEqual(operations, ['sendProgress', 'notify', 'sendAndWait']);
  for (const option of operationOptions) {
    assert.ok(option.action, `${option.value} has no action label`);
  }
});

check('every operation is offered in the node creator', () => {
  // Naming an option '*', '' or ' ' would hide it from the Actions list
  // (useActionsGeneration.ts filters those) - but that name is also what the
  // Operation dropdown renders, so the node showed a bare '*'.
  const HIDDEN_FROM_ACTIONS = ['*', '', ' '];
  for (const option of operationOptions) {
    assert.ok(
      !HIDDEN_FROM_ACTIONS.includes(option.name),
      `${option.value} has a name that renders as a broken Operation entry`,
    );
  }
});

check('each progress stage says what it does to the status line', () => {
  const stage = d.properties.find((p) => p.name === 'event');
  for (const option of stage.options) {
    assert.ok(option.description, `${option.value} has no description`);
  }
  // Only tool.finished clears; the rest replace. Without this the four stages
  // are interchangeable and the dropdown means nothing.
  assert.match(stage.options.find((o) => o.value === 'tool.finished').description, /[Cc]lears/);
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

check('the tool name is read as a parameter, so $tool is in scope', () => {
  const prop = d.properties.find((p) => p.name === 'toolName');
  assert.equal(prop.default, '={{ $tool.name }}');
  assert.deepEqual(prop.displayOptions.show.operation, ['sendAndWait']);
});

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

check('no property collides with the keys n8n uses for the gated tool call', () => {
  // `toolParameters` is where n8n puts the gated tool's arguments when it
  // merges them into the HITL call. Declaring a property of that name captures
  // them here instead, and the gated tool runs with nothing.
  // `toolName` is deliberately absent: n8n does not merge a key of that name,
  // and it is the only way to read $tool, which is in scope for parameter
  // resolution but not for evaluateExpression() in execute().
  const RESERVED = ['toolParameters', 'tool', 'hitlParameters'];
  for (const prop of d.properties) {
    assert.ok(!RESERVED.includes(prop.name), `${prop.name} collides with an n8n HITL payload key`);
  }
});

check('approval defaults to asking, as a real boolean', () => {
  const prop = d.properties.find((p) => p.name === 'approvalRequired');
  assert.equal(prop.type, 'boolean');
  // A real boolean, not an expression: an expression default leaves '' behind
  // once the sparkle override is removed, and n8n renders '' as a toggle in the
  // off position while the value is not actually false.
  assert.equal(prop.default, true);
  assert.deepEqual(prop.displayOptions.show.operation, ['sendAndWait']);
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

  const { json } = r.workflowData[0][0];
  assert.equal(json.approvalId, 'apr_1');
  // Flat, because workflows branch on {{ $json.approved }}.
  assert.equal(json.approved, true);
  // Nested, because the HITL engine reads the approval there before it will
  // run the gated tool - the shape n8n's own sendAndWait nodes answer with.
  assert.equal(json.data.approved, true);
  assert.equal(json.data.approvalId, 'apr_1');
});

// ---- tool arguments -----------------------------------------------------

check('flat tool arguments pass through', () => {
  // The shape seen on one call: arguments at the top level.
  assert.deepEqual(
    normalizeToolArguments('{"tool":"System_Tools","action":"run_command","command":"ls -laR","extra":""}'),
    { tool: 'System_Tools', action: 'run_command', command: 'ls -laR', extra: '' },
  );
});

check('wrapped tool arguments are folded to the same shape', () => {
  // The shape seen on the very next call to the same tool, same run.
  assert.deepEqual(
    normalizeToolArguments('{"toolParameters":{"action":"run_command","command":"ls -la","extra":""},"tool":"System_Tools"}'),
    { tool: 'System_Tools', action: 'run_command', command: 'ls -la', extra: '' },
  );
});

check('both shapes of the same call normalise identically', () => {
  const flat = normalizeToolArguments({ tool: 'T', action: 'a', command: 'c' });
  const wrapped = normalizeToolArguments({ tool: 'T', toolParameters: { action: 'a', command: 'c' } });
  assert.deepEqual(flat, wrapped);
});

check('hitlParameters is unwrapped too', () => {
  assert.deepEqual(
    normalizeToolArguments({ tool: 'T', hitlParameters: { context: 'x' } }),
    { tool: 'T', context: 'x' },
  );
});

check('no workflow-specific field name is stripped', () => {
  // Only n8n's own wrapper keys are known here. A field called Message, or
  // anything else a particular workflow happens to name, is just an argument.
  assert.deepEqual(normalizeToolArguments({ Message: 'Listing files…', action: 'run_command' }), {
    Message: 'Listing files…',
    action: 'run_command',
  });
  assert.deepEqual(normalizeToolArguments({ anything: 1, at: 'all' }), { anything: 1, at: 'all' });
});

check('an object is accepted as readily as a JSON string', () => {
  assert.deepEqual(normalizeToolArguments({ action: 'a' }), { action: 'a' });
});

check('malformed JSON is kept as text rather than thrown away', () => {
  // An approval must not fail because a status payload was mangled.
  assert.deepEqual(normalizeToolArguments('{"action": run_command'), { raw: '{"action": run_command' });
});

check('empty and non-object inputs give an empty object', () => {
  for (const input of ['', '   ', null, undefined, 42, '[]', '"text"']) {
    assert.deepEqual(normalizeToolArguments(input), {}, `for ${JSON.stringify(input)}`);
  }
});

check('a nested wrapper does not clobber the outer envelope', () => {
  const out = normalizeToolArguments({ tool: 'T', toolParameters: { command: 'ls' } });
  assert.equal(out.tool, 'T', 'the tool name must survive the fold');
  assert.equal(out.toolParameters, undefined, 'the wrapper itself must be gone');
});
check('broken model tool schemas do not crash argument normalization', () => {
  const cases = [
    // Missing expected arguments
    { tool: 'System_Tools' },
    { tool: 'System_Tools', action: undefined },
    { tool: 'System_Tools', action: null },
    { tool: 'System_Tools', command: undefined },

    // Wrong argument types
    { tool: 'System_Tools', action: 123 },
    { tool: 'System_Tools', command: 123 },
    { tool: 'System_Tools', extra: [] },

    // Model returns an unexpected schema
    { name: 'System_Tools', arguments: { action: 'run_command' } },
    { function: 'System_Tools', parameters: { action: 'run_command' } },
    { tool: { name: 'System_Tools' }, arguments: {} },

    // Wrapper exists but has the wrong shape
    { tool: 'System_Tools', toolParameters: 'invalid' },
    { tool: 'System_Tools', toolParameters: [] },
    { tool: 'System_Tools', toolParameters: null },
    { tool: 'System_Tools', toolParameters: 123 },

    { tool: 'System_Tools', hitlParameters: 'invalid' },
    { tool: 'System_Tools', hitlParameters: [] },
    { tool: 'System_Tools', hitlParameters: null },
    { tool: 'System_Tools', hitlParameters: 123 },
  ];

  for (const input of cases) {
    assert.doesNotThrow(
      () => normalizeToolArguments(input),
      `broken model schema must not throw for ${JSON.stringify(input)}`,
    );
  }
});

check('malformed model JSON schemas are handled safely', () => {
  const cases = [
    '{"tool":"System_Tools"',
    '{"tool":"System_Tools","toolParameters":',
    '{"tool":"System_Tools","toolParameters":{"action":}',
    '{tool:"System_Tools",action:"run_command"}',
    '{"tool":"System_Tools","action":"run_command",}',
    '```json\n{"tool":"System_Tools"}\n```',
    'System_Tools({"action":"run_command"})',
  ];

  for (const input of cases) {
    assert.doesNotThrow(
      () => normalizeToolArguments(input),
      `malformed model JSON must not throw for ${input}`,
    );
  }
});

check('unexpected model schema keys are preserved rather than silently dropped', () => {
  assert.deepEqual(
    normalizeToolArguments({
      tool: 'System_Tools',
      arguments: {
        action: 'run_command',
        command: 'ls',
      },
    }),
    {
      tool: 'System_Tools',
      arguments: {
        action: 'run_command',
        command: 'ls',
      },
    },
  );
});

check('missing tool arguments produce an empty argument object when appropriate', () => {
  assert.deepEqual(
    normalizeToolArguments({ tool: 'System_Tools' }),
    { tool: 'System_Tools' },
  );

  assert.deepEqual(
    normalizeToolArguments({ tool: 'System_Tools', toolParameters: {} }),
    { tool: 'System_Tools' },
  );
});

check('a wrapper nested inside itself is dug out, not dropped', () => {
  // Merging the inner object up and then deleting the key lost everything:
  // the inner object overwrote the key that was about to be deleted.
  assert.deepEqual(
    normalizeToolArguments({ toolParameters: { toolParameters: { action: 'run_command' } } }),
    { action: 'run_command' },
  );
  assert.deepEqual(
    normalizeToolArguments({ tool: 'T', hitlParameters: { toolParameters: { command: 'ls' } } }),
    { tool: 'T', command: 'ls' },
  );
});

check('a wrapper that arrived as JSON text is parsed, not left as a string', () => {
  assert.deepEqual(
    normalizeToolArguments({ tool: 'T', toolParameters: '{"action":"run_command","command":"ls"}' }),
    { tool: 'T', action: 'run_command', command: 'ls' },
  );
});

check('a doubly encoded payload still resolves', () => {
  assert.deepEqual(normalizeToolArguments(JSON.stringify(JSON.stringify({ action: 'a' }))), {
    action: 'a',
  });
});

check('both wrappers on one call are folded', () => {
  assert.deepEqual(
    normalizeToolArguments({ toolParameters: { a: 1 }, hitlParameters: { b: 2 } }),
    { a: 1, b: 2 },
  );
});

check('the wrapper wins over a colliding outer key', () => {
  // The outer level is the call envelope; the wrapper holds the arguments.
  assert.deepEqual(
    normalizeToolArguments({ action: 'envelope', toolParameters: { action: 'argument' } }),
    { action: 'argument' },
  );
});

check('unwrapping is bounded, so a self-referencing payload cannot spin', () => {
  // Build a wrapper nested far deeper than the cap.
  let payload = { action: 'deep' };
  for (let i = 0; i < 40; i++) payload = { toolParameters: payload };

  const started = Date.now();
  const out = normalizeToolArguments(payload);
  assert.ok(Date.now() - started < 1000, 'must not take meaningful time');
  assert.equal(typeof out, 'object');
});

check('a prototype-polluting payload cannot reach Object.prototype', () => {
  normalizeToolArguments('{"__proto__":{"polluted":true},"action":"a"}');
  normalizeToolArguments({ toolParameters: JSON.parse('{"__proto__":{"polluted":true}}') });
  assert.equal({}.polluted, undefined, 'Object.prototype must be untouched');
  assert.equal(Object.prototype.polluted, undefined);
});

check('a constructor key is data, not a call', () => {
  assert.deepEqual(normalizeToolArguments('{"constructor":{"x":1},"a":1}'), {
    constructor: { x: 1 },
    a: 1,
  });
});

check('values are passed through whatever their type', () => {
  // This normalises shape, not types: a wrong-typed argument is the callee's
  // problem to report, and silently coercing it would hide the mistake.
  const input = {
    str: 'x',
    num: 0,
    bool: false,
    nul: null,
    arr: [1, { deep: true }],
    obj: { nested: { deeper: 1 } },
    unicode: 'ls -la 📁 jarvis-skills',
    multiline: 'line one\nline two',
  };
  assert.deepEqual(normalizeToolArguments(input), input);
});

check('an empty wrapper leaves only the envelope', () => {
  assert.deepEqual(normalizeToolArguments({ tool: 'T', toolParameters: {} }), { tool: 'T' });
});

check('a large payload is handled without truncation', () => {
  const command = 'ls -la '.repeat(5000);
  assert.equal(normalizeToolArguments({ toolParameters: { command } }).command, command);
});

check('the input object is never mutated', () => {
  const input = { tool: 'T', toolParameters: { action: 'a' } };
  const copy = JSON.parse(JSON.stringify(input));
  normalizeToolArguments(input);
  assert.deepEqual(input, copy, 'the caller keeps whatever it passed in');
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

check('the trigger returns the reply in sync mode and the text in async mode', () => {
  // One webhook field, two meanings: an enum under lastNode, literal body text
  // under onReceived. Hardcoding the async text broke sync mode, which then
  // never returned the final node's output.
  const { responseData } = t.webhooks[0];
  assert.match(responseData, /firstEntryJson/, 'sync mode must return the last node output');
  assert.match(responseData, /responseText/, 'async mode must use the configurable text');
  assert.match(responseData, /onReceived/);
});

check('the immediate reply is configurable and only shown when it applies', () => {
  const prop = t.properties.find((p) => p.name === 'responseText');
  assert.equal(prop.type, 'string', 'a string so an expression can vary it per message');
  assert.equal(prop.default, 'Working on it...');
  assert.deepEqual(prop.displayOptions.show.responseMode, ['onReceived']);
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
