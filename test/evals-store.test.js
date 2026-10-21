const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEvalStore, createFeedbackStore } = require('../lib/evals/store');
const { targetKey, resultKey } = require('../lib/evals/registry');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evals-store-')), 'data', 'x.jsonl');
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
const T = (turn = 1, session = 's1', source = 'claude') => ({ source, session, turn, span: null });
const R = (target, evaluator, label, model = 'qwen3', extra = {}) => ({
  target,
  evaluator,
  version: 1,
  label,
  score: 1,
  direction: 'maximize',
  explanation: 'ok',
  judge: { kind: 'judge', model, provider: 'ollama' },
  trimmed: false,
  ...extra,
});

test('eval put and get return the latest result per key', () => {
  const store = createEvalStore({ file: tmp() });
  const t = T();
  const first = store.put(R(t, 'relevance', 'partly'));
  const second = store.put(R(t, 'relevance', 'relevant'));
  const key = resultKey(t, 'relevance', 1, 'qwen3');
  assert.equal(first.key, key);
  assert.equal(store.get(key).label, 'relevant');
  assert.equal(store.get(key).id, second.id);
  assert.equal(store.all().length, 1);
  assert.equal(store.get('nope'), null);
});

test('eval lookups by target and by session', () => {
  const store = createEvalStore({ file: tmp() });
  store.put(R(T(1), 'relevance', 'relevant'));
  store.put(R(T(1), 'task_completion', 'complete'));
  store.put(R(T(2), 'relevance', 'partly'));
  store.put(R(T(1, 's2'), 'relevance', 'relevant'));
  store.put(R(T(1, 's1', 'codex'), 'relevance', 'relevant'));
  assert.equal(store.forTarget(targetKey(T(1))).length, 2);
  assert.equal(store.forSession('claude', 's1').length, 3);
  assert.equal(store.forSession('claude', 'missing').length, 0);
});

test('eval explanations are truncated at 300 characters', () => {
  const store = createEvalStore({ file: tmp() });
  const r = store.put(R(T(), 'relevance', 'relevant', 'qwen3', { explanation: 'x'.repeat(900) }));
  assert.equal(r.explanation.length, 300);
  assert.equal(store.all()[0].explanation.length, 300);
});

test('eval results survive a reload and keep the newest line', () => {
  const file = tmp();
  const a = createEvalStore({ file });
  a.put(R(T(), 'relevance', 'partly'));
  a.put(R(T(), 'relevance', 'relevant'));
  a.put(R(T(2), 'relevance', 'off-topic'));
  const b = createEvalStore({ file });
  assert.equal(b.all().length, 2);
  assert.equal(b.get(resultKey(T(), 'relevance', 1, 'qwen3')).label, 'relevant');
});

test('eval compaction keeps one line per key and survives a reload', () => {
  const file = tmp();
  const store = createEvalStore({ file, maxBytes: 600 });
  for (let i = 0; i < 12; i++) store.put(R(T(i % 3), 'relevance', i % 2 ? 'relevant' : 'partly'));
  assert.equal(store.all().length, 3);
  // The cap fired along the way, so the file holds far fewer lines than the 12 writes.
  assert.ok(lines(file).length < 12);
  store.compact();
  assert.equal(lines(file).length, 3);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  const before = store.all().sort((x, y) => x.key.localeCompare(y.key));
  const after = createEvalStore({ file })
    .all()
    .sort((x, y) => x.key.localeCompare(y.key));
  assert.deepEqual(after, before);
});

test('a corrupt line is skipped and counted', () => {
  const file = tmp();
  const a = createEvalStore({ file });
  a.put(R(T(), 'relevance', 'relevant'));
  fs.appendFileSync(file, '{not json\n\n[1,2]\n');
  const b = createEvalStore({ file });
  assert.equal(b.all().length, 1);
  assert.equal(b.stats().bad, 2);
  const f = tmp();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"id":"a","target":{"source":"claude","session":"s"},"note":"n","rating":"good"}\noops\n');
  const fb = createFeedbackStore({ file: f });
  assert.equal(fb.all().length, 1);
  assert.equal(fb.stats().bad, 1);
});

