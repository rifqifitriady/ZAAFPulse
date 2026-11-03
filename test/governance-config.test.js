// Governance audit log (AI Governance 2): the integration settings writer (lib/integration-config.js) reports each
// config.json write as (before, after), so server.js can record its config.change entry; a refused change reports
// nothing, and a listener that throws never undoes a save.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createIntegrationConfig } = require('../lib/integration-config');
const { diff, MASK } = require('../lib/governance/diff');

const fakeSecrets = { resolve: () => null, mask: (s) => s };
function setup(t, onChange) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-ic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ userName: 'Ana', integrations: {} }));
  return { file, ic: createIntegrationConfig({ file, secrets: fakeSecrets, store: () => {}, onChange }) };
}

test('integration settings: a save and a delete report what config.json held before and after', (t) => {
  const seen = [];
  const { file, ic } = setup(t, (before, after) => seen.push({ before, after }));
  const form = {
    id: 'n8n-prod',
    type: 'n8n',
    values: { baseUrl: 'http://127.0.0.1:9', apiKey: { mode: 'store', value: 's3cret-value' } },
  };
  assert.equal(ic.save(form).id, 'n8n-prod');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].before, { userName: 'Ana', integrations: {} });
  assert.deepEqual(seen[0].after, JSON.parse(fs.readFileSync(file, 'utf8')));
  const changes = diff(seen[0].before, seen[0].after).changes;
  assert.ok(changes.some((c) => c.path === 'integrations.n8n-prod.baseUrl' && c.to === 'http://127.0.0.1:9'));
  assert.deepEqual(
    changes.find((c) => c.path === 'integrations.n8n-prod.apiKey'),
    { path: 'integrations.n8n-prod.apiKey', from: null, to: MASK },
  );
  assert.ok(!JSON.stringify(changes).includes('s3cret-value'));
  assert.deepEqual(ic.remove('n8n-prod'), { id: 'n8n-prod' });
  assert.equal(seen.length, 2);
  assert.ok(seen[1].before.integrations['n8n-prod'], 'the delete reports the entry it removed');
  assert.deepEqual(seen[1].after, { userName: 'Ana', integrations: {} });
  // Refused: nothing written, nothing reported.
  assert.ok(ic.save({ id: 'Bad Id', type: 'router', values: {} }).errors);
  assert.ok(ic.remove('nope').errors);
  assert.equal(seen.length, 2);
});

test('integration settings: a listener that throws never undoes the save', (t) => {
  const { file, ic } = setup(t, () => {
    throw new Error('listener down');
  });
  assert.equal(ic.save({ id: 'r1', type: 'router', values: { baseUrl: 'http://127.0.0.1:9' } }).id, 'r1');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).integrations.r1);
});
