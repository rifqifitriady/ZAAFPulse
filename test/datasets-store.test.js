const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDatasetStore } = require('../lib/datasets/store');
const { LIMITS, MARK, capField, slugify, cleanExample } = require('../lib/datasets/shape');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-ds-'));
// Built at runtime so no live-looking key sits in the source.
const secret = () =>
  'sk-' +
  'ant-api03-' +
  Array.from({ length: 48 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7) % 36]).join('');
const ex = (over = {}) => ({
  source: { source: 'claude', session: 's1', turn: 0, span: null },
  input: {
    system: null,
    messages: [{ role: 'user', text: 'fix the login redirect' }],
    tools: [{ name: 'Read', description: '' }],
  },
  output: { text: 'Changed the redirect.', model: 'claude-opus-5-5' },
  ...over,
});

test('every text field is masked on save', () => {
  const dir = tmp();
  const s = createDatasetStore({ dir });
  s.create({ name: 'Auth regressions' });
  const k = secret();
  const { added } = s.add('auth-regressions', [
    ex({
      input: {
        system: `key ${k}`,
        messages: [
          { role: 'user', text: `use ${k}` },
          { role: 'tool', name: 'Bash', text: `KEY=${k}` },
        ],
        tools: [{ name: 'Bash', description: `takes ${k}` }],
      },
      output: { text: `done ${k}`, model: null },
      reference: { text: k },
    }),
  ]);
  assert.equal(added.length, 1);
  const raw = fs.readFileSync(path.join(dir, 'auth-regressions.jsonl'), 'utf8');
  assert.ok(!raw.includes(k), 'no live secret on disk');
  assert.match(s.examples('auth-regressions')[0].output.text, /hidden/);
});

test('caps: examples per dataset, field size and number of datasets', () => {
  const s = createDatasetStore({ dir: tmp(), limits: { ...LIMITS, examples: 2, datasets: 2 } });
  s.create({ name: 'a' });
  s.create({ name: 'b' });
  assert.throws(
    () => s.create({ name: 'c' }),
    (e) => e.status === 400 && /at most/.test(e.message),
  );
  const src = (turn) => ({ source: 'claude', session: 's1', turn, span: null });
  const r = s.add('a', [ex({ source: src(0) }), ex({ source: src(1) }), ex({ source: src(2) })]);
  assert.equal(r.added.length, 2);
  assert.match(r.skipped[0].reason, /full/);
  const long = 'a'.repeat(40000) + 'z'.repeat(40000);
  const capped = capField(long);
  assert.ok(capped.length <= LIMITS.field);
  assert.ok(capped.startsWith('aaa') && capped.endsWith('zzz') && capped.includes(MARK));
  assert.equal(cleanExample(ex({ output: { text: long, model: null } })).example.output.text, capped);
});

test('the same source is not added twice', () => {
  const s = createDatasetStore({ dir: tmp() });
  s.create({ name: 'a' });
  s.add('a', [ex()]);
  assert.match(s.add('a', [ex()]).skipped[0].reason, /already/);
  assert.equal(s.hasSource('a', { source: 'claude', session: 's1', turn: 0 }), true);
  assert.equal(s.hasSource('a', { source: 'claude', session: 's1', turn: 1 }), false);
});

test('import rejects malformed or oversize lines and writes nothing', () => {
  const s = createDatasetStore({ dir: tmp() });
  const good = JSON.stringify(ex());
  assert.throws(
    () => s.importJsonl({ slug: 'x', jsonl: `${good}\n{not json\n` }),
    (e) => e.status === 400 && /^line 2:/.test(e.reasons[0]),
  );
  const big = JSON.stringify(ex({ output: { text: 'a'.repeat(LIMITS.field + 1), model: null } }));
  assert.throws(
    () => s.importJsonl({ slug: 'x', jsonl: big }),
    (e) => /longer than 64 KB/.test(e.reasons[0]),
  );
  const role = JSON.stringify(ex({ input: { messages: [{ role: 'boss', text: 'hi' }] } }));
  assert.throws(
    () => s.importJsonl({ slug: 'x', jsonl: role }),
    (e) => e.status === 400,
  );
  assert.equal(s.get('x'), null, 'a rejected import creates no dataset');
});

test('import into an existing dataset is atomic, caps the total and renews clashing ids', () => {
  const s = createDatasetStore({ dir: tmp(), limits: { ...LIMITS, examples: 3 } });
  s.create({ name: 'a' });
  s.add('a', [ex()]);
  const file = s.exportJsonl('a');
  const r = s.importJsonl({ slug: 'a', jsonl: file });
  assert.equal(r.added, 1);
  const ids = s.examples('a').map((e) => e.id);
  assert.equal(new Set(ids).size, 2, 'the clashing id was renewed');
  assert.throws(
    () => s.importJsonl({ slug: 'a', jsonl: file + file }),
    (e) => e.status === 400 && e.reasons.length === 1,
  );
  assert.equal(s.get('a').count, 2, 'a refused import leaves the dataset as it was');
});