test('stores create the file as 0600 and the folder as 0700', { skip: process.platform === 'win32' }, () => {
  const ef = tmp();
  createEvalStore({ file: ef }).put(R(T(), 'relevance', 'relevant'));
  assert.equal(fs.statSync(ef).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(ef)).mode & 0o777, 0o700);
  const ff = tmp();
  const fb = createFeedbackStore({ file: ff });
  fb.set({ target: T(), rating: 'good', note: '' });
  assert.equal(fs.statSync(ff).mode & 0o777, 0o600);
  fb.set({ target: T(), rating: 'bad', note: 'rewritten' });
  assert.equal(fs.statSync(ff).mode & 0o777, 0o600);
  const cf = tmp();
  const es = createEvalStore({ file: cf });
  es.put(R(T(), 'relevance', 'relevant'));
  es.compact();
  assert.equal(fs.statSync(cf).mode & 0o777, 0o600);
});

test('loading is lazy: nothing is read or created before the first call', () => {
  const file = tmp();
  const es = createEvalStore({ file });
  const fs2 = createFeedbackStore({ file: `${file}.fb` });
  assert.equal(fs.existsSync(path.dirname(file)), false);
  assert.deepEqual(es.all(), []);
  assert.deepEqual(fs2.all(), []);
});

test('feedback set creates a record and a repeat updates it with the same id', () => {
  const file = tmp();
  const store = createFeedbackStore({ file });
  const t = T(3);
  const a = store.set({ target: t, rating: 'good', note: 'nice' });
  assert.equal(a.key, targetKey(t));
  assert.equal(a.annotator, 'human');
  assert.match(a.id, /^[0-9a-f]{16,}$/);
  const b = store.set({ target: t, rating: 'bad', note: 'actually no' });
  assert.equal(b.id, a.id);
  assert.equal(b.ts, a.ts);
  assert.ok(b.updatedAt >= a.updatedAt);
  assert.equal(store.get(targetKey(t)).rating, 'bad');
  assert.equal(store.all().length, 1);
  // The update rewrites the file, so it holds one line.
  assert.equal(lines(file).length, 1);
  assert.equal(createFeedbackStore({ file }).get(targetKey(t)).note, 'actually no');
});

test('feedback with no rating and an empty note deletes the record', () => {
  const file = tmp();
  const store = createFeedbackStore({ file });
  store.set({ target: T(1), rating: 'good', note: '' });
  store.set({ target: T(2), rating: null, note: 'only a note' });
  assert.equal(store.all().length, 2);
  assert.equal(store.set({ target: T(1), rating: null, note: '' }), null);
  assert.equal(store.get(targetKey(T(1))), null);
  assert.equal(createFeedbackStore({ file }).all().length, 1);
  assert.equal(store.set({ target: T(9), rating: null, note: '' }), null);
});

test('feedback lookups by session', () => {
  const store = createFeedbackStore({ file: tmp() });
  store.set({ target: T(1), rating: 'good' });
  store.set({ target: T(2), rating: 'bad' });
  store.set({ target: T(1, 's2'), rating: 'good' });
  assert.equal(store.forSession('claude', 's1').length, 2);
  assert.equal(store.forSession('codex', 's1').length, 0);
});

test('feedback rejects a long note, a bad rating and a missing target with status 400', () => {
  const store = createFeedbackStore({ file: tmp() });
  assert.throws(
    () => store.set({ target: T(), rating: 'good', note: 'x'.repeat(2001) }),
    (e) => e.status === 400,
  );
  assert.doesNotThrow(() => store.set({ target: T(), rating: 'good', note: 'x'.repeat(2000) }));
  assert.throws(
    () => store.set({ target: T(), rating: 'meh', note: '' }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => store.set({ target: { source: 'claude' }, rating: 'good' }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => store.set({ rating: 'good' }),
    (e) => e.status === 400,
  );
});
