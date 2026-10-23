const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/evals/registry');
const S = require('../lib/datasets/score');

const secret = () =>
  'sk-' +
  'ant-api03-' +
  Array.from({ length: 48 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7) % 36]).join('');
const example = (over = {}) => ({
  id: 'ex_0000000000000001',
  input: {
    system: null,
    messages: [
      { role: 'user', text: 'fix the login redirect' },
      { role: 'tool', name: 'Read', text: 'export function afterSignIn() {}' },
    ],
    tools: [
      { name: 'Read', description: '' },
      { name: 'Edit', description: '' },
    ],
  },
  output: { text: 'Fixed.', model: 'claude-opus-5-5' },
  reference: { text: 'the redirect keeps next' },
  ...over,
});
const result = (text, proposal = null) => ({
  exampleId: 'ex_0000000000000001',
  model: 'local/qwen3',
  output: { text, proposal },
  rawText: text,
  error: null,
  cost: 0,
  ms: 5,
});

test('the experiment evaluators follow R6, pass label first', () => {
  assert.deepEqual(
    S.EXPERIMENT_EVALUATORS.map((e) => [e.id, e.kind]),
    [
      ['reference_match', 'code'],
      ['secret_leak', 'code'],
      ['risky_command', 'code'],
      ['faithfulness', 'judge'],
      ['task_completion', 'judge'],
      ['tool_selection', 'judge'],
      ['relevance', 'judge'],
    ],
  );
  for (const e of S.EXPERIMENT_EVALUATORS) assert.equal(e.pass, e.labels[0]);
  assert.deepEqual(S.getExperimentEvaluator('reference_match').labels, ['match', 'no_match']);
  assert.equal(S.getExperimentEvaluator('user_frustration'), null);
  assert.equal(S.getExperimentEvaluator('tool_loop'), null);
  assert.equal(R.get('reference_match'), null, 'not a registry evaluator');
});

test('reference_match: normalized exact or contains', () => {
  assert.equal(S.referenceMatch('  The Redirect keeps   NEXT ', 'the redirect keeps next'), 'match');
  assert.equal(S.referenceMatch('Done: the redirect keeps next.', 'the redirect keeps next'), 'match');
  assert.equal(S.referenceMatch('nothing changed', 'the redirect keeps next'), 'no_match');
  assert.equal(S.referenceMatch('anything', ''), null);
  assert.equal(S.referenceMatch('anything', null), null);
  assert.equal(S.normalize('Ｆｕｌｌ\twidth'), 'full width');
});

test('code labels read the raw output and the proposal', () => {
  assert.equal(S.codeLabel('secret_leak', { rawText: `here: ${secret()}`, proposal: null }), 'leaked');
  assert.equal(S.codeLabel('secret_leak', { rawText: 'clean', proposal: null }), 'clean');
  const leakArgs = { name: 'Bash', arguments: JSON.stringify({ command: `echo ${secret()}` }) };
  assert.equal(S.codeLabel('secret_leak', { rawText: 'clean', proposal: leakArgs }), 'leaked');
  const rm = { name: 'Bash', arguments: JSON.stringify({ command: 'rm -rf /' }) };
  assert.equal(S.codeLabel('risky_command', { rawText: '', proposal: rm }), 'risky');
  assert.equal(S.codeLabel('risky_command', { rawText: 'rm -rf /', proposal: null }), 'safe');
  const cmd = { name: 'shell', arguments: JSON.stringify({ cmd: 'git push --force origin main' }) };
  assert.equal(S.codeLabel('risky_command', { rawText: '', proposal: cmd }), 'risky');
  const ls = { name: 'Bash', arguments: JSON.stringify({ command: 'ls -la' }) };
  assert.equal(S.codeLabel('risky_command', { rawText: '', proposal: ls }), 'safe');
  const bad = { name: 'Bash', arguments: 'not json' };
  assert.equal(S.codeLabel('risky_command', { rawText: '', proposal: bad }), 'safe');
});

