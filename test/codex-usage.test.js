// Golden-fixture tests for Codex usage: cumulative-to-delta conversion, cache writes, forked and
// spawned sessions, estimated models and tool attribution (lib/codex.js). Fixtures are synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const claude = require('../lib/claude');
const codex = require('../lib/codex');
const { summarize } = require('../lib/aggregate');
const { BUILTIN_PRICING, makePricer, eventParts } = require('../lib/pricing');

const FX = path.join(__dirname, 'fixtures', 'cost');
const fx = (rel) => path.join(FX, rel);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} != ${b}`);
const costOf = (pricer, e) => eventParts(pricer, e).reduce((a, b) => a + b, 0);
const sum = (pricer, events) => events.reduce((a, e) => a + costOf(pricer, e), 0);
// Usage columns of an event: model, input, output, cache read, 5m write, 1h write.
const usage = (e) => e.slice(3, 9);

// Fixed prices so parser and roll-up tests do not move when the snapshot is refreshed.
const PRICING = {
  ...BUILTIN_PRICING,
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 5, webSearch: 0.01 },
};

test('codex: cumulative totals become per-request deltas; repeats and empty counts are skipped', async () => {
  const r = await codex.parseFile(fx('codex/cumulative.jsonl'));
  assert.deepEqual(
    r.events.map((e) => usage(e)),
    [
      ['gpt-5.6-sol', 2000, 500, 8000, 0, 0],
      ['gpt-5.6-sol', 3000, 1000, 12000, 0, 0],
    ],
  );
  assert.deepEqual(r.events[0][11], { ws: 1 }, 'the web search call is billed with the next request');
  assert.equal(r.events[1][11], null);
  const pricer = makePricer(PRICING);
  close(
    sum(pricer, r.events),
    (2000 * 4 + 500 * 20 + 8000 * 0.4) / 1e6 + 0.01 + (3000 * 4 + 1000 * 20 + 12000 * 0.4) / 1e6,
  );
  assert.equal(r.sessions.C1.prompts, 1);
  assert.equal(r.sessions.C1.promptTs.length, 1);
  assert.ok(r.limits && r.limits.primary.used_percent === 12);
});

test('codex: cache writes are part of input_tokens and are split out, not counted twice', async () => {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-'));
  const f = path.join(dir, 'cw.jsonl');
  const tc = { input_tokens: 10000, cached_input_tokens: 6000, cache_write_input_tokens: 3000, output_tokens: 10 };
  fs.writeFileSync(
    f,
    [
      { timestamp: '2026-10-16T08:00:00Z', type: 'session_meta', payload: { id: 'CW' } },
      { timestamp: '2026-10-16T08:00:01Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      {
        timestamp: '2026-10-16T08:00:05Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: tc, last_token_usage: tc } },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n'),
  );
  const r = await codex.parseFile(f);
  assert.deepEqual(usage(r.events[0]), ['gpt-5.6-sol', 1000, 10, 6000, 3000, 0]);
  fs.rmSync(dir, { recursive: true });
});

test('codex: a fork skips the history it copied from its parent and keeps the cumulative baseline', async () => {
  const parent = await codex.parseFile(fx('codex/parent.jsonl'));
  const fork = await codex.parseFile(fx('codex/fork.jsonl'));
  assert.equal(parent.events.length, 2);
  assert.deepEqual(Object.keys(fork.sessions), ['F1'], 'the copied parent session_meta does not rename the fork');
  assert.equal(fork.sessions.F1.forkedFrom, 'P1');
  assert.deepEqual(
    fork.events.map((e) => usage(e)),
    [['gpt-5.6-sol', 90, 20, 10, 0, 0]],
  );
  // Copied prompts and tool calls are the parent's, not the fork's.
  assert.equal(fork.sessions.F1.prompts, 1);
  assert.deepEqual(fork.sessions.F1.tools, {});
  assert.equal(fork.signals.events.filter((e) => e.kind === 'risky').length, 0);
  const s = summarize([parent, fork], { rangeDays: 'all', pricing: PRICING, now: Date.parse('2026-10-17T00:00:00Z') });
  assert.equal(s.kpis.calls, 3);
  assert.equal(s.kpis.tokens, 1500 + 300 + 100 + 20);
});

test('codex: a spawned subagent whose copied history kept its old timestamps is skipped the same way', async () => {
  const r = await codex.parseFile(fx('codex/spawn.jsonl'));
  assert.equal(r.sessions.SP1.forkedFrom, 'P1');
  assert.deepEqual(
    r.events.map((e) => usage(e)),
    [['codex', 45, 10, 5, 0, 0]],
  );
});

test('codex: a session naming itself as parent is not a fork; a log without a model is an estimate', async () => {
  const r = await codex.parseFile(fx('codex/legacy.jsonl'));
  assert.equal(r.sessions.L1.forkedFrom, null);
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0][3], 'codex');
  const s = summarize([r], { rangeDays: 'all', pricing: PRICING, now: Date.parse('2026-10-17T00:00:00Z') });
  assert.deepEqual(s.unpriced, []);
  assert.deepEqual(s.estimated, ['codex']);
  close(s.kpis.cost, 2 * ((1000 * 1.25 + 100 * 10) / 1e6));
  assert.equal(s.models.find((m) => m.model === 'codex').estimated, true);
});

test('codex: risky commands are read from JSON arguments; web results are external', async () => {
  const r = await codex.parseFile(fx('codex/cumulative.jsonl'));
  const risky = r.signals.events.filter((e) => e.kind === 'risky');
  assert.deepEqual(risky.map((e) => e.label).sort(), ['Recursive force delete', 'sudo']);
  assert.equal(risky[0].text, 'sudo rm -rf /tmp/build');
  const inj = r.signals.events.filter((e) => e.kind === 'injection');
  assert.equal(inj.length, 1);
  assert.equal(inj[0].external, true);
  const day = Object.values(r.signals.days)[0];
  assert.equal(day.injExternal, 1);
  assert.equal(day.injLocal || 0, 0);
  assert.equal(day.external, 2, 'web_search_call and web.run');
  assert.equal(r.sessions.C1.tools.web_search, 1);
  assert.equal(codex.commandOf('{"command":"ls -la"}'), 'ls -la');
  assert.equal(codex.commandOf('{"cmd":["git","status"]}'), 'git status');
  assert.equal(codex.commandOf('*** Begin Patch'), '*** Begin Patch');
  assert.ok(codex.isExternal('web_search') && codex.isExternal('fetch') && codex.isExternal('mcp__x__y'));
  assert.ok(!codex.isExternal('shell') && !codex.isExternal('fetch_logs') && !codex.isExternal('apply_patch'));
});

test('aggregate: cost parts include server tools and the totals add up', async () => {
  const results = [
    await claude.parseFile(fx('claude/models.jsonl')),
    await codex.parseFile(fx('codex/cumulative.jsonl')),
  ];
  const s = summarize(results, { rangeDays: 'all', pricing: PRICING, now: Date.parse('2026-10-17T00:00:00Z') });
  const p = s.kpis.costParts;
  close(p.tools, 0.03 + 0.01);
  close(p.input + p.output + p.cacheRead + p.cacheWrite + p.tools, s.kpis.cost);
  assert.deepEqual(s.unpriced.sort(), ['claude-opus-50', 'claude-unknown-9']);
});
