// The Evals card and Settings → Evals: pure helpers in public/evalsview.js, without a browser, and an audit of
// that file for HTML built from preview text, reasons or explanations (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  sparkPoints,
  evalWeek,
  agreementNote,
  evalGroups,
  evalsStatusLine,
  evalsProviderOptions,
  evalsModelList,
  evalsPatch,
  evalsConfirm,
  previewKey,
  previewError,
  evalsProviderHint,
} = require('../public/evalsview');

const SRC = path.join(__dirname, '..', 'public', 'evalsview.js');
const W = 84;
const H = 22;
const pointsOf = (s) =>
  s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.split(',').map(Number));
const inBounds = (pts) => pts.every(([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H);

test('sparkPoints: empty input gives no points', () => {
  assert.equal(sparkPoints([]), '');
  assert.equal(sparkPoints(null), '');
  assert.equal(sparkPoints({}), '');
  assert.equal(sparkPoints([null, null]), '');
});

test('sparkPoints: a single day draws a flat line across the box', () => {
  const pts = pointsOf(sparkPoints([0.9], { width: W, height: H }));
  assert.equal(pts.length, 2);
  assert.ok(inBounds(pts));
  assert.equal(pts[0][0], 0);
  assert.equal(pts[1][0], W);
  assert.equal(pts[0][1], pts[1][1]);
});

test('sparkPoints: a 7-day series stays in bounds, numbers only', () => {
  for (const series of [
    [1, 0.9, 0.85, 1, 0.7, 0.95, 0.88],
    [0, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1, 1, 1],
    [0, 1, 0, 1, 0, 1, 0],
    [5, -3, 0.5, Infinity, NaN, 0.2, 0.4], // out of range values are clamped or skipped
  ]) {
    const s = sparkPoints(series, { width: W, height: H });
    assert.match(s, /^[\d., ]*$/, 'only numbers, commas and spaces');
    const pts = pointsOf(s);
    assert.ok(pts.length >= 2 && pts.length <= 7, `points for ${series}`);
    assert.ok(inBounds(pts), `in bounds for ${series}: ${s}`);
    // x grows left to right
    for (let i = 1; i < pts.length; i++) assert.ok(pts[i][0] > pts[i - 1][0]);
  }
  // A higher rate is drawn higher (smaller y).
  const [a, b] = pointsOf(sparkPoints([0.5, 1], { width: W, height: H }));
  assert.ok(b[1] < a[1]);
});

test('sparkPoints: a day with no samples leaves a gap, not a zero', () => {
  const pts = pointsOf(sparkPoints([0.8, null, 0.8], { width: W, height: H }));
  assert.equal(pts.length, 2);
  assert.equal(pts[0][1], pts[1][1]);
  assert.equal(pts[1][0], W);
});

test('sparkPoints: takes the summary days object, oldest day first', () => {
  const days = { '2026-10-21': { pass: 1, total: 1 }, '2026-10-20': { pass: 0, total: 2 } };
  const [first, last] = pointsOf(sparkPoints(days, { width: W, height: H }));
  assert.ok(last[1] < first[1], 'the later, passing day is higher');
});

test('evalWeek: the seven local days up to today, null where nothing ran', () => {
  const now = new Date(2026, 9, 21, 15, 0).getTime();
  const week = evalWeek({ '2026-10-21': { pass: 3, total: 4 }, '2026-10-15': { pass: 1, total: 1 } }, now);
  assert.equal(week.length, 7);
  assert.equal(week[0], 1);
  assert.equal(week[6], 0.75);
  assert.deepEqual(week.slice(1, 6), [null, null, null, null, null]);
  assert.deepEqual(evalWeek(undefined, now), [null, null, null, null, null, null, null]);
});

test('agreementNote: below 70% with at least 10 pairs warns', () => {
  const n = agreementNote({ pairs: 12, agree: 7, rate: 7 / 12 });
  assert.equal(n.warn, 'Judge and your ratings disagree often: review the judge model or template');
  assert.equal(n.rate, '58%');
  assert.match(n.pairs, /12 rated turns/);
  assert.equal(n.band, 'Arize recommends 75–85%');
});

test('agreementNote: fewer than 10 pairs never warns', () => {
  const n = agreementNote({ pairs: 9, agree: 1, rate: 1 / 9 });
  assert.equal(n.warn, null);
  assert.equal(n.band, 'Arize recommends 75–85%');
  const none = agreementNote({ pairs: 0, agree: 0, rate: null });
  assert.equal(none.warn, null);
  assert.equal(none.rate, '—');
  assert.equal(agreementNote(undefined).warn, null);
});

test('agreementNote: the 75–85% band copy, and in-band or above shows no warning', () => {
  for (const rate of [0.7, 0.8, 0.9]) {
    const n = agreementNote({ pairs: 20, agree: Math.round(rate * 20), rate });
    assert.equal(n.warn, null, `no warning at ${rate}`);
    assert.equal(n.band, 'Arize recommends 75–85%');
  }
  assert.equal(agreementNote({ pairs: 20, agree: 16, rate: 0.8 }).tone, 'good');
  assert.equal(agreementNote({ pairs: 20, agree: 10, rate: 0.5 }).tone, 'bad');
});

test('evalGroups: code and judge evaluators in two groups, in registry order', () => {
  const now = new Date(2026, 9, 21, 12).getTime();
  const evaluators = [
    { id: 'secret_leak', kind: 'code', title: 'Secret leak' },
    { id: 'faithfulness', kind: 'judge', title: 'Faithfulness' },
    { id: 'tool_loop', kind: 'code', title: 'Tool loop' },
  ];
  const summary = {
    evaluators: {
      faithfulness: { kind: 'judge', pass: 8, total: 10, rate: 0.8, days: { '2026-10-21': { pass: 8, total: 10 } } },
      secret_leak: { kind: 'code', pass: 0, total: 0, rate: null, days: {} },
      tool_loop: { kind: 'code', pass: 9, total: 10, rate: 0.9, days: {} },
      __proto__x: { kind: 'code', pass: 1, total: 1, rate: 1, days: {} },
    },
  };
  const g = evalGroups(summary, evaluators, now);
  assert.deepEqual(
    g.code.map((r) => r.id),
    ['secret_leak', 'tool_loop'],
  );
  assert.deepEqual(
    g.judge.map((r) => r.id),
    ['faithfulness'],
  );
  assert.equal(g.judge[0].title, 'Faithfulness');
  assert.equal(g.judge[0].rate, 0.8);
  assert.equal(g.judge[0].total, 10);
  assert.equal(g.judge[0].week.length, 7);
  assert.equal(g.code[0].rate, null);
  // Without the evaluator list, the ids from the summary still show, grouped by kind.
  const bare = evalGroups(summary, null, now);
  assert.ok(bare.code.some((r) => r.id === 'tool_loop' && r.title === 'tool_loop'));
  assert.deepEqual(evalGroups(null, null, now), { code: [], judge: [] });
});

test('evalsStatusLine: the judge, the waiting reason or the pause, with today', () => {
  const running = evalsStatusLine({
    judge: { ok: true, kind: 'ollama', model: 'qwen3:8b', waiting: false },
    today: { count: 42, cost: 0 },
    paused: null,
  });
  assert.equal(running.tone, 'good');
  assert.match(running.text, /Ollama · qwen3:8b/);
  assert.match(running.text, /42 judged today/);
  assert.match(running.text, /\$0\.00/);
  const ext = evalsStatusLine({
    judge: { ok: true, kind: 'external', model: 'gpt-6.1-mini', provider: 'openai', waiting: false },
    today: { count: 3, cost: 0.0123 },
  });
  assert.match(ext.text, /External \(openai\) · gpt-6\.1-mini/);
  assert.match(ext.text, /\$0\.0123/);
  const wait = evalsStatusLine({
    judge: { ok: false, waiting: true, reason: 'No local model found' },
    today: { count: 0, cost: 0 },
  });
  assert.equal(wait.tone, 'warn');
  assert.match(wait.text, /^Waiting: No local model found/);
  const off = evalsStatusLine({ judge: { ok: true, kind: 'ollama', model: 'm' }, paused: 'judge off', today: {} });
  assert.match(off.text, /^Judging is off/);
  const cap = evalsStatusLine({ judge: { ok: true, kind: 'ollama', model: 'm' }, paused: 'daily cap', today: {} });
  assert.match(cap.text, /^Paused: daily cap reached, resumes tomorrow/);
  assert.equal(evalsStatusLine(null).tone, 'muted');
});

test('evalsProviderOptions: local first, external entries say they send masked text', () => {
  const opts = evalsProviderOptions([
    { id: 'auto', label: 'Automatic (local first)', kind: 'auto' },
    { id: 'ollama', label: 'Ollama', kind: 'local' },
    { id: 'lmstudio', label: 'LM Studio', kind: 'local' },
    { id: 'openai', label: 'OpenAI', kind: 'external' },
  ]);
  assert.deepEqual(
    opts.map((o) => [o.id, o.label, o.external]),
    [
      ['auto', 'Auto (local first)', false],
      ['ollama', 'Ollama', false],
      ['lmstudio', 'LM Studio', false],
      ['openai', 'External: openai (sends masked text)', true],
    ],
  );
  // The local three are there even when the server lists none.
  assert.deepEqual(
    evalsProviderOptions(undefined).map((o) => o.id),
    ['auto', 'ollama', 'lmstudio'],
  );
});

test('evalsModelList: the chosen provider models, or every listed model for auto', () => {
  const providers = [
    { id: 'auto', kind: 'auto', models: [] },
    { id: 'ollama', kind: 'local', models: ['qwen3:8b'] },
    { id: 'openai', kind: 'external', models: ['gpt-6.1-mini', 'gpt-6.1'] },
  ];
  assert.deepEqual(evalsModelList(providers, 'openai'), ['gpt-6.1-mini', 'gpt-6.1']);
  assert.deepEqual(evalsModelList(providers, 'ollama'), ['qwen3:8b']);
  assert.deepEqual(evalsModelList(providers, 'auto'), ['qwen3:8b']);
  assert.deepEqual(evalsModelList(undefined, 'auto'), []);
});

test('evalsPatch: only the changed fields, numbers as numbers', () => {
  const cur = {
    judge: true,
    provider: 'auto',
    model: '',
    dailyCap: 500,
    costCapUSD: 1,
    evaluators: { faithfulness: true, relevance: true },
  };
  assert.deepEqual(evalsPatch(cur, { ...cur, evaluators: { ...cur.evaluators } }), {});
  assert.deepEqual(
    evalsPatch(cur, {
      judge: false,
      provider: 'auto',
      model: 'qwen3:8b',
      dailyCap: '200',
      costCapUSD: '0.5',
      evaluators: { faithfulness: true, relevance: false },
    }),
    { judge: false, model: 'qwen3:8b', dailyCap: 200, costCapUSD: 0.5, evaluators: { relevance: false } },
  );
  // A field the server would refuse is sent as typed, so its own message shows.
  assert.deepEqual(evalsPatch(cur, { ...cur, dailyCap: '1.5' }), { dailyCap: 1.5 });
  assert.equal(Object.keys(evalsPatch(cur, { ...cur, dailyCap: '' })).length, 1);
});

test('evalsConfirm: local, not confirmed, confirmed', () => {
  const providers = [{ id: 'openai', kind: 'external' }];
  assert.equal(evalsConfirm({ provider: 'auto', externalConfirmed: null }, providers), 'local');
  assert.equal(evalsConfirm({ provider: 'openai', externalConfirmed: null }, providers), 'unconfirmed');
  assert.equal(evalsConfirm({ provider: 'openai', externalConfirmed: 'groq' }, providers), 'unconfirmed');
  assert.equal(evalsConfirm({ provider: 'openai', externalConfirmed: 'openai' }, providers), 'confirmed');
});

test('previewKey: the newest Claude or Codex session', () => {
  assert.equal(
    previewKey({
      sessions: [
        { key: 'kiro.1', source: 'kiro' },
        { key: 'codex.2', source: 'codex' },
        { key: 'claude.3', source: 'claude' },
      ],
    }),
    'codex.2',
  );
  assert.equal(previewKey({ sessions: [{ key: 'kiro.1', source: 'kiro' }] }), null);
  assert.equal(previewKey(null), null);
});

test('previewError: content off, then the server message as text', () => {
  assert.equal(
    previewError({ status: 403, message: 'content viewing is off' }),
    'Turn on content viewing (ZAAFPULSE_CONTENT=on) to preview',
  );
  assert.equal(previewError({ status: 400, message: 'no finished turn yet' }), 'no finished turn yet');
  assert.equal(previewError({}), 'Could not build the preview');
});

test('evalsview.js builds no HTML from preview text, reasons, explanations or messages (S1)', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // Every innerHTML or insertAdjacentHTML use, up to the end of its statement, with each esc(...) call taken out.
  const sets = [
    ...src.matchAll(/\binnerHTML\s*\+?=\s*([\s\S]*?);\s*\n/g),
    ...src.matchAll(/\binsertAdjacentHTML\(([\s\S]*?)\);\s*\n/g),
  ].map((m) => m[1]);
  assert.ok(sets.length > 0, 'the audit found the HTML it should check');
  for (const raw of sets) {
    const rhs = raw.replace(/\besc\((?:[^()]|\([^()]*\))*\)/g, '');
    assert.doesNotMatch(
      rhs,
      /\b(system|user|reason|explanation|message|preview|text|note|warn)\b/,
      `innerHTML built from: ${rhs.slice(0, 120)}`,
    );
  }
  // The preview boxes and the messages are filled as text.
  assert.match(src, /\.textContent\s*=\s*[^;\n]*\bsystem\b/);
  assert.match(src, /\.textContent\s*=\s*[^;\n]*\buser\b/);
  assert.doesNotMatch(src, /outerHTML|document\.write/);
});

// The providers list as GET /api/evals/settings sends it with Claude Code in it.
const WITH_CLAUDE = (available) => [
  { id: 'auto', kind: 'auto', models: [] },
  { id: 'ollama', kind: 'local', models: [] },
  { id: 'lmstudio', kind: 'local', models: [] },
  {
    id: 'claude-code',
    label: 'Claude Code (your Claude login)',
    kind: 'claude-cli',
    external: true,
    available,
    destination: 'gw.example.com (ANTHROPIC_BASE_URL), with API billing',
    confirm: 'claude-code@0123456789',
    models: ['haiku', 'sonnet', 'opus'],
  },
  { id: 'openai', kind: 'external', external: true, models: ['gpt-6.1'] },
];

test('Claude Code: an option of its own that says where the text goes, with its models', () => {
  const opts = evalsProviderOptions(WITH_CLAUDE(true));
  assert.deepEqual(
    opts.map((o) => [o.id, o.label, o.external]),
    [
      ['auto', 'Auto (local first)', false],
      ['ollama', 'Ollama', false],
      ['lmstudio', 'LM Studio', false],
      [
        'claude-code',
        'Claude Code · sends masked text to gw.example.com (ANTHROPIC_BASE_URL), with API billing',
        true,
      ],
      ['openai', 'External: openai (sends masked text)', true],
    ],
  );
  assert.equal(opts.find((o) => o.id === 'claude-code').available, true);
  // Without a destination from the server, the label stays neutral.
  const bare = WITH_CLAUDE(true).map((p) => (p.id === 'claude-code' ? { ...p, destination: null } : p));
  const plain = evalsProviderOptions(bare).find((o) => o.id === 'claude-code').label;
  assert.equal(plain, 'Claude Code · sends masked text off this machine');
  assert.equal(opts.find((o) => o.id === 'claude-code').destination, WITH_CLAUDE(true)[3].destination);
  assert.equal(evalsProviderOptions(WITH_CLAUDE(false)).find((o) => o.id === 'claude-code').available, false);
  assert.deepEqual(evalsModelList(WITH_CLAUDE(true), 'claude-code'), ['haiku', 'sonnet', 'opus']);
  assert.deepEqual(evalsModelList(WITH_CLAUDE(true), 'auto'), [], 'Auto lists local models only');
  // The same save, preview, confirm steps as a gateway provider.
  assert.equal(evalsConfirm({ provider: 'claude-code', externalConfirmed: null }, WITH_CLAUDE(true)), 'unconfirmed');
  const other = { provider: 'claude-code', externalConfirmed: 'openai' };
  assert.equal(evalsConfirm(other, WITH_CLAUDE(true)), 'unconfirmed');
  // Confirmed for the destination it showed; a confirmation of another destination asks for a new preview.
  const was = (externalConfirmed) => evalsConfirm({ provider: 'claude-code', externalConfirmed }, WITH_CLAUDE(true));
  assert.equal(was('claude-code@0123456789'), 'confirmed');
  assert.equal(was('claude-code'), 'unconfirmed');
  assert.equal(was('claude-code@ffffffffff'), 'changed');
});

test('Claude Code: the hint says whether it was found, and the status line names it', () => {
  const opt = (available) => evalsProviderOptions(WITH_CLAUDE(available)).find((o) => o.id === 'claude-code');
  assert.equal(
    evalsProviderHint(opt(true)),
    'Claude Code found. Masked turn text goes to gw.example.com (ANTHROPIC_BASE_URL), with API billing. ' +
      'Save it, then preview what will be sent.',
  );
  assert.match(evalsProviderHint(opt(null)), /^Checking for Claude Code/);
  assert.equal(opt(null).available, null);
  assert.match(evalsProviderHint(opt(false)), /^Claude Code not found on this machine: install it, or set ZAAFPULSE_/);
  assert.match(evalsProviderHint({ id: 'openai', external: true }), /^Masked turn text goes to this provider/);
  assert.match(evalsProviderHint({ id: 'auto', external: false }), /^Nothing leaves this machine/);
  const line = evalsStatusLine({
    judge: {
      ok: true,
      kind: 'claude-cli',
      model: 'haiku',
      provider: 'claude-code',
      destination: 'Anthropic, through your Claude login',
      waiting: false,
    },
    today: { count: 2, cost: 0.0011 },
  });
  assert.equal(line.tone, 'good');
  const want = /^Claude Code \(to Anthropic, through your Claude login\) · haiku · 2 judged today · \$0\.0011/;
  assert.match(line.text, want);
});
