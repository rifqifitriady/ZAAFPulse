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
  dsRunOf,
  dsLinkedRun,
  dsModelOptions,
  dsRunBody,
  dsResultCells,
  dsPassTable,
  dsCompare,
  dsProgressLine,
  dsStopLine,
  dsPgParams,
  dsPg,
  dsPgEdit,
  dsPgFormBody,
  dsPgSendBody,
  dsPvModel,
  dsAutoAddBody,
  dsAutoAddEl,
  dsPgRunBlock,
  dsReplayTarget,
  dsAddOrWhy,
  dsMergeProgress,
  dsPollDelay,
  dsDeltaText,
  dsResultsEl,
  dsImportTooBig,
  dsMountExamples,
  dsWrapFocus,
  dsPgSendPlan,
  dsPgOnError,
  dsPaintExperiments,
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

test('dsRunOf: the experiment a Datasets hash opens, from the Value page link', () => {
  assert.equal(dsRunOf('#datasets/experiments?run=exp_00000000000000a0'), 'exp_00000000000000a0');
  assert.equal(dsRunOf('datasets/experiments?ds=x&run=exp_0123456789abcdef'), 'exp_0123456789abcdef', 'no # is fine');
  for (const h of [
    '#datasets/experiments',
    '#datasets?run=exp_00000000000000a0', // the list tab opens no run
    '#datasets/experiments?run=exp_1',
    '#datasets/experiments?run=../x',
    '#datasets/experiments?run=EXP_00000000000000A0',
    '',
    null,
  ])
    assert.equal(dsRunOf(h), null, String(h));
  assert.deepEqual(dsRoute('#datasets/experiments?run=exp_00000000000000a0'), { tab: 'experiments', slug: null });
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
    // The page shell viewDatasets returns is HTML too, and so is the Playground's Dataset mode shell.
    ...src.matchAll(/function viewDatasets\(\) \{[\s\S]*?\n  return (`[\s\S]*?`);\n\}/g),
    ...src.matchAll(/function dsPlayground\(pg\) \{[\s\S]*?\n  return (`[\s\S]*?`);\n\}/g),
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
  // The cells are filled as text: example previews, replayed outputs, proposals, errors and the preview messages.
  assert.match(src, /\.textContent\s*=\s*[^;\n]*\bdsPreview\(/);
  assert.match(src, /\.textContent\s*=\s*[^;\n]*\bcell\.text\b/);
  assert.match(src, /\.textContent\s*=\s*[^;\n]*\bcell\.proposal\.arguments\b/);
  assert.match(src, /\.textContent\s*=\s*[^;\n]*\bm\.content\b/);
  assert.match(src, /\.textContent\s*=\s*[^;\n]*\bfn\.description\b/);
  assert.doesNotMatch(src, /outerHTML|document\.write|DOMParser|createContextualFragment/);
});

// The models GET /api/experiments lists: local first, as the gateway orders them.
const MODELS = [
  { name: 'ollama/qwen3-coder:30b', provider: 'ollama', label: 'Ollama', tier: 'private', priced: true },
  { name: 'lmstudio/mistral-small', provider: 'lmstudio', label: 'LM Studio', tier: 'private', priced: true },
  { name: 'anthropic/claude-haiku-5-5', provider: 'anthropic', label: 'Anthropic', tier: 'external', priced: true },
  { name: 'openai/gpt-6.1', provider: 'openai', label: 'OpenAI', tier: 'external', priced: false },
  { name: 'groq/qwen3-32b', provider: 'groq', label: 'Groq', tier: 'external', priced: true },
];

test('dsModelOptions: local models first and preselected, external ones never', () => {
  assert.deepEqual(dsModelOptions(MODELS), {
    groups: [
      {
        label: 'On this machine',
        options: [
          { value: 'ollama/qwen3-coder:30b', label: 'ollama/qwen3-coder:30b', external: false },
          { value: 'lmstudio/mistral-small', label: 'lmstudio/mistral-small', external: false },
        ],
      },
      {
        label: 'External (sends masked text)',
        options: [
          { value: 'anthropic/claude-haiku-5-5', label: 'anthropic/claude-haiku-5-5', external: true },
          { value: 'groq/qwen3-32b', label: 'groq/qwen3-32b', external: true },
        ],
      },
    ],
    defaults: ['ollama/qwen3-coder:30b'],
  });
  // An external model without a price is left out: the server refuses it, as the cost cap could not count it.
  const onlyExternal = dsModelOptions(MODELS.filter((m) => m.tier === 'external'));
  assert.deepEqual(onlyExternal.defaults, [], 'no local model: nothing preselected');
  assert.deepEqual(onlyExternal.groups[0], { label: 'On this machine', options: [] });
  assert.equal(onlyExternal.groups[1].options.length, 2);
  assert.deepEqual(dsModelOptions(null), {
    groups: [
      { label: 'On this machine', options: [] },
      { label: 'External (sends masked text)', options: [] },
    ],
    defaults: [],
  });
});

test('dsRunBody: a good body, the whole dataset or one example, and every refusal', () => {
  const good = {
    dataset: 'auth-regressions',
    example: '',
    models: ['ollama/qwen3-coder:30b', 'anthropic/claude-haiku-5-5'],
    evaluators: ['reference_match', 'secret_leak'],
    maxCostUSD: '0.5',
    maxRequests: '100',
  };
  assert.deepEqual(dsRunBody(good), {
    dataset: 'auth-regressions',
    models: ['ollama/qwen3-coder:30b', 'anthropic/claude-haiku-5-5'],
    evaluators: ['reference_match', 'secret_leak'],
    maxCostUSD: 0.5,
    maxRequests: 100,
  });
  assert.deepEqual(dsRunBody({ ...good, example: 'ex_0000000000000001' }).examples, ['ex_0000000000000001']);
  assert.deepEqual(dsRunBody({ ...good, maxCostUSD: 10, maxRequests: 1000 }).maxRequests, 1000, 'the top of R8');
  const refused = (patch, re) => {
    const r = dsRunBody({ ...good, ...patch });
    assert.ok(r.error && !r.dataset, `refused: ${JSON.stringify(patch)}`);
    assert.match(r.error, re);
  };
  refused({ dataset: '' }, /dataset/i);
  refused({ models: [] }, /model/i);
  refused({ models: ['a/1', 'a/2', 'a/3', 'a/4'] }, /model/i);
  refused({ evaluators: [] }, /evaluator/i);
  for (const maxCostUSD of ['0', '-1', '10.01', 'abc', '']) refused({ maxCostUSD }, /cost/i);
  for (const maxRequests of ['0', '1001', '2.5', 'x', '']) refused({ maxRequests }, /request/i);
  assert.equal(dsRunBody(null).error.length > 0, true);
});

// A finished run as GET /api/experiments/:id sends it.
const RECORD = {
  id: 'exp_00000000000000a1',
  dataset: 'auth-regressions',
  models: ['ollama/qwen3-coder:30b', 'lmstudio/mistral-small', 'anthropic/claude-haiku-5-5'],
  evaluators: ['reference_match', 'secret_leak', 'relevance'],
  status: 'stopped',
  stopped: 'cost cap',
  caps: { maxCostUSD: 0.5, maxRequests: 100 },
  perExample: [
    {
      exampleId: 'ex_1',
      model: 'anthropic/claude-haiku-5-5',
      output: { text: '', proposal: { name: 'Bash', arguments: '{"command":"npm test"}' } },
      error: null,
      labels: { secret_leak: { label: 'clean', score: 1, pass: true }, relevance: null },
    },
    {
      exampleId: 'ex_1',
      model: 'ollama/qwen3-coder:30b',
      output: { text: 'Fixed the redirect.', proposal: null },
      error: null,
      labels: {
        secret_leak: { label: 'clean', score: 1, pass: true },
        relevance: { label: 'partly', score: 0.5, pass: false },
      },
    },
    {
      exampleId: 'ex_1',
      model: 'lmstudio/mistral-small',
      output: null,
      error: 'connection refused',
      labels: { secret_leak: null, relevance: null },
    },
    {
      exampleId: 'ex_2',
      model: 'ollama/qwen3-coder:30b',
      output: { text: null, proposal: null },
      error: null,
      labels: {},
    },
    { exampleId: 'ex_2', model: 'lmstudio/mistral-small', output: null, error: null, labels: {} },
  ],
};

test('dsResultCells: the original first, then each model in record order, with errors and proposals', () => {
  const example = { id: 'ex_1', output: { text: 'The original answer.', model: 'claude-opus' } };
  assert.deepEqual(dsResultCells(RECORD, example), [
    { head: 'Original output', text: 'The original answer.', labels: [], proposal: null, error: null, note: null },
    {
      head: 'ollama/qwen3-coder:30b',
      text: 'Fixed the redirect.',
      labels: [
        { id: 'secret_leak', label: 'clean', pass: true },
        { id: 'relevance', label: 'partly', pass: false },
      ],
      proposal: null,
      error: null,
      note: null,
    },
    { head: 'lmstudio/mistral-small', text: null, labels: [], proposal: null, error: 'connection refused', note: null },
    {
      head: 'anthropic/claude-haiku-5-5',
      text: '',
      // A missing verdict shows as such; reference_match is not there for an example without a reference.
      labels: [
        { id: 'secret_leak', label: 'clean', pass: true },
        { id: 'relevance', label: null, pass: false },
      ],
      proposal: { name: 'Bash', arguments: '{"command":"npm test"}' },
      error: null,
      note: null,
    },
  ]);
  // Content off: texts are null and an error's reason is gone; a model the run never reached says so.
  const two = dsResultCells(RECORD, { id: 'ex_2', output: { text: null } });
  assert.equal(two[0].text, null);
  assert.equal(two[1].text, null);
  assert.equal(two[1].error, null);
  assert.match(two[2].error, /hidden/);
  assert.match(two[3].note, /not run/i);
  // An example since deleted from the dataset keeps its replayed cells.
  const gone = dsResultCells(RECORD, { id: 'ex_1' }, 'ready');
  assert.match(gone[0].note, /no longer/i);
  assert.equal(gone[1].text, 'Fixed the redirect.');
});

test('dsPassTable: one row per model, one cell per evaluator, n/a when nothing counted', () => {
  const summary = {
    models: {
      'ollama/a': {
        evaluators: {
          reference_match: { pass: 1, total: 2, rate: 0.5 },
          secret_leak: { pass: 2, total: 2, rate: 1 },
        },
      },
      'anthropic/b': { evaluators: { reference_match: { pass: 0, total: 0, rate: null } } },
    },
  };
  assert.deepEqual(dsPassTable(summary, ['reference_match', 'secret_leak']), [
    {
      model: 'ollama/a',
      cells: [
        { evaluator: 'reference_match', rate: 0.5, pass: 1, total: 2 },
        { evaluator: 'secret_leak', rate: 1, pass: 2, total: 2 },
      ],
    },
    {
      model: 'anthropic/b',
      cells: [
        { evaluator: 'reference_match', rate: null, pass: 0, total: 0 },
        { evaluator: 'secret_leak', rate: null, pass: 0, total: 0 },
      ],
    },
  ]);
  assert.deepEqual(dsPassTable(null, ['x']), []);
});

test('dsCompare: the evaluator and model pairs both runs have, with the change', () => {
  const rates = (m) => ({
    models: Object.fromEntries(
      Object.entries(m).map(([model, evs]) => [
        model,
        {
          evaluators: Object.fromEntries(
            Object.entries(evs).map(([id, rate]) => [id, { rate, pass: 0, total: rate === null ? 0 : 4 }]),
          ),
        },
      ]),
    ),
  });
  const a = {
    models: ['ollama/a', 'ollama/b'],
    evaluators: ['secret_leak', 'relevance', 'faithfulness'],
    summary: rates({
      'ollama/a': { secret_leak: 1, relevance: 0.5, faithfulness: 0.25 },
      'ollama/b': { secret_leak: 0.5, relevance: null, faithfulness: 1 },
    }),
  };
  const b = {
    models: ['ollama/b', 'anthropic/c'],
    evaluators: ['relevance', 'secret_leak', 'task_completion'],
    summary: rates({
      'ollama/b': { secret_leak: 0.75, relevance: 0.5 },
      'anthropic/c': { secret_leak: 1, relevance: 1, task_completion: 1 },
    }),
  };
  assert.deepEqual(dsCompare(a, b), [
    { evaluator: 'secret_leak', model: 'ollama/b', a: 0.5, b: 0.75, delta: 0.25 },
    { evaluator: 'relevance', model: 'ollama/b', a: null, b: 0.5, delta: null },
  ]);
  assert.deepEqual(dsCompare(b, a)[0], { evaluator: 'relevance', model: 'ollama/b', a: 0.5, b: null, delta: null });
  assert.equal(dsCompare(b, a)[1].delta, -0.25);
  assert.deepEqual(dsCompare(a, { models: [], evaluators: [] }), []);
  assert.deepEqual(dsCompare(null, b), []);
});

test('dsProgressLine and dsStopLine: a running and a stopped run in words', () => {
  assert.equal(dsProgressLine({ done: 12, total: 40, requests: 15, cost: 0.03 }), '12 / 40 · 15 requests · $0.03');
  assert.equal(dsProgressLine({ done: 0, total: 3, requests: 1, cost: 0 }), '0 / 3 · 1 request · $0.00');
  assert.equal(dsProgressLine({ done: 1, total: 2, requests: 2, cost: 0.0061 }), '1 / 2 · 2 requests · $0.0061');
  assert.equal(dsProgressLine(null), '0 / 0 · 0 requests · $0.00');
  const caps = { maxCostUSD: 0.5, maxRequests: 100 };
  assert.equal(dsStopLine({ status: 'done', stopped: null, caps }), null);
  assert.equal(dsStopLine({ status: 'stopped', stopped: 'cost cap', caps }), 'Stopped at the cost cap ($0.50)');
  assert.equal(dsStopLine({ status: 'stopped', stopped: 'request cap', caps }), 'Stopped at the request cap (100)');
  assert.equal(dsStopLine({ status: 'stopped', stopped: 'error', caps }), 'Stopped: the run failed');
  assert.equal(dsStopLine({ status: 'stopped', stopped: 'cancelled', caps }), 'Stopped before the end, on request');
});

test('dsPgParams: the dataset and example a Replay link opens the Playground on', () => {
  assert.deepEqual(dsPgParams('#gateway/playground?ds=auth-regressions&ex=ex_00000000000000a1'), {
    slug: 'auth-regressions',
    ex: 'ex_00000000000000a1',
  });
  assert.deepEqual(dsPgParams('#gateway/playground?ds=auth'), { slug: 'auth', ex: '' });
  assert.deepEqual(dsPgParams('#gateway/playground?ds=auth&ex=../x'), { slug: 'auth', ex: '' }, 'not an id');
  assert.equal(dsPgParams('#gateway/playground'), null);
  assert.equal(dsPgParams('#gateway/playground?ds=../x'), null);
  assert.equal(dsPgParams('#gateway?ds=auth'), null, 'only the Playground');
});

test('the external preview: any change to the form drops it, and Send never posts a stale body', () => {
  // The form state with a preview built from it, as dsPgRun leaves it.
  const open = () => {
    const s = dsPg({});
    Object.assign(s, {
      slug: 'auth-regressions',
      ex: '',
      picked: ['ollama/qwen3-coder:30b', 'anthropic/claude-haiku-5-5'],
      evs: ['secret_leak', 'relevance'],
      maxCostUSD: '0.5',
      maxRequests: '100',
    });
    s.preview = { items: [], confirm: 'tok', body: dsPgFormBody(s), providers: ['Anthropic'] };
    return s;
  };
  const edits = [
    ['cost', '0.05'],
    ['req', '10'],
    ['ds', 'pagination'],
    ['ex', 'ex_0000000000000001'],
    ['model', 'lmstudio/mistral-small', true],
    ['model', 'anthropic/claude-haiku-5-5', false],
    ['ev', 'task_completion', true],
    ['ev', 'secret_leak', false],
  ];
  for (const [act, value, checked] of edits) {
    const s = open();
    dsPgEdit(s, act, value, checked);
    assert.equal(s.preview, null, `${act} ${value} drops the preview`);
  }
  // Send posts the previewed body only while the form still matches it.
  const s = open();
  assert.equal(dsPgSendBody(s).maxCostUSD, 0.5);
  s.maxCostUSD = '0.05'; // a cap changed without going through dsPgEdit
  assert.equal(dsPgSendBody(s), null, 'a stale preview is not sent');
  // A fourth model is refused and leaves the preview alone.
  const full = open();
  full.picked.push('ollama/b');
  const r = dsPgEdit(full, 'model', 'ollama/c', true);
  assert.match(r.error, /three/i);
  assert.ok(full.preview);
});

// A tiny stand-in for `document`: nodes record their children and text, and innerHTML is refused.
function fakeDoc() {
  const el = (tag) => {
    const node = {
      tag,
      children: [],
      className: '',
      attrs: {},
      dataset: {},
      on: {},
      textContent: '',
      classList: { add() {}, toggle() {} },
    };
    node.append = (...c) => node.children.push(...c);
    node.replaceChildren = (...c) => (node.children = c);
    node.setAttribute = (k, v) => (node.attrs[k] = String(v));
    node.addEventListener = (type, fn) => (node.on[type] = node.on[type] || []).push(fn);
    node.querySelectorAll = (sel) =>
      walkAll(node).filter((n) => n && typeof n === 'object' && n.className.split(' ').includes(sel.slice(1)));
    Object.defineProperty(node, 'innerHTML', {
      set() {
        throw new Error('innerHTML used for content');
      },
    });
    return node;
  };
  return { createElement: el };
}

test('the external preview lists the declared tools as text, exactly as the server sends them', () => {
  const saved = global.document;
  global.document = fakeDoc();
  try {
    const block = dsPvModel({
      model: 'anthropic/claude-haiku-5-5',
      messages: [{ role: 'user', content: 'fix it' }],
      tools: [
        { type: 'function', function: { name: 'Mail', description: 'Ask ‹email› <img src=x onerror=alert(1)>' } },
        { type: 'function', function: { name: 'Bash', description: '' } },
      ],
    });
    const nodes = [];
    const walk = (n) => {
      nodes.push(n);
      if (n && Array.isArray(n.children)) n.children.forEach(walk);
    };
    walk(block);
    const texts = nodes.map((n) => (typeof n === 'string' ? n : n.textContent)).filter(Boolean);
    assert.ok(texts.includes('fix it'), 'the message');
    assert.ok(texts.includes('Mail') && texts.includes('Bash'), 'every tool name');
    assert.ok(texts.includes('Ask ‹email› <img src=x onerror=alert(1)>'), 'the masked description, as text');
    assert.ok(
      texts.some((t) => /tools/i.test(t)),
      'the tool list is labelled',
    );
  } finally {
    if (saved === undefined) delete global.document;
    else global.document = saved;
  }
});

// Every node under a fake-document tree, strings included.
const walkAll = (root) => {
  const nodes = [];
  const walk = (n) => {
    nodes.push(n);
    if (n && Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(root);
  return nodes;
};
const textOf = (n) => (typeof n === 'string' ? n : [n.textContent || '', ...(n.children || []).map(textOf)].join(''));
function withFakeDoc(fn) {
  const saved = global.document;
  global.document = fakeDoc();
  try {
    return fn();
  } finally {
    if (saved === undefined) delete global.document;
    else global.document = saved;
  }
}

test('dsAutoAddBody: a dataset is needed to turn auto-add on, and the body is exactly the settings', () => {
  assert.deepEqual(dsAutoAddBody({ enabled: true, dataset: '', onFail: true, onBad: false }), {
    error: 'Pick a dataset for auto-add',
  });
  assert.deepEqual(dsAutoAddBody({ enabled: true, dataset: 'auth-regressions', onFail: true, onBad: false }), {
    autoAdd: { enabled: true, dataset: 'auth-regressions', onFail: true, onBad: false },
  });
  assert.deepEqual(dsAutoAddBody({ enabled: false, dataset: '', onFail: false, onBad: true }), {
    autoAdd: { enabled: false, dataset: '', onFail: false, onBad: true },
  });
});

test('the auto-add section: dataset names as option text, the content-off note, and no dataset to pick', () => {
  const cfg = { autoAdd: { enabled: true, dataset: 'evil', onFail: true, onBad: true } };
  const evil = '<img src=x onerror=1>';
  withFakeDoc(() => {
    const on = walkAll(dsAutoAddEl(cfg, [{ slug: 'evil', name: evil, count: 1 }], true));
    const options = on.filter((n) => n && n.tag === 'option');
    assert.ok(
      options.some((o) => o.children.includes(evil) || o.textContent === evil),
      'the name is an option text',
    );
    assert.ok(
      options.some((o) => o.value === 'evil'),
      'the slug is the value',
    );
    const texts = on.map(textOf);
    assert.ok(texts.includes('Add turns that went wrong automatically'));
    assert.ok(texts.includes('When a judge evaluator fails a turn'));
    assert.ok(texts.includes('When you rate a turn 👎'));
    assert.ok(!texts.some((t) => /content viewing is off/.test(t)), 'no note while content is on');

    const off = walkAll(dsAutoAddEl(cfg, [{ slug: 'evil', name: evil, count: 1 }], false)).map(textOf);
    assert.ok(off.includes('Auto-add does nothing while content viewing is off.'));

    const none = walkAll(dsAutoAddEl({ autoAdd: { enabled: false, dataset: '' } }, [], true));
    const sel = none.find((n) => n && n.tag === 'select');
    assert.ok(sel && 'disabled' in sel.attrs, 'no dataset: the select is disabled');
    assert.ok(none.map(textOf).includes('Create a dataset first'));
  });
});

test('Stop: the progress block offers it while running, and says Stopping… once asked', () => {
  const base = { slug: 'auth', datasets: [{ slug: 'auth', name: 'Auth', count: 2 }], runId: 'exp_00000000000000a1' };
  withFakeDoc(() => {
    const running = walkAll(dsPgRunBlock({ ...base, progress: { dataset: 'auth', done: 1, total: 4 } }));
    const btn = running.find((n) => n && n.tag === 'button');
    assert.ok(btn, 'a Stop button');
    assert.equal(textOf(btn), 'Stop after the current call');
    assert.ok(!('disabled' in btn.attrs));

    const stopping = walkAll(
      dsPgRunBlock({ ...base, progress: { dataset: 'auth', done: 1, total: 4, cancelling: true } }),
    );
    const b2 = stopping.find((n) => n && n.tag === 'button');
    assert.equal(textOf(b2), 'Stopping…');
    assert.ok('disabled' in b2.attrs, 'disabled while stopping');
    assert.ok(stopping.map(textOf).some((t) => t.endsWith(' · stopping after the current call')));
  });
});

test('dsReplayTarget: replay only an example that is in the dataset, else say why', () => {
  const item = { key: 'k1', turn: 2 };
  const a = dsReplayTarget({ slug: 'auth', added: [{ id: 'e1' }], skipped: [], examples: null, item });
  assert.equal(a.hash, '#gateway/playground?ds=auth&ex=e1');
  assert.ok(a.hash.includes('&ex=e1'));
  assert.deepEqual(
    dsReplayTarget({
      slug: 'auth',
      added: [],
      skipped: [{ index: 0, reason: 'this session has no text' }],
      examples: [{ id: 'ex_other', link: { key: 'k1', turn: 0 } }],
      item,
    }),
    { message: 'Not replayed: this session has no text' },
  );
  assert.deepEqual(dsReplayTarget({ slug: 'auth', added: [], skipped: [], examples: [], item }), {
    message: 'Not replayed: the turn was not found in the dataset',
  });
  const saved = dsReplayTarget({
    slug: 'auth',
    added: [],
    skipped: [{ index: 0, reason: 'already in this dataset' }],
    examples: [
      { id: 'ex_other', link: { key: 'k1', turn: 0 } },
      { id: 'ex_0000000000000002', link: { key: 'k1', turn: 2 } },
    ],
    item,
  });
  assert.equal(saved.hash, '#gateway/playground?ds=auth&ex=ex_0000000000000002');
});

test('dsAddOrWhy: the add body, or why there is none yet', () => {
  const saved = global.trAddBody;
  try {
    global.trAddBody = () => null;
    assert.deepEqual(dsAddOrWhy([], {}), { why: 'The session is still loading. Try again in a moment.' });
    global.trAddBody = (sel) => ({ items: sel });
    assert.deepEqual(dsAddOrWhy([{ key: 'k', turn: 1 }], {}), { body: { items: [{ key: 'k', turn: 1 }] } });
  } finally {
    if (saved === undefined) delete global.trAddBody;
    else global.trAddBody = saved;
  }
});

test('dsMergeProgress: a poll without the dataset keeps it', () => {
  const prev = { dataset: 'auth', done: 0, total: 4, requests: 0, cost: 0 };
  assert.deepEqual(dsMergeProgress(prev, { done: 2, total: 4, requests: 2, cost: 0.01 }), {
    dataset: 'auth',
    done: 2,
    total: 4,
    requests: 2,
    cost: 0.01,
  });
  assert.deepEqual(dsMergeProgress(prev, null), prev);
  assert.deepEqual(dsMergeProgress(null, { done: 1 }), { done: 1 });
});

test('dsPollDelay: 2 s doubling per failure, at most 30 s', () => {
  assert.equal(dsPollDelay(0), 2000);
  assert.equal(dsPollDelay(1), 4000);
  assert.equal(dsPollDelay(4), 30000);
  assert.equal(dsPollDelay(9), 30000);
});

test('dsResultCells: a missing example is only "no longer in the dataset" once the dataset is read', () => {
  const ex = { id: 'ex_1' };
  assert.equal(dsResultCells(RECORD, ex, 'loading')[0].note, 'Loading the dataset…');
  assert.equal(dsResultCells(RECORD, ex, 'error')[0].note, 'Could not read the dataset');
  assert.equal(dsResultCells(RECORD, ex, 'ready')[0].note, 'No longer in the dataset');
});

test('dsDeltaText: rounded points, ±0 for less than half a point', () => {
  assert.deepEqual(dsDeltaText(null), { text: '—', tone: '' });
  assert.deepEqual(dsDeltaText(0.004), { text: '±0', tone: '' });
  assert.deepEqual(dsDeltaText(-0.004), { text: '±0', tone: '' });
  assert.deepEqual(dsDeltaText(0.006), { text: '+1 pts', tone: 'up' });
  assert.deepEqual(dsDeltaText(-0.2), { text: '−20 pts', tone: 'down' });
});

test('the content-off notice of a run names what is hidden', () => {
  withFakeDoc(() => {
    const texts = walkAll(dsResultsEl({ ...RECORD, perExample: [] }, [], false, 'ready')).map(textOf);
    assert.ok(
      texts.includes('Labels and pass rates are shown; outputs, proposal arguments and errors are not.'),
      'the notice text',
    );
    assert.ok(texts.some((t) => t.includes('proposal arguments')));
  });
});

test('dsSlugOf derives the slug the server would, or one it accepts (D-T6-3)', () => {
  const { slugify, validSlug } = require('../lib/datasets/shape');
  for (const name of ['Auth regressions', 'CON', 'import', '  ', 'Ünïcode name', 'a'.repeat(80)]) {
    const server = slugify(name);
    const page = dsSlugOf(name);
    // Where the server makes a slug from the name, the page names the same one; where it refuses (a reserved word,
    // nothing left), the page's pick must be one the server takes.
    if (server) assert.equal(page, server, JSON.stringify(name));
    else assert.ok(validSlug(page), `${JSON.stringify(name)}: the page picks "${page}", which the server refuses`);
  }
});

test('dsImportTooBig: the JSON body, not the file, against the 16 MB import limit (D-T6-6)', () => {
  const MAX = 16 * 1024 * 1024;
  assert.equal(dsImportTooBig('a'.repeat(MAX + 1)), true, 'just over');
  assert.equal(dsImportTooBig('a'.repeat(MAX - 1)), false, 'just under');
  assert.equal(dsImportTooBig('€'.repeat(6 * 1024 * 1024)), true, 'bytes count, not characters');
});

test('the examples view labels the reference button and each row by its number (D-T6-7)', async () => {
  const savedDoc = global.document;
  const savedApi = global.api;
  global.document = fakeDoc();
  const ex = (n) => ({
    id: `ex_000000000000000${n}`,
    input: { messages: [{ role: 'user', text: `question ${n}` }] },
    output: { text: `answer ${n}` },
    reference: n === 1 ? { text: 'the wanted answer' } : null,
    tags: ['auth', 'regression'],
  });
  global.api = async () => ({ dataset: { slug: 'auth', name: 'Auth' }, examples: [ex(1), ex(2)] });
  try {
    const body = fakeDoc().createElement('div');
    await dsMountExamples(body, 'auth', () => true);
    const nodes = walkAll(body);
    const refs = nodes.filter((n) => n && n.tag === 'button' && /\bds-ref\b/.test(n.className));
    assert.equal(refs.length, 2);
    for (const b of refs) assert.equal(b.attrs['aria-label'], 'Edit reference');
    const tags = nodes.filter((n) => n && n.tag === 'input' && /\bds-tags\b/.test(n.className));
    assert.deepEqual(
      tags.map((n) => n.attrs['aria-label']),
      ['Tags of example 1', 'Tags of example 2'],
    );
    const dels = nodes.filter((n) => n && n.tag === 'button' && textOf(n) === 'Delete');
    assert.deepEqual(
      dels.map((n) => n.attrs['aria-label']),
      ['Delete example 1', 'Delete example 2'],
    );
  } finally {
    if (savedDoc === undefined) delete global.document;
    else global.document = savedDoc;
    if (savedApi === undefined) delete global.api;
    else global.api = savedApi;
  }
});

test('dsWrapFocus: Tab past the last control of the picker goes to the first, Shift-Tab back to the last', () => {
  const [a, b, c] = ['select', 'go', 'cancel'];
  assert.equal(dsWrapFocus([a, b, c], c, false), a);
  assert.equal(dsWrapFocus([a, b, c], a, true), c);
  assert.equal(dsWrapFocus([a, b, c], b, false), null, 'inside the list the browser moves focus');
  assert.equal(dsWrapFocus([a, b, c], a, false), null);
  assert.equal(dsWrapFocus([], a, false), null);
});

test('dsResultCells: "not run" and the original-cell states are notes, not errors (D-T7-6)', () => {
  const two = dsResultCells(RECORD, { id: 'ex_2', output: { text: null } });
  assert.equal(two[3].note, 'Not run: the run stopped first');
  assert.equal(two[3].error, null);
  for (const state of ['loading', 'error', 'ready']) {
    const [orig] = dsResultCells(RECORD, { id: 'ex_1' }, state);
    assert.equal(orig.error, null, state);
    assert.ok(orig.note, state);
  }
  // A failed replay is still an error.
  assert.equal(dsResultCells(RECORD, { id: 'ex_1', output: { text: 'x' } })[2].error, 'connection refused');
});

test('the Playground decisions: dsPgSendPlan and dsPgOnError (D-T7-8)', () => {
  const models = [
    { name: 'ollama/qwen3-coder:30b', tier: 'private' },
    { name: 'anthropic/claude-haiku-5-5', tier: 'external', label: 'Anthropic' },
  ];
  const form = (picked, extra = {}) =>
    Object.assign(dsPg({}), {
      slug: 'auth',
      ex: '',
      models,
      picked,
      evs: ['secret_leak'],
      maxCostUSD: '0.5',
      maxRequests: '100',
      ...extra,
    });
  const EXT = ['ollama/qwen3-coder:30b', 'anthropic/claude-haiku-5-5'];

  const off = form(EXT, { content: false });
  assert.deepEqual(dsPgSendPlan(off), {
    kind: 'refuse',
    message: 'External models need content viewing on, because what is sent must be previewed first.',
  });

  const pv = dsPgSendPlan(form(EXT));
  assert.equal(pv.kind, 'preview');
  assert.deepEqual(pv.body.models, EXT);

  // A preview of the form as it is: sent with its confirm token.
  const open = form(EXT);
  open.preview = { items: [], confirm: 'tok', body: dsPgFormBody(open), providers: ['Anthropic'] };
  assert.deepEqual(dsPgSendPlan(open), { kind: 'send', body: open.preview.body, confirm: 'tok' });

  // The form changed since the preview (an external model dropped): sent as the form is, without the token.
  open.picked = ['ollama/qwen3-coder:30b'];
  const plan = dsPgSendPlan(open);
  assert.equal(plan.kind, 'send');
  assert.deepEqual(plan.body.models, ['ollama/qwen3-coder:30b']);
  assert.ok(!('confirm' in plan));
  // ... and with an external model still in it, previewed again rather than sent.
  const stale = form(EXT);
  stale.preview = { items: [], confirm: 'tok', body: dsPgFormBody(stale), providers: ['Anthropic'] };
  stale.maxCostUSD = '0.05';
  assert.equal(dsPgSendPlan(stale).kind, 'preview');

  const s = form(EXT);
  const busy = dsPgOnError(s, Object.assign(new Error('another experiment is running'), { status: 409 }));
  assert.equal(busy.follow, true);
  assert.match(busy.message, /another experiment is running/i);
  const need = dsPgOnError(s, Object.assign(new Error('preview what will be sent first'), { status: 428 }));
  assert.equal(need.dropPreview, true);
  assert.match(need.message, /^Preview what will be sent first/);
  const refused = dsPgOnError(form(EXT, { content: false }), Object.assign(new Error('x'), { status: 403 }));
  assert.equal(
    refused.message,
    'External models need content viewing on, because what is sent must be previewed first.',
  );
  assert.equal(refused.dropPreview, true);
  assert.deepEqual(dsPgOnError(s, Object.assign(new Error('bad model'), { status: 400 })), { message: 'bad model' });
});

test('dsLinkedRun: every paint of a link visit opens the named run, until the owner picks another', () => {
  const runs = [{ id: 'exp_00000000000000a0' }, { id: 'exp_00000000000000a1' }];
  const hash = '#datasets/experiments?run=exp_00000000000000a0';
  assert.equal(dsLinkedRun(runs, '#datasets/experiments', null, 0), null, 'no link');
  assert.deepEqual(dsLinkedRun(runs, hash, null, 0), { run: runs[0] });
  assert.deepEqual(dsLinkedRun(runs, hash, null, 0), { run: runs[0] }, 'a second paint opens it again');
  const gone = '#datasets/experiments?run=exp_00000000000000b1';
  assert.deepEqual(dsLinkedRun(runs, gone, null, 0), { gone: true });
  assert.deepEqual(dsLinkedRun(runs, gone, null, 0), { gone: true }, 'and says so again');
  // The owner opened another run in this visit: a repaint keeps that pick.
  const picked = { hash, visit: 0, id: 'exp_00000000000000a1' };
  assert.deepEqual(dsLinkedRun(runs, hash, picked, 0), { run: runs[1] });
  // A pick from another hash or an earlier visit of the same hash is not this visit's.
  assert.deepEqual(dsLinkedRun(runs, hash, { ...picked, hash: '#datasets/experiments' }, 0), { run: runs[0] });
  assert.deepEqual(dsLinkedRun(runs, hash, picked, 1), { run: runs[0] }, 'the link followed again');
  // A pick that is no longer listed opens nothing, and the named run is not forced back.
  assert.equal(dsLinkedRun(runs, hash, { ...picked, id: 'exp_00000000000000c2' }, 0), null);
});

// The Experiments tab painted into a fake body, as mountDatasets does; returns the run ids it fetched to open.
function withExperimentsPage(hash, fn) {
  const saved = {};
  for (const k of ['document', 'api', '$', 'location', 'history']) saved[k] = global[k];
  const fetched = [];
  global.document = fakeDoc();
  global.$ = () => ({ hidden: false });
  global.location = { hash };
  // A browser's replaceState rewrites the hash without a hashchange.
  global.history = { replaceState: (a, b, url) => (global.location.hash = url) };
  const runs = [
    { id: 'exp_00000000000000a0', dataset: 'auth', datasetName: 'Auth', status: 'done', startedAt: 2 },
    { id: 'exp_00000000000000a1', dataset: 'auth', datasetName: 'Auth', status: 'done', startedAt: 1 },
  ];
  global.api = async (path) => {
    if (path === '/api/experiments') return { experiments: runs, evaluators: [] };
    if (path === '/api/datasets') return { datasets: [], content: true };
    const m = /^\/api\/experiments\/(exp_[0-9a-f]{16})$/.exec(path);
    if (m) fetched.push(m[1]);
    return { examples: [] };
  };
  const paint = async () => {
    const body = global.document.createElement('div');
    await dsPaintExperiments(body, () => true);
    return body;
  };
  return Promise.resolve(fn({ paint, fetched })).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete global[k];
      else global[k] = v;
    }
  });
}

