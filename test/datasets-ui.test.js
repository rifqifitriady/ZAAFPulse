// The Datasets view's pure helpers in public/datasetview.js, without a browser, and an audit of that file for
// HTML built from example text, tags, names or import reasons (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  dsListRows,
  dsPreview,
  dsTagsPatch,
  dsImportError,
  dsLinkHref,
  dsAddResult,
  dsSlugOf,
  dsRoute,
} = require('../public/datasetview');

const SRC = path.join(__dirname, '..', 'public', 'datasetview.js');
const HOUR = 3600e3;

test('dsListRows: newest change first, with a short "when"', () => {
  const now = Date.UTC(2026, 9, 22, 12);
  const rows = dsListRows(
    [
      { slug: 'old', name: 'Old one', count: 4, createdAt: now - 80 * HOUR, updatedAt: now - 3 * HOUR },
      { slug: 'new', name: 'New one', count: 0, createdAt: now - 60e3, updatedAt: now - 30e3 },
      { slug: 'days', name: 'Days', count: 12, createdAt: 0, updatedAt: now - 50 * HOUR },
      null,
      { name: 'no slug' },
    ],
    now,
  );
  assert.deepEqual(rows, [
    { slug: 'new', name: 'New one', count: 0, when: 'just now' },
    { slug: 'old', name: 'Old one', count: 4, when: '3 h ago' },
    { slug: 'days', name: 'Days', count: 12, when: '2 d ago' },
  ]);
  assert.equal(dsListRows([{ slug: 'm', name: 'M', count: 1, updatedAt: now - 5 * 60e3 }], now)[0].when, '5 min ago');
  assert.equal(dsListRows([{ slug: 'z', count: 1, updatedAt: 0 }], now)[0].name, 'z', 'no name: the slug');
  assert.deepEqual(dsListRows(null, now), []);
});

test('dsPreview: one line, cut with an ellipsis, and a notice for hidden text', () => {
  assert.equal(dsPreview('fix the\n  auth\tredirect '), 'fix the auth redirect');
  const long = dsPreview('a'.repeat(200));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('…'));
  assert.equal(dsPreview('b'.repeat(50), 20), `${'b'.repeat(19)}…`);
  assert.equal(dsPreview('exactly'.padEnd(160, '.')).length, 160, 'a text of exactly n is not cut');
  assert.ok(!dsPreview('exactly'.padEnd(160, '.')).endsWith('…'));
  assert.equal(dsPreview(null), '(hidden while content viewing is off)');
  assert.equal(dsPreview(''), '');
});

test('dsTagsPatch: commas and spaces split, R1 tag rule, at most 20', () => {
  assert.deepEqual(dsTagsPatch('auth, regression  billing:v2,,auth'), { tags: ['auth', 'regression', 'billing:v2'] });
  assert.deepEqual(dsTagsPatch('   '), { tags: [] }, 'an empty field clears the tags');
  assert.deepEqual(dsTagsPatch('ünïcode 日本'), { tags: ['ünïcode', '日本'] });
  const bad = dsTagsPatch('ok no/slash');
  assert.ok(bad.error && !bad.tags);
  assert.match(bad.error, /no\/slash/);
  assert.ok(dsTagsPatch('x'.repeat(41)).error, 'over 40 characters');
  const many = Array.from({ length: 21 }, (_, i) => `t${i}`).join(' ');
  assert.deepEqual(dsTagsPatch(many), { error: 'at most 20 tags' });
  assert.equal(dsTagsPatch(Array.from({ length: 20 }, (_, i) => `t${i}`).join(',')).tags.length, 20);
});

test('dsImportError: the first three reasons, else the message', () => {
  const err = Object.assign(new Error('the file has lines that cannot be imported'), {
    status: 400,
    reasons: ['line 2: not valid JSON', 'line 5: messages needs a user message', 'line 7: bad tag', 'line 9: x'],
  });
  assert.equal(
    dsImportError(err),
    'line 2: not valid JSON · line 5: messages needs a user message · line 7: bad tag · and 1 more',
  );
  assert.equal(dsImportError({ message: 'm', reasons: ['line 1: a'] }), 'line 1: a');
  assert.equal(dsImportError(new Error('jsonl must be text')), 'jsonl must be text');
  assert.equal(dsImportError({ message: 'x', reasons: [] }), 'x');
  assert.equal(dsImportError(null), 'Could not import the file');
});

