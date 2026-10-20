// Golden-fixture tests for Claude Code usage: streaming duplicates, resumed sessions, cache writes,
// vendor model IDs and priced extras (lib/claude.js), and the cross-file roll-up (lib/aggregate.js).
// Fixtures in test/fixtures/cost are synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const claude = require('../lib/claude');
const { summarize, dedupeEvents } = require('../lib/aggregate');
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

test('claude: streamed blocks of one response count once, with the final output and 5m/1h cache writes', async () => {
  const r = await claude.parseFile(fx('claude/streaming.jsonl'));
  const byKey = Object.fromEntries(r.events.filter((e) => e[10]).map((e) => [e[10], e]));
  assert.equal(r.events.length, 7);
  assert.deepEqual(usage(byKey['msg_A:req_A']), ['claude-opus-5-5', 100, 50, 2000, 1000, 500]);
  // A total-only cache_creation_input_tokens is all 5-minute writes.
  assert.deepEqual(usage(byKey['msg_B:req_B']), ['claude-opus-5-5', 10, 20, 0, 300, 0]);
  // No request id: a real msg_ id collapses within its session, keeping the larger output.
  assert.deepEqual(usage(byKey['msg_C:@S1']), ['claude-opus-5-5', 5, 8, 0, 0, 0]);
  // A gateway id without a request id is scoped to its timestamp; no id at all is never merged.
  assert.equal(r.events.filter((e) => String(e[10]).startsWith('gw-1:@S1:')).length, 2);
  assert.equal(r.events.filter((e) => e[10] === null).length, 2);
  const pricer = makePricer(PRICING);
  close(costOf(pricer, byKey['msg_A:req_A']), (100 * 4 + 50 * 20 + 2000 * 0.2 + 1000 * 5 + 500 * 8) / 1e6);
  close(sum(pricer, r.events), (10800 + 1940 + 180 + 48 + 96) / 1e6, 'file total');
  assert.deepEqual(r.sessions.S1.promptTs, [Date.parse('2026-10-16T09:00:00.000Z')]);
});

test('claude: a resumed session that copies earlier responses is counted once, on the original session', async () => {
  const results = [
    await claude.parseFile(fx('claude/resumed.jsonl')),
    await claude.parseFile(fx('claude/original.jsonl')),
  ];
  assert.equal(results[0].events.length + results[1].events.length, 3, 'each file alone still has its copy');
  const s = summarize(results, { rangeDays: 'all', pricing: PRICING, now: Date.parse('2026-10-17T00:00:00Z') });
  assert.equal(s.kpis.calls, 2);
  assert.equal(s.kpis.tokens, 4000);
  close(s.kpis.cost, 0.024);
  const bySid = Object.fromEntries(s.sessions.map((x) => [x.id, x]));
  assert.equal(bySid.ORIG.calls, 1, 'the copied response stays with the session that made it');
  assert.equal(bySid.RES.calls, 1);
  // The copied prompt has the same timestamp, so it is counted once.
  assert.equal(s.kpis.prompts, 2);
});

test('claude: vendor model IDs, fast mode, web search, US-only inference, advisor and Haiku 5.5 tiers', async () => {
  const r = await claude.parseFile(fx('claude/models.jsonl'));
  assert.equal(r.events.length, 14, '13 responses plus one advisor iteration');
  const pricer = makePricer(PRICING);
  const by = Object.fromEntries(r.events.map((e) => [e[10], e]));
  const cost = (k) => costOf(pricer, by[k]);
  close(cost('msg_V1:req_V1'), 3, 'Bedrock us.anthropic.…-v1:0 is Sonnet 4.5');
  close(cost('msg_V2:req_V2'), 15, 'Vertex @date is Opus 4.1');
  close(cost('msg_V3:req_V3'), 1, 'OpenRouter anthropic/claude-haiku-4.5 is Haiku 4.5');
  close(cost('msg_V4:req_V4'), 15, 'Opus 4 lists at $15 input');
  close(cost('msg_V5:req_V5'), 5, 'Opus 4.5 keeps its own lower price');
  assert.equal(by['msg_F1:req_F1'][3], 'claude-opus-5-5-fast');
  close(cost('msg_F1:req_F1'), 8 + 40, 'fast mode premium');
  assert.deepEqual(by['msg_W1:req_W1'][11], { ws: 3 });
  close(cost('msg_W1:req_W1'), 0.03, '$10 per 1,000 searches, web fetch free');
  close(cost('msg_G1:req_G1'), 4.4, 'inference_geo us is 1.1x');
  assert.equal(by['msg_D1:advisor:1:req_D1'][3], 'claude-opus-5-5');
  close(cost('msg_D1:advisor:1:req_D1'), 4, 'advisor iteration priced on its own model');
  close(cost('msg_H1:req_H1'), (50000 * 0.1 + 1e6 * 0.5 + 50000 * 0.01) / 1e6, 'prompt of exactly 100,000');
  close(cost('msg_H2:req_H2'), (50001 * 0.5 + 1e6 * 2.5 + 50000 * 0.05) / 1e6, 'prompt over 100,000');
  assert.equal(pricer.priced('claude-opus-50'), false);
  assert.equal(pricer.priced('claude-unknown-9'), false);
});

test('aggregate: prompts are counted by their own time, not the whole session once any event is in range', async () => {
  const results = [
    await claude.parseFile(fx('claude/original.jsonl')),
    await claude.parseFile(fx('claude/resumed.jsonl')),
  ];
  // One minute after the resumed prompt; the original prompt was 24 hours earlier, so on another day.
  const now = Date.parse('2026-10-16T10:01:00Z');
  const s = summarize(results, { rangeDays: 1, pricing: PRICING, now });
  assert.equal(s.kpis.prompts, 1);
  // Old caches and demo data have no prompt times and keep the per-session count.
  const legacy = [
    { events: results[1].events, sessions: { RES: { ...results[1].sessions.RES, promptTs: undefined } } },
  ];
  assert.equal(summarize(legacy, { rangeDays: 1, pricing: PRICING, now }).kpis.prompts, 2);
});

test('aggregate: the main transcript wins over a subagent copy, then the larger token count', () => {
  const row = (sid, out, sub, key = 'm1:r1') => [1, 'claude', sid, 'claude-opus-5-5', 1, out, 0, 0, 0, sub, key, null];
  let ev = dedupeEvents([{ events: [row('A', 5, 1)] }, { events: [row('A', 1, 0)] }]);
  assert.deepEqual(
    ev.map((e) => e[9]),
    [0],
  );
  ev = dedupeEvents([{ events: [row('A', 5, 0)] }, { events: [row('B', 9, 0)] }]);
  assert.deepEqual(
    ev.map((e) => e[2]),
    ['B'],
  );
  // Different tools never collide, and keyless rows are all kept.
  ev = dedupeEvents([
    { events: [row('A', 1, 0), [...row('A', 1, 0).slice(0, 1), 'codex', ...row('A', 1, 0).slice(2)]] },
  ]);
  assert.equal(ev.length, 2);
  ev = dedupeEvents([{ events: [row('A', 1, 0, null), row('A', 1, 0, null)] }]);
  assert.equal(ev.length, 2);
});