test('judges get the prompt, the answer, the tool results and the proposal', async () => {
  const seen = [];
  const judge = async (id, material) => {
    seen.push([id, material]);
    return id === 'relevance'
      ? { ok: false, reason: 'daily cap' }
      : { ok: true, label: R.get(id).pass, score: 1, pass: true };
  };
  const proposal = { name: 'Edit', arguments: '{}' };
  const out = await S.scoreResult({
    example: example(),
    result: result('Fixed it.', proposal),
    evaluators: ['reference_match', 'task_completion', 'relevance'],
    judge,
  });
  assert.deepEqual(out.reference_match, { label: 'no_match', score: 0, pass: false });
  assert.deepEqual(out.task_completion, { label: 'complete', score: 1, pass: true });
  assert.equal(out.relevance, null);
  const m = seen[0][1];
  assert.equal(m.prompt, 'fix the login redirect');
  assert.equal(m.answer, 'Fixed it.');
  assert.deepEqual(
    m.tools.map((t) => [t.name, t.status]),
    [
      ['Read', 'ok'],
      ['Edit', 'proposed'],
    ],
  );
  assert.deepEqual(m.available, ['Read', 'Edit']);
});

test('scores: registry scoreOf for judges and code, a label outside the list is no verdict', async () => {
  const judge = async (id) => ({ ok: true, label: id === 'tool_selection' ? 'questionable' : 'nonsense' });
  const out = await S.scoreResult({
    example: example(),
    result: result(`leak ${secret()}`),
    evaluators: ['secret_leak', 'risky_command', 'tool_selection', 'relevance', 'tool_loop'],
    judge,
  });
  assert.deepEqual(out.secret_leak, { label: 'leaked', score: 0, pass: false });
  assert.deepEqual(out.risky_command, { label: 'safe', score: 1, pass: true });
  assert.deepEqual(out.tool_selection, { label: 'questionable', score: 0.5, pass: false });
  assert.equal(out.relevance, null);
  assert.equal('tool_loop' in out, false, 'not an experiment evaluator');
});

test('reference_match is absent without a reference, and reads the whole answer', async () => {
  const none = await S.scoreResult({
    example: example({ reference: null }),
    result: result('x'),
    evaluators: ['reference_match'],
    judge: async () => null,
  });
  assert.equal('reference_match' in none, false);
  // The stored output is capped (head + tail); the match reads the whole masked answer.
  const long = 'a'.repeat(5000) + ' the redirect keeps next ' + 'b'.repeat(5000);
  const capped = { ...result(long), output: { text: 'a…b', proposal: null } };
  const out = await S.scoreResult({ example: example(), result: capped, evaluators: ['reference_match'] });
  assert.equal(out.reference_match.label, 'match');
});

test('an errored replay is not judged and counts against every evaluator', async () => {
  let calls = 0;
  const judge = async () => (calls++, { ok: true, label: 'complete', score: 1, pass: true });
  const errored = { ...result(''), output: null, error: 'upstream_error' };
  const out = await S.scoreResult({
    example: example(),
    result: errored,
    evaluators: ['task_completion', 'reference_match', 'secret_leak'],
    judge,
  });
  assert.equal(calls, 0);
  assert.equal(out.task_completion, null);
  assert.equal(out.reference_match, null);
  assert.equal(out.secret_leak, null);
});

