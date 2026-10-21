const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/evals/registry');

test('every evaluator has a pass label first and a version', () => {
  for (const e of R.EVALUATORS) {
    assert.equal(e.labels[0], e.pass, e.id);
    assert.ok(Number.isInteger(e.version) && e.version >= 1, e.id);
    assert.ok(['code', 'judge'].includes(e.kind), e.id);
  }
  assert.deepEqual(
    R.EVALUATORS.filter((e) => e.kind === 'judge')
      .map((e) => e.id)
      .sort(),
    ['faithfulness', 'relevance', 'task_completion', 'tool_selection', 'user_frustration'],
  );
});

test('keys are stable and include version and model', () => {
  const t = { source: 'claude', session: 's1', turn: 2, span: null };
  assert.equal(R.targetKey(t), 'claude|s1|2|');
  assert.notEqual(R.resultKey(t, 'relevance', 1, 'qwen3'), R.resultKey(t, 'relevance', 2, 'qwen3'));
  assert.notEqual(R.resultKey(t, 'relevance', 1, 'qwen3'), R.resultKey(t, 'relevance', 1, 'llama3.2'));
});

test('labels are validated and scored', () => {
  const tc = R.get('task_completion');
  assert.equal(R.validLabel(tc, 'partial'), true);
  assert.equal(R.validLabel(tc, 'great'), false);
  assert.equal(R.scoreOf(tc, 'complete'), 1);
  assert.equal(R.scoreOf(tc, 'partial'), 0.5);
  assert.equal(R.scoreOf(tc, 'incomplete'), 0);
});
