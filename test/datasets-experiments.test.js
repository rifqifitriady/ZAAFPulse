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

test('list() and get() hand out copies', () => {
  const store = createExperimentStore({ file: path.join(tmp(), 'experiments.jsonl') });
  store.append(record(1, ['a']));
  const row = store.list()[0];
  row.summary.models.hacked = true;
  row.dataset = null;
  assert.deepEqual(store.list()[0].summary, { models: {} });
  assert.equal(store.list()[0].dataset, 'auth');
  const full = store.get('exp_0000000000000001');
  full.perExample[0].exampleId = 'changed';
  assert.equal(store.get('exp_0000000000000001').perExample[0].exampleId, 'a');
});

test('get() reads one line by its byte range, also after a trim and a torn line', () => {
  const file = path.join(tmp(), 'experiments.jsonl');
  const store = createExperimentStore({ file, max: 3 });
  for (let n = 1; n <= 5; n++) store.append(record(n, ['a', `b${n}`]));
  assert.deepEqual(
    store.list().map((r) => r.id.slice(-1)),
    ['5', '4', '3'],
  );
  for (const n of [3, 4, 5]) assert.deepEqual(store.get(`exp_000000000000000${n}`), record(n, ['a', `b${n}`]));
  fs.appendFileSync(file, '{"id":"exp_torn'); // a crash mid-write
  assert.equal(store.list().length, 3, 'the torn line is skipped');
  store.append(record(6, ['a']));
  assert.deepEqual(
    store.list().map((r) => r.id.slice(-1)),
    ['6', '5', '4'],
  );
  assert.deepEqual(store.get('exp_0000000000000006'), record(6, ['a']));
  // Unicode in a record keeps byte offsets right.
  const wide = { ...record(7, ['ü']), dataset: 'ünïcødé ✓' };
  store.append(wide);
  assert.deepEqual(store.get('exp_0000000000000007'), wide);
  assert.deepEqual(store.get('exp_0000000000000006'), record(6, ['a']));
});

test('a record is bounded: texts get shorter, then results are dropped; the summary stays', () => {
  const file = path.join(tmp(), 'experiments.jsonl');
  const big = 'x'.repeat(4000);
  const rows = (k) =>
    Array.from({ length: k }, (_, i) => ({
      exampleId: `ex_${i}`,
      model: 'local/qwen3',
      output: { text: big, proposal: { name: 'Bash', arguments: big } },
      error: null,
      labels: {},
      cost: 0,
      ms: 1,
    }));
  const store = createExperimentStore({ file, maxBytes: 60000 });
  // 20 rows of 8,000 characters: over 60 KB, fits once the texts are 1,000 characters.
  const a = { ...record(1, []), perExample: rows(20), summary: { models: { 'local/qwen3': { requests: 20 } } } };
  const stored = store.append(a);
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) <= 60000);
  assert.deepEqual(stored.trimmed, { textChars: 1000 });
  assert.equal(stored.perExample.length, 20);
  assert.ok(stored.perExample[0].output.text.length <= 1000);
  assert.match(stored.perExample[0].output.text, /trimmed/);
  assert.deepEqual(stored.summary, a.summary);
  assert.equal(a.perExample[0].output.text, big, "the caller's record is not changed");
  assert.deepEqual(store.get('exp_0000000000000001'), stored);

  // 2,000 rows cannot fit even without texts: results are dropped from the end.
  const b = { ...record(2, []), perExample: rows(2000) };
  const kept = store.append(b);
  assert.ok(Buffer.byteLength(JSON.stringify(kept)) <= 60000);
  assert.equal(kept.trimmed.textChars, 0);
  assert.ok(kept.trimmed.droppedResults > 0);
  assert.equal(kept.perExample.length + kept.trimmed.droppedResults, 2000);
  assert.equal(kept.perExample[0].output.text, null);
  assert.equal(kept.perExample[0].exampleId, 'ex_0');

  // A small record is stored as it is.
  const c = record(3, ['a']);
  assert.equal(store.append(c), c);
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) assert.ok(Buffer.byteLength(line) <= 60000);
});

// D-T3-2: the trim slices the buffer it just read, never the cached offsets of an older read. Here another writer
// lengthened a record between the cached parse and the trim's read.
test('a trim keeps whole lines when another writer changed the file since the last parse', () => {
  const file = path.join(tmp(), '.data', 'experiments.jsonl');
  const store = createExperimentStore({ file, max: 4 });
  const ids = (k) => Array.from({ length: k }, (_, i) => `x${i}`);
  for (let n = 1; n <= 4; n++) store.append(record(n, ids(n * 3)));
  store.list(); // the cache now holds this file's line offsets
  const real = fs.readFileSync;
  let swapped = 0;
  fs.readFileSync = function (target, ...rest) {
    const buf = real.call(this, target, ...rest);
    if (target !== file || swapped++) return buf;
    // What the other writer left: record 2 (kept by the trim) is now much longer, so every later line moved.
    const lines = buf.toString('utf8').split('\n');
    lines[1] = JSON.stringify(record(2, ids(40)));
    return Buffer.from(lines.join('\n'));
  };
  try {
    store.append(record(5, ['a']));
  } finally {
    fs.readFileSync = real;
  }
  assert.equal(swapped, 1, 'the trim read the file once');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const kept = lines.map((l) => JSON.parse(l).id);
  assert.deepEqual(
    kept,
    [2, 3, 4, 5].map((n) => `exp_000000000000000${n}`),
  );
});