test('export then import round-trips every field', () => {
  const s = createDatasetStore({ dir: tmp() });
  s.create({ name: 'a' });
  s.add('a', [
    ex({ reference: { text: 'expected' }, tags: ['auth', 'p1'], evals: { relevance: 'partly' }, feedback: 'bad' }),
  ]);
  const r = s.importJsonl({ slug: 'b', name: 'Copy', jsonl: s.exportJsonl('a') });
  assert.equal(r.added, 1);
  assert.deepEqual(s.examples('b'), s.examples('a'));
  assert.equal(s.get('b').name, 'Copy');
});

test('an example keeps only known fields and rejects bad evals, feedback and tags', () => {
  const ok = cleanExample(ex({ extra: 1, tags: ['a', 'a'], input: { ...ex().input, junk: true } }));
  assert.ok(ok.ok);
  assert.deepEqual(Object.keys(ok.example).sort(), [
    'createdAt',
    'evals',
    'feedback',
    'id',
    'input',
    'output',
    'reference',
    'source',
    'tags',
    'updatedAt',
  ]);
  assert.deepEqual(Object.keys(ok.example.input).sort(), ['messages', 'system', 'tools']);
  assert.match(ok.example.id, /^ex_[0-9a-f]{16}$/);
  assert.equal(cleanExample(ex({ evals: { nope: 'x' } })).ok, false);
  assert.equal(cleanExample(ex({ evals: { relevance: 'x' } })).ok, false);
  assert.equal(cleanExample(ex({ feedback: 'meh' })).ok, false);
  assert.equal(
    cleanExample(ex({ input: { messages: [{ role: 'assistant', text: 'hi' }] } })).ok,
    false,
    'needs a user message',
  );
  const many = Array.from({ length: 51 }, () => ({ role: 'user', text: 'x' }));
  assert.equal(cleanExample(ex({ input: { messages: many } })).ok, false);
  assert.equal(cleanExample(ex(), { limits: { ...LIMITS, exampleBytes: 100 } }).ok, false);
  const keep = cleanExample(ex({ id: 'ex_0123456789abcdef', createdAt: 5, updatedAt: 6 }));
  assert.deepEqual([keep.example.id, keep.example.createdAt, keep.example.updatedAt], ['ex_0123456789abcdef', 5, 6]);
});

test('slugs, rename, edit, delete', () => {
  const s = createDatasetStore({ dir: tmp() });
  assert.equal(slugify('  ÄB c!! '), 'ab-c');
  assert.equal(s.create({ name: 'Auth regressions' }).slug, 'auth-regressions');
  assert.throws(
    () => s.create({ name: 'Auth regressions' }),
    (e) => e.status === 409,
  );
  assert.throws(
    () => s.create({ name: 'x', slug: 'import' }),
    (e) => e.status === 400,
  );
  assert.equal(s.rename('auth-regressions', 'Auth').name, 'Auth');
  const [e] = s.add('auth-regressions', [ex()]).added;
  const k = secret();
  assert.match(s.update('auth-regressions', e.id, { reference: `ref ${k}` }).reference.text, /hidden/);
  assert.deepEqual(s.update('auth-regressions', e.id, { tags: ['a', 'a', 'b'] }).tags, ['a', 'b']);
  assert.throws(
    () => s.update('auth-regressions', e.id, { tags: ['no spaces'] }),
    (x) => x.status === 400,
  );
  assert.throws(
    () => s.update('auth-regressions', 'ex_0000000000000000', { tags: [] }),
    (x) => x.status === 404,
  );
  assert.equal(s.update('auth-regressions', e.id, { reference: null }).reference, null);
  assert.equal(s.removeExample('auth-regressions', e.id), true);
  assert.equal(s.list()[0].count, 0);
  assert.throws(
    () => s.examples('nope'),
    (x) => x.status === 404 && !/[\\/]/.test(x.message),
  );
  assert.equal(s.remove('auth-regressions'), true);
  assert.deepEqual(s.list(), []);
});

test('files are private (POSIX)', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(tmp(), 'datasets');
  const s = createDatasetStore({ dir });
  s.create({ name: 'a' });
  s.add('a', [ex()]);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'a.jsonl')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'index.json')).mode & 0o777, 0o600);
});
