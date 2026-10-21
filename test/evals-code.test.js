const test = require('node:test');
const assert = require('node:assert/strict');
const { codeResults, codeSummary } = require('../lib/evals/code');

const T0 = Date.parse('2026-10-20T10:00:00Z');
const entry = (events, turns = [[0, T0], [500, T0 + 60e3]]) => ({
  file: '/x/proj/s1.jsonl',
  source: 'claude',
  size: 1000,
  result: { sessions: { s1: { turns } }, signals: { events } },
});

test('events map to the turn they happened in', () => {
  const e = entry([
    { ts: T0 + 5e3, sid: 's1', kind: 'secret', label: 'Anthropic API key', source: 'Bash' },
    { ts: T0 + 70e3, sid: 's1', kind: 'loop', source: 'Read' },
  ]);
  const r = codeResults([e], { source: 'claude', session: 's1' });
  const at = (ev, turn) => r.find((x) => x.evaluator === ev && x.target.turn === turn);
  assert.equal(at('secret_leak', 0).label, 'leaked');
  assert.deepEqual(at('secret_leak', 0).evidence, [{ tool: 'Bash', label: 'Anthropic API key' }]);
  assert.equal(at('secret_leak', 1).label, 'clean');
  assert.equal(at('tool_loop', 1).label, 'loop');
  assert.equal(at('tool_loop', 0).label, 'none');
});

test('a correction labels the previous turn', () => {
  const r = codeResults([entry([{ ts: T0 + 60e3, sid: 's1', kind: 'correction' }])], { source: 'claude', session: 's1' });
  assert.equal(r.find((x) => x.evaluator === 'correction' && x.target.turn === 0).label, 'corrected');
  assert.equal(r.find((x) => x.evaluator === 'correction' && x.target.turn === 1).label, 'accepted');
});

test('hallucination errors only count for non_existent_target', () => {
  const r = codeResults(
    [
      entry([
        { ts: T0 + 1e3, sid: 's1', kind: 'error', category: 'execution', source: 'Bash' },
        { ts: T0 + 2e3, sid: 's1', kind: 'error', category: 'hallucination', source: 'Read' },
      ]),
    ],
    { source: 'claude', session: 's1' },
  );
  assert.equal(r.find((x) => x.evaluator === 'non_existent_target' && x.target.turn === 0).label, 'hallucinated');
});

test('summary counts turns per evaluator and per day', () => {
  const s = codeSummary([entry([{ ts: T0 + 5e3, sid: 's1', kind: 'risky', source: 'Bash' }])], {
    from: T0 - 1,
    to: T0 + 864e5,
  });
  assert.deepEqual([s.risky_command.pass, s.risky_command.total], [1, 2]);
  assert.equal(s.risky_command.days['2026-10-20'].total, 2);
});

test('injection is external only when the event says so', () => {
  const run = (external) =>
    codeResults([entry([{ ts: T0 + 1e3, sid: 's1', kind: 'injection', label: 'x', external, source: 'WebFetch' }])], {
      source: 'claude',
      session: 's1',
    }).find((x) => x.evaluator === 'prompt_injection' && x.target.turn === 0);
  assert.equal(run(true).label, 'external');
  assert.equal(run(false).label, 'local');
  assert.equal(run(false).score, 0.5);
});

test('subagent events count toward the parent turns', () => {
  const sub = {
    file: '/x/proj/s1/subagents/agent-a.jsonl',
    source: 'claude',
    size: 10,
    result: {
      sessions: { s1: { turns: [] } },
      signals: { events: [{ ts: T0 + 70e3, sid: 's1', kind: 'risky', label: 'rm -rf', source: 'Bash' }] },
    },
  };
  const r = codeResults([entry([]), sub], { source: 'claude', session: 's1' });
  assert.equal(r.filter((x) => x.evaluator === 'risky_command').length, 2);
  assert.equal(r.find((x) => x.evaluator === 'risky_command' && x.target.turn === 1).label, 'risky');
});

test('a session without turns falls under turn 0, and other sessions or sources are ignored', () => {
  const events = [
    { ts: T0, sid: 's1', kind: 'secret', label: 'k', source: 'Bash' },
    { ts: T0, sid: 'other', kind: 'secret', label: 'k', source: 'Bash' },
  ];
  const r = codeResults([entry(events, [])], { source: 'claude', session: 's1' });
  assert.equal(r.filter((x) => x.evaluator === 'secret_leak').length, 1);
  assert.equal(r.find((x) => x.evaluator === 'secret_leak').label, 'leaked');
  assert.deepEqual(codeResults([entry(events)], { source: 'codex', session: 's1' }), []);
});

test('evidence is distinct, capped at 5, and never carries event text', () => {
  const events = Array.from({ length: 8 }, (_, i) => ({
    ts: T0 + i,
    sid: 's1',
    kind: 'risky',
    label: `l${i % 7}`,
    source: 'Bash',
    text: 'SNIPPET-SHOULD-NOT-LEAK',
  })).concat([{ ts: T0 + 9, sid: 's1', kind: 'risky', label: 'l0', source: 'Bash', text: 'dup' }]);
  const r = codeResults([entry(events)], { source: 'claude', session: 's1' });
  const ev = r.find((x) => x.evaluator === 'risky_command' && x.target.turn === 0).evidence;
  assert.equal(ev.length, 5);
  assert.equal(new Set(ev.map((x) => x.label)).size, 5);
  assert.ok(!JSON.stringify(r).includes('SNIPPET-SHOULD-NOT-LEAK'));
});

test('summary skips turns outside the range and works for codex entries', () => {
  const e = entry([{ ts: T0 + 5e3, sid: 's1', kind: 'secret', source: 'Bash', label: 'k' }]);
  e.source = 'codex';
  const s = codeSummary([e], { from: T0 + 1e3, to: T0 + 864e5 });
  // turn 0 starts before `from`, so only turn 1 counts
  assert.equal(s.secret_leak.total, 1);
  assert.equal(s.secret_leak.pass, 1);
});
