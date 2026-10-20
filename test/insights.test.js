const test = require('node:test');
const assert = require('node:assert/strict');
const { insights, trend } = require('../lib/insights');
const { maskEmail } = require('../lib/omniroute');

const PRICING = { 'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 } };
const now = new Date(2026, 9, 17, 12).getTime();
const row = (minAgo, input, output, cacheRead, cw5m, sid = 's1') => [
  now - minAgo * 60000,
  'claude',
  sid,
  'claude-opus-5-5',
  input,
  output,
  cacheRead,
  cw5m,
  0,
  0,
];

test('trend fits a straight line', () => {
  const t = trend([10, 20, 30, 40]);
  assert.equal(t.slope, 10);
  assert.equal(t.next, 50);
});

test('cache savings and hit rate come from cache reads vs. input price', () => {
  const r = insights(
    [
      {
        events: [row(10, 1000, 10, 9000, 0), row(5, 0, 10, 0, 1000)],
        sessions: { s1: { tool: 'claude', project: '/x/app' } },
        signals: { days: {}, events: [] },
      },
    ],
    { rangeDays: 1, pricing: PRICING, now },
  );
  const t = r.cache.totals;
  assert.equal(t.warm, 1);
  assert.equal(t.cold, 1);
  assert.equal(t.hitRate, 9000 / 11000);
  assert.ok(Math.abs(t.saved - (9000 * (4 - 0.2)) / 1e6) < 1e-12);
  assert.ok(Math.abs(t.premium - (1000 * (5 - 4)) / 1e6) < 1e-12);
});

test('a compaction counts context before and after, and the requests that carry the saving', () => {
  const events = [row(30, 0, 10, 900000, 0), row(20, 0, 10, 100000, 0), row(10, 0, 10, 110000, 0)];
  const signals = { days: {}, events: [{ kind: 'compaction', ts: now - 25 * 60000, sid: 's1', tool: 'claude' }] };
  const r = insights([{ events, sessions: { s1: { tool: 'claude', project: '/x/app' } }, signals }], {
    rangeDays: 1,
    pricing: PRICING,
    now,
  });
  const c = r.compression.recent[0];
  assert.equal(c.pre, 900000);
  assert.equal(c.post, 100000);
  assert.equal(c.saved, 800000);
  assert.equal(c.carried, 2);
  assert.equal(c.project, 'app');
});

test('maskEmail keeps only a hint of the address', () => {
  assert.equal(maskEmail('rifqi@example.com'), 'ri***@example.com');
  assert.equal(maskEmail('noauth'), 'noauth');
});

test('a response copied into a resumed session counts once, and server tools are part of its cost', () => {
  const copy = (sid) => [...row(10, 1000, 100, 0, 0, sid), 'msg_1:req_1', { ws: 2 }];
  const pricing = { 'claude-opus-5-5': { ...PRICING['claude-opus-5-5'], webSearch: 0.01 } };
  const r = insights(
    [
      { events: [copy('s1')], sessions: { s1: { tool: 'claude', project: '/x/app', first: now - 3600000 } } },
      { events: [copy('s2')], sessions: { s2: { tool: 'claude', project: '/x/app', first: now - 60000 } } },
    ],
    { rangeDays: 1, pricing, now },
  );
  const p = r.providers.list[0];
  assert.equal(p.requests, 1);
  assert.equal(p.sessions, 1);
  assert.equal(r.utilization.byTool.claude.calls, 1);
  assert.ok(Math.abs(p.cost - ((1000 * 4 + 100 * 20) / 1e6 + 2 * 0.01)) < 1e-12);
});

test('models are matched like the usage summary: vendor paths normalize, a longer version is not a match', () => {
  const ev = (model) => [now - 600000, 'claude', 's1', model, 0, 10, 9000, 0, 0, 0];
  const run = (model) =>
    insights([{ events: [ev(model)], sessions: { s1: { tool: 'claude', project: '/x/app' } } }], {
      rangeDays: 1,
      pricing: { 'claude-opus-5': PRICING['claude-opus-5-5'] },
      now,
    });
  assert.ok(run('anthropic/claude-opus-5').cache.totals.saved > 0);
  assert.equal(run('claude-opus-50').cache.totals.saved, 0);
  assert.equal(run('claude-opus-50').providers.models[0].priced, false);
});