test('a fresh load paints Experiments twice: the second body opens the linked run too', () =>
  withExperimentsPage('#datasets/experiments?run=exp_00000000000000a0', async ({ paint, fetched }) => {
    await paint(); // the first body, thrown away by the second render
    fetched.length = 0;
    await paint();
    assert.deepEqual(fetched, ['exp_00000000000000a0']);
  }));

test('a linked run that is gone says so on the second paint too', () =>
  withExperimentsPage('#datasets/experiments?run=exp_00000000000000b1', async ({ paint, fetched }) => {
    await paint();
    const body = await paint();
    assert.ok(textOf(body).includes('That experiment is no longer kept (only the latest 100 are)'));
    assert.deepEqual(fetched, []);
  }));

test('after the owner opens another run, a repaint keeps that pick and does not reopen the linked one', () =>
  withExperimentsPage('#datasets/experiments?run=exp_00000000000000a0', async ({ paint, fetched }) => {
    const body = await paint();
    const rows = walkAll(body).filter((n) => n && n.tag === 'tr' && n.dataset.id);
    const row = rows.find((n) => n.dataset.id === 'exp_00000000000000a1');
    const btn = walkAll(row).find((n) => n && n.tag === 'button');
    assert.ok(btn, 'the other run has its open button');
    btn.on.click.forEach((f) => f());
    assert.deepEqual(fetched, ['exp_00000000000000a0', 'exp_00000000000000a1']);
    fetched.length = 0;
    await paint(); // a theme or range repaint
    assert.deepEqual(fetched, ['exp_00000000000000a1']);
  }));
