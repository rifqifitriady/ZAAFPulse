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

test('a corrupt index is set aside and rebuilt from the .jsonl files, never overwritten', () => {
  const dir = tmp();
  const logs = [];
  const s = createDatasetStore({ dir, now: () => 1234, log: (m) => logs.push(m) });
  s.create({ name: 'Alpha' });
  s.add('alpha', [ex(), ex({ source: { source: 'claude', session: 's1', turn: 1, span: null } })]);
  fs.writeFileSync(path.join(dir, 'index.json'), '{ not json');
  const list = s.list();
  assert.deepEqual(
    list.map((d) => [d.slug, d.count]),
    [['alpha', 2]],
  );
  assert.equal(fs.readFileSync(path.join(dir, 'index.json.corrupt-1234'), 'utf8'), '{ not json');
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes(dir), 'the log holds no path');
  // The rebuilt index is on disk, so a later create keeps every dataset.
  s.create({ name: 'Gamma' });
  assert.equal(s.list().length, 2);
  assert.equal(s.examples('alpha').length, 2);
});

test('a missing index is an empty list and an unreadable one refuses to be overwritten', () => {
  const dir = tmp();
  const s = createDatasetStore({ dir });
  assert.deepEqual(s.list(), []);
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ datasets: 'nope' }));
  fs.writeFileSync(path.join(dir, 'solo.jsonl'), JSON.stringify(ex()) + '\n');
  assert.deepEqual(
    s.list().map((d) => [d.slug, d.count]),
    [['solo', 1]],
  );
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('index.json.corrupt-')));
});

test('create adopts an orphan .jsonl instead of hiding its examples', () => {
  const dir = tmp();
  const s = createDatasetStore({ dir });
  s.create({ name: 'a' });
  s.add('a', [ex()]);
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, datasets: [] }));
  const meta = s.create({ name: 'a' });
  assert.equal(meta.count, 1);
  assert.equal(s.examples('a').length, 1);
  // Import into an orphan keeps its rows too.
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, datasets: [] }));
  const r = s.importJsonl({ slug: 'a', jsonl: JSON.stringify(ex({ source: null })) });
  assert.equal(r.dataset.count, 2);
  assert.equal(s.examples('a').length, 2);
});

test('rows that do not parse are moved to <slug>.jsonl.bad, not destroyed by a rewrite', () => {
  const dir = tmp();
  const s = createDatasetStore({ dir });
  s.create({ name: 'a' });
  const [e] = s.add('a', [ex()]).added;
  fs.appendFileSync(path.join(dir, 'a.jsonl'), '{torn line\n[1,2]\n');
  s.update('a', e.id, { tags: ['x'] });
  assert.equal(fs.readFileSync(path.join(dir, 'a.jsonl'), 'utf8').split('\n').length, 2, 'only the good row remains');
  assert.equal(fs.readFileSync(path.join(dir, 'a.jsonl.bad'), 'utf8'), '{torn line\n[1,2]\n');
  s.removeExample('a', e.id);
  assert.equal(fs.readFileSync(path.join(dir, 'a.jsonl.bad'), 'utf8'), '{torn line\n[1,2]\n', 'not set aside twice');
  s.remove('a');
  assert.ok(!fs.existsSync(path.join(dir, 'a.jsonl.bad')));
});

test('source identifiers are masked and still match for hasSource and duplicates', () => {
  const dir = tmp();
  const s = createDatasetStore({ dir });
  s.create({ name: 'a' });
  const k = secret();
  const source = { source: `src-${k}`, session: `sess ${k}`, turn: 3, span: `span ${k}` };
  assert.equal(s.add('a', [ex({ source })]).added.length, 1);
  assert.ok(!fs.readFileSync(path.join(dir, 'a.jsonl'), 'utf8').includes(k), 'no live secret on disk');
  const stored = s.examples('a')[0].source;
  assert.match(stored.source, /hidden/);
  assert.match(stored.session, /hidden/);
  assert.match(stored.span, /hidden/);
  assert.equal(s.hasSource('a', source), true, 'the raw lookup key is masked the same way');
  assert.equal(s.hasSource('a', stored), true, 'and so is the stored one');
  assert.match(s.add('a', [ex({ source })]).skipped[0].reason, /already/);
});

test('update checks only what it changes', () => {
  const dir = tmp();
  const s = createDatasetStore({ dir });
  s.create({ name: 'a' });
  const [e] = s.add('a', [ex()]).added;
  // An evaluator that was in the registry when the example was saved and is gone now.
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, JSON.stringify({ ...e, evals: { retired_evaluator: 'x' } }) + '\n');
  const u = s.update('a', e.id, { tags: ['kept'], reference: 'ref' });
  assert.deepEqual(u.tags, ['kept']);
  assert.equal(u.reference.text, 'ref');
  assert.deepEqual(u.evals, { retired_evaluator: 'x' });
  assert.throws(
    () => s.update('a', e.id, { tags: ['bad tag'] }),
    (x) => x.status === 400,
  );
});

test('Windows device names cannot be slugs', () => {
  const s = createDatasetStore({ dir: tmp() });
  for (const slug of ['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9']) {
    assert.throws(
      () => s.create({ name: 'x', slug }),
      (e) => e.status === 400,
      slug,
    );
  }
  assert.equal(slugify('NUL'), null);
  assert.equal(s.create({ name: 'x', slug: 'com10' }).slug, 'com10');
});

test('a tag holding a secret is rejected and dataset names are masked', () => {
  const dir = tmp();
  const s = createDatasetStore({ dir });
  const k = secret();
  assert.equal(cleanExample(ex({ tags: [k] })).ok, false);
  const meta = s.create({ name: `Leaky ${k}`, slug: 'leaky' });
  assert.match(meta.name, /hidden/);
  assert.ok(!fs.readFileSync(path.join(dir, 'index.json'), 'utf8').includes(k));
  assert.ok(!s.rename('leaky', `again ${k}`).name.includes(k));
  const [e] = s.add('leaky', [ex()]).added;
  assert.throws(
    () => s.update('leaky', e.id, { tags: [k] }),
    (x) => x.status === 400,
  );
});

test('files stay private after a rewrite (POSIX)', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(tmp(), 'datasets');
  const s = createDatasetStore({ dir });
  s.create({ name: 'a' });
  const [e] = s.add('a', [ex()]).added;
  fs.chmodSync(path.join(dir, 'a.jsonl'), 0o644);
  s.update('a', e.id, { tags: ['x'] });
  assert.equal(fs.statSync(path.join(dir, 'a.jsonl')).mode & 0o777, 0o600);
  s.importJsonl({ slug: 'a', jsonl: JSON.stringify(ex({ source: null })) });
  assert.equal(fs.statSync(path.join(dir, 'a.jsonl')).mode & 0o777, 0o600);
  s.removeExample('a', e.id);
  assert.equal(fs.statSync(path.join(dir, 'a.jsonl')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'index.json')).mode & 0o777, 0o600);
});