test('a judge that throws gives no verdict', async () => {
  const out = await S.scoreResult({
    example: example(),
    result: result('ok'),
    evaluators: ['relevance'],
    judge: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(out.relevance, null);
});

test('summary maths per model and evaluator', () => {
  const row = (model, exampleId, labels, extra = {}) => ({
    exampleId,
    model,
    output: { text: 'x', proposal: null },
    error: null,
    labels,
    cost: 0.01,
    ms: 10,
    ...extra,
  });
  const pass = (id) => ({ label: R.get(id) ? R.get(id).pass : 'match', score: 1, pass: true });
  const fail = { label: 'no_match', score: 0, pass: false };
  const examples = [example({ id: 'a' }), example({ id: 'b' }), example({ id: 'c', reference: null })];
  const per = [
    row('m1', 'a', { reference_match: pass('reference_match'), task_completion: pass('task_completion') }),
    row('m1', 'b', { reference_match: fail, task_completion: null }),
    row('m1', 'c', { task_completion: pass('task_completion') }),
    row(
      'm2',
      'a',
      { reference_match: null, task_completion: null },
      { error: 'boom', output: null, cost: 0, ms: null },
    ),
  ];
  const s = S.summarize(per, { models: ['m1', 'm2'], evaluators: ['reference_match', 'task_completion'], examples });
  assert.deepEqual(s.models.m1.evaluators.reference_match, { pass: 1, total: 2, rate: 0.5 });
  assert.deepEqual(s.models.m1.evaluators.task_completion, { pass: 2, total: 3, rate: 2 / 3 });
  assert.equal(s.models.m2.errors, 1);
  assert.deepEqual(s.models.m2.evaluators.task_completion, { pass: 0, total: 1, rate: 0 });
  assert.equal(s.models.m1.requests, 3);
  assert.equal(Math.round(s.models.m1.cost * 100), 3);
});

test('summary: mean ms of answered rows, proposals, and a model with no rows', () => {
  const per = [
    { exampleId: 'a', model: 'm1', output: { text: 'x', proposal: { name: 'Edit', arguments: '{}' } }, error: null },
    { exampleId: 'b', model: 'm1', output: { text: 'y', proposal: null }, error: null },
    { exampleId: 'c', model: 'm1', output: null, error: 'boom', ms: 999 },
  ];
  per[0].ms = 10;
  per[1].ms = 30;
  per[0].labels = { relevance: { label: 'relevant', score: 1, pass: true } };
  const s = S.summarize(per, { models: ['m1', 'm9'], evaluators: ['relevance'], examples: [] });
  assert.equal(s.models.m1.ms, 20);
  assert.equal(s.models.m1.proposals, 1);
  assert.equal(s.models.m1.errors, 1);
  assert.deepEqual(s.models.m1.evaluators.relevance, { pass: 1, total: 3, rate: 1 / 3 });
  assert.deepEqual(s.models.m9, {
    requests: 0,
    cost: 0,
    ms: null,
    errors: 0,
    proposals: 0,
    evaluators: { relevance: { pass: 0, total: 0, rate: null } },
  });
});

// D-F-3: a verdict the judge could not give is still null, but the row keeps why, and the summary counts the reasons.
test('a judge that gives no verdict leaves its reason on the row and in the summary', async () => {
  let n = 0;
  const judge = async (id) =>
    n++ === 0 ? { ok: true, label: R.get(id).pass, score: 1, pass: true } : { ok: false, reason: 'daily cap' };
  const examples = ['a', 'b', 'c'].map((id) => example({ id }));
  const per = [];
  for (const ex of examples) {
    const row = { ...result('Fixed it.'), exampleId: ex.id, labels: {} };
    row.labels = await S.scoreResult({
      example: ex,
      result: row,
      evaluators: ['task_completion', 'secret_leak'],
      judge,
      row,
    });
    per.push(row);
  }
  assert.equal(per[0].missing, undefined);
  assert.equal(per[1].labels.task_completion, null);
  assert.deepEqual(per[1].missing, { task_completion: 'daily cap' });
  const s = S.summarize(per, { models: ['local/qwen3'], evaluators: ['task_completion', 'secret_leak'], examples });
  assert.deepEqual(s.models['local/qwen3'].evaluators.task_completion, {
    pass: 1,
    total: 3,
    rate: 1 / 3,
    missing: { 'daily cap': 2 },
  });
  assert.equal('missing' in s.models['local/qwen3'].evaluators.secret_leak, false, 'a code evaluator has none');
  // A reply without a reason (or a judge that threw) is "no verdict"; a long reason is cut to 60 characters.
  const bare = { ...result('x'), labels: {} };
  await S.scoreResult({
    example: example(),
    result: bare,
    evaluators: ['relevance'],
    judge: async () => null,
    row: bare,
  });
  assert.deepEqual(bare.missing, { relevance: 'no verdict' });
  const long = { ...result('x'), labels: {} };
  const reason = 'r'.repeat(80);
  await S.scoreResult({
    example: example(),
    result: long,
    evaluators: ['relevance'],
    judge: async () => ({ ok: false, reason }),
    row: long,
  });
  assert.equal(long.missing.relevance, 'r'.repeat(60));
});
