const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createExperimentStore } = require('../lib/datasets/experiments');

const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-exp-'));
  dirs.push(d);
  return d;
};
const record = (n, exampleIds) => ({
  id: `exp_000000000000000${n}`,
  dataset: 'auth',
  models: ['local/qwen3'],
  evaluators: ['reference_match'],
  startedAt: 1000 + n,
  endedAt: 2000 + n,
  perExample: exampleIds.map((exampleId) => ({ exampleId, model: 'local/qwen3', labels: {}, cost: 0, ms: 1 })),
  summary: { models: {} },
});

test('keeps the newest records, lists newest first without the outputs', () => {
  const file = path.join(tmp(), '.data', 'experiments.jsonl');
  const store = createExperimentStore({ file, max: 2 });
  assert.deepEqual(store.list(), []);
  store.append(record(1, ['a']));
  store.append(record(2, ['a', 'b', 'a']));
  assert.deepEqual(
    store.list().map((r) => r.id),
    ['exp_0000000000000002', 'exp_0000000000000001'],
  );
  store.append(record(3, ['a', 'b', 'c']));
  const rows = store.list();
  assert.deepEqual(
    rows.map((r) => r.id),
    ['exp_0000000000000003', 'exp_0000000000000002'],
  );
  assert.equal('perExample' in rows[0], false);
  assert.equal(rows[0].examples, 3);
  assert.equal(rows[1].examples, 2, 'distinct example ids');
  assert.equal(rows[0].dataset, 'auth');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);

  assert.deepEqual(store.get('exp_0000000000000002'), record(2, ['a', 'b', 'a']));
  assert.equal(store.get('exp_0000000000000001'), null, 'trimmed');
  assert.equal(store.get('exp_missing'), null);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
});

test('a record another process appended shows in the list', () => {
  const file = path.join(tmp(), 'experiments.jsonl');
  const a = createExperimentStore({ file });
  const b = createExperimentStore({ file });
  a.append(record(1, ['a']));
  assert.equal(b.list().length, 1);
  b.append(record(2, ['a']));
  assert.deepEqual(
    a.list().map((r) => r.id),
    ['exp_0000000000000002', 'exp_0000000000000001'],
  );
});
