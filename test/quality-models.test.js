// Tool-call accuracy per model (Cost Control 3a): the parsers count each tool result for the model that made the call,
// accuracyByModel sums them over a range with normalized names, and the demo signals carry the same counts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sig = require('../lib/signals');
const { accuracyByModel } = require('../lib/quality');
const { CACHE_VERSION } = require('../lib/indexer');
const { buildResults } = require('../lib/demo');
const { dayOf, addDays } = require('../lib/cost/days');

// Writes synthetic log lines to a temp file and parses them with the given parser.
async function parse(parser, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-qmodels-'));
  const f = path.join(dir, 'S1.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  try {
    return (await require(`../lib/${parser}`).parseFile(f)).signals;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const at = (s) => `2026-10-16T08:00:${String(s).padStart(2, '0')}.000Z`;
const dayAt = (s) => dayOf(Date.parse(at(s)));

test('SignalSink.modelResult: counts per day and model, with the failure category; odd input is ignored', () => {
  const sink = new sig.SignalSink('claude');
  const ts = Date.parse('2026-10-01T10:00:00');
  sink.modelResult(ts, 'claude-opus-5-5');
  sink.modelResult(ts, 'claude-opus-5-5', 'hallucination');
  sink.modelResult(ts, 'gpt-6.1-sol', 'execution');
  for (const bad of [undefined, null, '', 42, '__proto__', 'constructor', 'x'.repeat(201)]) sink.modelResult(ts, bad);
  sink.modelResult(NaN, 'claude-opus-5-5');
  assert.deepEqual(sink.days['2026-10-01'].models, {
    'claude-opus-5-5': { results: 2, cats: { hallucination: 1 } },
    'gpt-6.1-sol': { results: 1, cats: { execution: 1 } },
  });
  assert.equal(Object.getPrototypeOf(sink.days['2026-10-01'].models), Object.prototype);
  const other = new sig.SignalSink('claude');
  other.count(ts, 'results');
  assert.equal(other.days['2026-10-01'].models, undefined, 'a day gets models only when one is counted');
});

test('the Claude parser counts each tool result for the model of the message that made the call', async () => {
  const base = { sessionId: 'S1', cwd: '/w' };
  const user = (s, content) => ({ ...base, type: 'user', timestamp: at(s), message: { role: 'user', content } });
  const asst = (s, id, model, content, usage = {}) => ({
    ...base,
    type: 'assistant',
    timestamp: at(s),
    requestId: `req_${id}`,
    message: { id, role: 'assistant', model, content, usage: { input_tokens: 1, output_tokens: 1, ...usage } },
  });
  const signals = await parse('claude', [
    user(1, 'fix the import'),
    asst(2, 'm1', 'claude-opus-5-5', [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/a.js' } }]),
    user(3, [
      { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'String to replace not found in file' },
    ]),
    asst(4, 'm2', 'claude-sonnet-5-5', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/w/a.js' } }]),
    user(5, [{ type: 'tool_result', tool_use_id: 't2', content: 'const a = 1;' }]),
    asst(6, 'm3', 'claude-opus-5-5', [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } }], {
      speed: 'fast',
    }),
    user(7, [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'Exit code 1\n FAIL src/a.test.ts' }]),
    user(8, [{ type: 'tool_result', tool_use_id: 'never-seen', content: 'ok' }]),
  ]);
  const d = signals.days[dayAt(1)];
  assert.equal(d.results, 4, 'every result still counts in the totals');
  assert.deepEqual(d.models, {
    'claude-opus-5-5': { results: 1, cats: { hallucination: 1 } },
    'claude-sonnet-5-5': { results: 1, cats: {} },
    'claude-opus-5-5-fast': { results: 1, cats: { execution: 1 } },
  });
});

test('the Codex parser counts each tool result for the model of the turn that made the call', async () => {
  const item = (s, payload) => ({ timestamp: at(s), type: 'response_item', payload });
  const ctx = (s, model) => ({ timestamp: at(s), type: 'turn_context', payload: { model } });
  const signals = await parse('codex', [
    { timestamp: at(0), type: 'session_meta', payload: { id: 'S1' } },
    ctx(1, 'gpt-6.1-sol'),
    item(2, { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["npm","i","lefpad"]}' }),
    item(3, {
      type: 'function_call_output',
      call_id: 'c1',
      output:
        '{"output":"npm ERR! code E404\\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/lefpad\\n","metadata":{"exit_code":1}}',
    }),
    item(4, { type: 'function_call', name: 'shell', call_id: 'c2', arguments: '{"command":["ls"]}' }),
    ctx(5, 'gpt-6-astra'),
    item(6, { type: 'function_call_output', call_id: 'c2', output: 'Process exited with code 0\nOutput:\na.js' }),
    item(7, { type: 'function_call', name: 'shell', call_id: 'c3', arguments: '{"command":["ls"]}' }),
    item(8, { type: 'function_call_output', call_id: 'c3', output: 'Process exited with code 0\nOutput:\na.js' }),
  ]);
  assert.deepEqual(signals.days[dayAt(1)].models, {
    'gpt-6.1-sol': { results: 2, cats: { hallucination: 1 } },
    'gpt-6-astra': { results: 1, cats: {} },
  });
});

test('accuracyByModel: model-caused failures only, over the range, with names as the ledger writes them', () => {
  const file = (days) => ({ signals: { days, events: [] } });
  const results = [
    file({
      '2026-10-01': { results: 9, models: { 'claude-opus-5-5': { results: 4, cats: { hallucination: 1 } } } },
      '2026-10-02': {
        models: {
          'anthropic/Claude-Opus-5.5': { results: 6, cats: { process: 1, execution: 3, environment: 1 } },
          'gpt-6.1-sol': { results: 10, cats: {} },
        },
      },
      '2026-09-30': { models: { 'claude-opus-5-5': { results: 100, cats: { hallucination: 100 } } } },
    }),
    file({ '2026-10-02': { results: 2 } }), // a file indexed before the per-model counts
    { signals: null },
    null,
  ];
  const a = accuracyByModel(results, { from: '2026-10-01', to: '2026-10-02' });
  assert.deepEqual(Object.keys(a).sort(), ['claude-opus-5-5', 'gpt-6.1-sol']);
  const opus = a['claude-opus-5-5'];
  assert.deepEqual([opus.results, opus.modelFailures], [10, 2], 'execution and environment are not the model');
  assert.ok(Math.abs(opus.accuracy - 0.8) < 1e-12);
  assert.deepEqual(opus.daily, { '2026-10-01': { results: 4, ok: 3 }, '2026-10-02': { results: 6, ok: 5 } });
  assert.equal(a['gpt-6.1-sol'].accuracy, 1);
  assert.deepEqual(accuracyByModel(results, { from: '2026-10-03', to: '2026-10-31' }), {});
  assert.deepEqual(accuracyByModel([], { from: '2026-10-01', to: '2026-10-31' }), {});
});

test('the demo signals count tool results per model, so the Value page has a scatter in demo mode', () => {
  const now = new Date(2026, 9, 27, 15).getTime();
  const results = buildResults(now);
  let checked = 0;
  for (const r of results)
    for (const d of Object.values(r.signals.days)) {
      if (!d.models) continue;
      const sum = Object.values(d.models).reduce((a, m) => a + m.results, 0);
      assert.equal(sum, d.results, 'per model adds up to the day');
      checked++;
    }
  assert.ok(checked > 50);
  const today = dayOf(now);
  const a = accuracyByModel(results, { from: addDays(today, -29), to: today });
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']) {
    assert.ok(a[m] && a[m].results >= 50, m);
    assert.ok(a[m].accuracy > 0.9 && a[m].accuracy <= 1, m);
  }
});

test('the index is rebuilt once for the per-model counts', () => {
  assert.equal(CACHE_VERSION, 11);
});
