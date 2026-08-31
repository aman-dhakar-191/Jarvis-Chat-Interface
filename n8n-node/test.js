// Structural checks on the built package. n8n itself cannot run here, so this
// verifies what is verifiable: that the compiled node loads, that its
// description satisfies n8n's contract, and that package.json points at files
// that actually exist.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('./package.json');
const { Jarvis } = require('./dist/nodes/Jarvis/Jarvis.node.js');
const { JarvisGatewayApi } = require('./dist/credentials/JarvisGatewayApi.credentials.js');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log('PASS ', label); }
  catch (err) { failures++; console.log('FAIL ', label, '->', err.message); }
};

check('package.json declares the community-node keyword', () => {
  assert.ok(pkg.keywords.includes('n8n-community-node-package'));
});

check('every path in the n8n manifest exists in dist', () => {
  for (const rel of [...pkg.n8n.nodes, ...pkg.n8n.credentials]) {
    assert.ok(fs.existsSync(path.join(__dirname, rel)), `missing ${rel}`);
  }
});

const node = new Jarvis();
const d = node.description;

check('node description has the fields n8n requires', () => {
  for (const key of ['displayName', 'name', 'group', 'version', 'defaults', 'inputs', 'outputs', 'properties']) {
    assert.ok(d[key] !== undefined, `missing ${key}`);
  }
  assert.equal(d.name, 'jarvis');
  assert.deepEqual(d.inputs, ['main']);
  assert.deepEqual(d.outputs, ['main']);
});

check('the icon referenced by the node was copied into dist', () => {
  const file = d.icon.replace(/^file:/, '');
  assert.ok(fs.existsSync(path.join(__dirname, 'dist/nodes/Jarvis', file)), `missing icon ${file}`);
});

check('the resume webhook is declared correctly', () => {
  assert.equal(d.webhooks.length, 1, 'exactly one output/webhook, per n8n#12823');
  const [hook] = d.webhooks;
  assert.equal(hook.restartWebhook, true);
  assert.equal(hook.httpMethod, 'POST');
  assert.equal(hook.name, 'default');
});

check('the node declares its credential as required', () => {
  assert.deepEqual(d.credentials, [{ name: 'jarvisGatewayApi', required: true }]);
});

const operations = d.properties.find((p) => p.name === 'operation').options.map((o) => o.value);

check('three operations are offered', () => {
  assert.deepEqual(operations.sort(), ['askApproval', 'notify', 'sendProgress']);
});

check('every displayOptions rule names a real operation', () => {
  for (const prop of d.properties) {
    for (const op of prop.displayOptions?.show?.operation ?? []) {
      assert.ok(operations.includes(op), `${prop.name} shows on unknown operation "${op}"`);
    }
  }
});

check('each operation can reach a required Session ID and body field', () => {
  for (const op of operations) {
    const visible = d.properties.filter((p) => {
      const show = p.displayOptions?.show?.operation;
      return !show || show.includes(op);
    }).map((p) => p.name);
    assert.ok(visible.includes('sessionId'), `${op} cannot set sessionId`);
    assert.ok(visible.includes('content'), `${op} has no content field`);
  }
});

check('exactly one content field is visible per operation', () => {
  for (const op of operations) {
    const contents = d.properties.filter(
      (p) => p.name === 'content' && (p.displayOptions?.show?.operation ?? []).includes(op),
    );
    assert.equal(contents.length, 1, `${op} shows ${contents.length} content fields`);
  }
});

const cred = new JarvisGatewayApi();

check('the credential sends the push secret as a header, not a query param', () => {
  assert.equal(cred.name, 'jarvisGatewayApi');
  assert.equal(cred.authenticate.properties.headers['x-gateway-secret'], '={{$credentials.pushSecret}}');
  assert.equal(cred.properties.find((p) => p.name === 'pushSecret').typeOptions.password, true);
});

check('the credential test hits /health', () => {
  assert.equal(cred.test.request.url, '/health');
});

console.log(failures ? `\n${failures} FAILURES` : '\nALL STRUCTURAL CHECKS PASSED');
process.exit(failures ? 1 : 0);
