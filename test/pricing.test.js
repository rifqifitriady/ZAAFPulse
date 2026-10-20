// Golden tests for prices: official list rates, ID normalization, boundary matching, the offline
// snapshot and the live list's tiers (lib/pricing.js, lib/price-sync.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  BUILTIN_PRICING,
  DEFAULT_PRICING,
  SNAPSHOT_PRICING,
  SNAPSHOT_META,
  makePricer,
  normalizeModel,
  keyMatches,
} = require('../lib/pricing');
const { parse, buildSnapshot, createPriceSync } = require('../lib/price-sync');

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} != ${b}`);

test('pricing: model IDs are normalized across vendors and platforms', () => {
  const cases = {
    'anthropic/claude-opus-4.5': 'claude-opus-4-5',
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
    'eu.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
    'apac.anthropic.claude-sonnet-4-20250514-v1:0': 'claude-sonnet-4-20250514',
    'global.anthropic.claude-opus-4-6-v1': 'claude-opus-4-6',
    'anthropic.claude-opus-5': 'claude-opus-5',
    'claude-opus-4-1@20250805': 'claude-opus-4-1',
    'publishers/anthropic/models/claude-haiku-4-5@20251001': 'claude-haiku-4-5',
    'claude-opus-4-6[1m]': 'claude-opus-4-6',
    'openai/gpt-5.6-sol': 'gpt-5.6-sol',
    'GPT-5.6-Sol': 'gpt-5.6-sol',
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(normalizeModel(raw), want, raw);
});

test('pricing: a key only matches at a boundary', () => {
  assert.equal(keyMatches('claude-opus-50', 'claude-opus-5'), false);
  assert.equal(keyMatches('claude-opus-5-20260101', 'claude-opus-5'), true);
  assert.equal(keyMatches('gpt-5.6-sol', 'gpt-5'), false, 'a dot and a digit is another version');
  assert.equal(keyMatches('gpt-5-codex', 'gpt-5'), true);
  assert.equal(keyMatches('gpt-5:free', 'gpt-5'), true);
  assert.equal(keyMatches('gpt-anything', 'gpt-'), true, 'a key ending in a separator is a plain prefix');
  const pricer = makePricer(BUILTIN_PRICING);
  assert.equal(pricer.key('claude-opus-50'), null);
  assert.equal(pricer.key('claude-opus-5-5-20270101'), 'claude-opus-5-5');
  assert.equal(pricer.key('claude-opus-4-5-20251101'), 'claude-opus-4-5');
  assert.equal(pricer.key('claude-opus-4-20250514'), 'claude-opus-4');
  assert.equal(pricer.key('claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(pricer.key('anthropic/claude-fable-5.1'), 'claude-fable-5-1');
});

test('pricing: built-in prices match the official Anthropic list (checked 2026-10-20)', () => {
  const b = BUILTIN_PRICING;
  const five = (k) => [b[k].input, b[k].output, b[k].cacheRead, b[k].cacheWrite5m, b[k].cacheWrite1h];
  assert.deepEqual(five('claude-fable-5-1'), [10, 50, 0.25, 12.5, 20]);
  assert.deepEqual(five('claude-fable-5'), [10, 50, 1, 12.5, 20]);
  assert.deepEqual(five('claude-opus-5-5'), [4, 20, 0.2, 5, 8]);
  assert.deepEqual(five('claude-opus-5'), [5, 25, 0.5, 6.25, 10]);
  for (const k of ['claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8'])
    assert.deepEqual(five(k), [5, 25, 0.5, 6.25, 10], k);
  assert.deepEqual(five('claude-opus-4-1'), [15, 75, 1.5, 18.75, 30]);
  assert.deepEqual(five('claude-opus-4'), [15, 75, 1.5, 18.75, 30]);
  assert.deepEqual(five('claude-sonnet-5-5'), [2, 10, 0.1, 2.5, 4]);
  assert.deepEqual(five('claude-sonnet-5'), [2, 10, 0.2, 2.5, 4]);
  assert.deepEqual(five('claude-sonnet-4'), [3, 15, 0.3, 3.75, 6]);
  assert.deepEqual(five('claude-haiku-5-5'), [0.1, 0.5, 0.01, 0.125, 0.2]);
  assert.deepEqual(
    b['claude-haiku-5-5'].tiers.map((t) => [t.above, t.input, t.output, t.cacheRead, t.cacheWrite5m, t.cacheWrite1h]),
    [[100000, 0.5, 2.5, 0.05, 0.625, 1]],
  );
  assert.deepEqual(five('claude-haiku-4'), [1, 5, 0.1, 1.25, 2]);
  assert.deepEqual(five('claude-opus-5-5-fast'), [8, 40, 0.4, 10, 16]);
  assert.deepEqual(five('claude-opus-5-fast'), [10, 50, 1, 12.5, 20]);
});

test('pricing: the offline snapshot prices Codex models and layers over the built-ins', () => {
  assert.ok(SNAPSHOT_META && /^\d{4}-\d{2}-\d{2}$/.test(SNAPSHOT_META.fetchedAt));
  assert.ok(Object.keys(SNAPSHOT_PRICING).length > 50);
  for (const k of Object.keys(SNAPSHOT_PRICING)) assert.equal(DEFAULT_PRICING[k], SNAPSHOT_PRICING[k], k);
  for (const k of Object.keys(BUILTIN_PRICING)) assert.ok(DEFAULT_PRICING[k], k);
  const pricer = makePricer(DEFAULT_PRICING);
  assert.ok(pricer.priced('gpt-5.6-sol'), 'Codex has a price without the live sync');
  assert.ok(pricer.priced('gpt-5-codex'));
  // No descriptions or other catalog fields are shipped.
  for (const p of Object.values(SNAPSHOT_PRICING)) assert.ok(!('description' in p) && !('name' in p));
});

/* ---------- price-sync.js ---------- */

const OR_LIST = [
  {
    id: 'anthropic/claude-haiku-5.5',
    pricing: {
      prompt: '0.0000001',
      completion: '0.0000005',
      web_search: '0.01',
      input_cache_read: '0.00000001',
      input_cache_write: '0.000000125',
      input_cache_write_1h: '0.0000002',
      overrides: [
        {
          min_prompt_tokens: 100000,
          prompt: '0.0000005',
          completion: '0.0000025',
          input_cache_read: '0.00000005',
          input_cache_write: '0.000000625',
          input_cache_write_1h: '0.000001',
        },
      ],
    },
  },
  {
    id: 'openai/gpt-5.5',
    pricing: {
      prompt: '0.000005',
      completion: '0.00003',
      input_cache_read: '0.0000005',
      overrides: [
        { min_prompt_tokens: 272000, prompt: '0.00001', completion: '0.000045', input_cache_read: '0.000001' },
      ],
    },
  },
  {
    id: 'tencent/hy3',
    pricing: {
      prompt: '0.0000001',
      completion: '0.0000004',
      overrides: [{ utc_start: 0, utc_end: 1600, prompt: '0.000001', completion: '0.000002' }],
    },
  },
];

test('price-sync: 1-hour cache writes, prompt-length tiers and web search come from the list', () => {
  const m = Object.fromEntries(parse(OR_LIST).map((x) => [x.key, x.price]));
  assert.equal(m['claude-haiku-5-5'].cacheWrite1h, 0.2);
  assert.equal(m['claude-haiku-5-5'].webSearch, 0.01);
  assert.deepEqual(m['claude-haiku-5-5'].tiers, [
    { above: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 },
  ]);
  assert.deepEqual(m['gpt-5.5'].tiers, [
    { above: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite5m: 0, cacheWrite1h: 0 },
  ]);
  assert.equal(m.hy3.tiers, undefined, 'time-of-day overrides are not modelled');
  const pricer = makePricer({ 'gpt-5.5': m['gpt-5.5'] });
  close(
    pricer.parts('gpt-5.5', 272001, 0, 0, 0, 0).reduce((a, b) => a + b),
    (272001 * 10) / 1e6,
    'long-context tier',
  );
  const snap = buildSnapshot(OR_LIST, '2026-10-20');
  assert.equal(snap.fetchedAt, '2026-10-20');
  assert.deepEqual(Object.keys(snap.prices).sort(), ['claude-haiku-5-5', 'gpt-5.5', 'hy3']);
});

test('price-sync: precedence is defaults < snapshot < your prices < live, and snapshot keys are labelled', async () => {
  const fs = require('fs');
  const os = require('os');
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zp-ps-')), 'prices.json');
  const sync = createPriceSync({
    cacheFile,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: OR_LIST }) }),
  });
  const snapKey = Object.keys(SNAPSHOT_PRICING).find((k) => !(k in BUILTIN_PRICING) && k !== 'gpt-5.5');
  let e = sync.effective(DEFAULT_PRICING, { [snapKey]: { input: 1 } }, { enabled: true });
  assert.equal(e.source[snapKey], 'manual');
  e = sync.effective(DEFAULT_PRICING, {}, { enabled: true });
  assert.equal(e.source[snapKey], 'snapshot');
  assert.equal(e.source['claude-opus-4'], 'default');
  await sync.refresh();
  e = sync.effective(DEFAULT_PRICING, { 'gpt-5.5': { input: 1 } }, { enabled: true });
  assert.equal(e.source['gpt-5.5'], 'live');
  assert.equal(e.pricing['gpt-5.5'].input, 5);
});