test('dsLinkHref: back to the trace turn by key, nothing without one', () => {
  assert.equal(
    dsLinkHref({ source: 'claude', key: 'k_ab/c+=', turn: 3, span: 'sp' }),
    '#trace?key=k_ab%2Fc%2B%3D&turn=3',
  );
  assert.equal(dsLinkHref({ source: 'claude', key: 'abc', turn: 0, span: null }), '#trace?key=abc&turn=0');
  assert.equal(dsLinkHref({ source: 'claude', key: null, turn: 2, span: null }), null);
  assert.equal(dsLinkHref(null), null);
  assert.equal(dsLinkHref({ key: 'abc', turn: -1 }), '#trace?key=abc', 'a bad turn is left out');
});

test('dsRoute: the tab and the dataset of a Datasets hash', () => {
  assert.deepEqual(dsRoute('#datasets'), { tab: 'list', slug: null });
  assert.deepEqual(dsRoute('#datasets?ds=auth-regressions'), { tab: 'list', slug: 'auth-regressions' });
  assert.deepEqual(dsRoute('#datasets/experiments'), { tab: 'experiments', slug: null });
  assert.deepEqual(dsRoute('#datasets?ds=../x'), { tab: 'list', slug: null }, 'not a slug');
});

test('dsAddResult: added and skipped, with the reasons', () => {
  const skipped = [
    { index: 1, reason: 'already in this dataset' },
    { index: 2, reason: 'already in this dataset' },
    { index: 3, reason: 'unknown session' },
  ];
  assert.equal(
    dsAddResult({ added: [{ id: 'a' }, { id: 'b' }], skipped: skipped.slice(0, 1) }),
    'Added 2 · skipped 1: already in this dataset',
  );
  assert.equal(
    dsAddResult({ added: [], skipped }),
    'Added 0 · skipped 3: already in this dataset (2), unknown session',
  );
  assert.equal(dsAddResult({ added: [{ id: 'a' }], skipped: [] }), 'Added 1');
  assert.equal(dsAddResult(null), 'Added 0');
});

test('dsSlugOf: an import file name as a dataset slug', () => {
  assert.equal(dsSlugOf('Auth Regressions.jsonl'), 'auth-regressions');
  assert.equal(dsSlugOf('../evil/__x__.ndjson'), 'x');
  assert.equal(dsSlugOf('import.jsonl'), 'import-1', 'a reserved word gets a suffix');
  assert.equal(dsSlugOf('.jsonl'), 'imported');
  assert.equal(dsSlugOf('Ünïcode.jsonl'), 'unicode');
  assert.equal(dsSlugOf('日本.jsonl'), 'imported');
  assert.equal(dsSlugOf('COM1.jsonl'), 'com1-1');
  assert.equal(dsSlugOf('a'.repeat(90)).length, 64);
});

test('datasetview.js builds no HTML from example text, tags, names or reasons (S1)', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // Every innerHTML or insertAdjacentHTML use, up to the end of its statement, with each esc(...) call taken out.
  const sets = [
    ...src.matchAll(/\binnerHTML\s*\+?=\s*([\s\S]*?);\s*\n/g),
    ...src.matchAll(/\binsertAdjacentHTML\(([\s\S]*?)\);\s*\n/g),
    // The page shell viewDatasets returns is HTML too.
    ...src.matchAll(/function viewDatasets\(\) \{[\s\S]*?\n  return (`[\s\S]*?`);\n\}/g),
  ].map((m) => m[1]);
  assert.ok(sets.length > 1, 'the audit found the HTML it should check');
  for (const raw of sets) {
    const rhs = raw.replace(/\besc\((?:[^()]|\([^()]*\))*\)/g, '');
    assert.doesNotMatch(
      rhs,
      /\b(text|output|reference|input|messages|tags|reason|reasons|name)\b/,
      `innerHTML built from: ${rhs.slice(0, 120)}`,
    );
  }
  // The cells are filled as text.
  assert.match(src, /\.textContent\s*=\s*[^;\n]*\bdsPreview\(/);
  assert.doesNotMatch(src, /outerHTML|document\.write|DOMParser|createContextualFragment/);
});
