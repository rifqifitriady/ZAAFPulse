const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPriceSync, parse } = require('../lib/price-sync');

const LIST = [
  { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', description: 'Big  model.', context_length: 1000000, supported_parameters: ['tools', 'reasoning'],
    pricing: { prompt: '0.000004', completion: '0.00002', input_cache_read: '0.0000002', input_cache_write: '0.000005' } },
  { id: 'anthropic/claude-opus-5.5:batch', pricing: { prompt: '0.000002', completion: '0.00001' } },
  { id: '~anthropic/claude-opus-latest', name: 'Anthropic: Claude Opus Latest', pricing: { prompt: '0.000004', completion: '0.00002' } },
  { id: 'openai/gpt-5.6-sol', name: 'OpenAI: GPT-5.6 Sol', pricing: { prompt: '0.000004', completion: '0.00002', input_cache_read: '0.0000004' } },
  { id: 'meta-llama/llama-9', pricing: { prompt: '0.000001', completion: '0.000001' } },
  { id: 'mistralai/mistral-9', pricing: { prompt: '0.000001', completion: '0.000001' } },
];

test('parse keeps provider list prices per 1M tokens and maps keys to how logs name models', () => {
  const m = Object.fromEntries(parse(LIST).map((x) => [x.key, x]));
  assert.deepEqual(Object.keys(m).sort(), ['claude-opus-5-5', 'gpt-5.6-sol', 'llama-9', 'opus']);
  assert.equal(m['llama-9'].vendor, 'meta'); assert.equal(m['llama-9'].vendorName, 'Meta');
  assert.deepEqual(m['claude-opus-5-5'].price, { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 });
  assert.equal(m['claude-opus-5-5'].name, 'Claude Opus 5.5');
  assert.equal(m['claude-opus-5-5'].description, 'Big model.');
  assert.deepEqual(m['claude-opus-5-5'].tags, ['Reasoning', 'Tools']);
  assert.equal(m['gpt-5.6-sol'].price.cacheWrite1h, 0);
});

test('live prices win over defaults and your prices, unless you pin; sync off ignores them', async () => {
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-ps-')), 'prices.json');
  const sync = createPriceSync({ cacheFile, fetchImpl: async () => ({ ok: true, json: async () => ({ data: LIST }) }) });
  await sync.refresh();
  assert.equal(sync.status().models, 4);
  const defaults = { 'claude-opus-5-5': { input: 9 }, legacy: { input: 1 } };
  const manual = { 'claude-opus-5-5': { input: 7 }, custom: { input: 2 } };
  let e = sync.effective(defaults, manual, { enabled: true, pinned: [] });
  assert.equal(e.pricing['claude-opus-5-5'].input, 4); assert.equal(e.source['claude-opus-5-5'], 'live');
  assert.equal(e.source.custom, 'manual'); assert.equal(e.source.legacy, 'default');
  e = sync.effective(defaults, manual, { enabled: true, pinned: ['claude-opus-5-5'] });
  assert.equal(e.pricing['claude-opus-5-5'].input, 7); assert.equal(e.source['claude-opus-5-5'], 'manual');
  e = sync.effective(defaults, manual, { enabled: false });
  assert.equal(e.pricing['claude-opus-5-5'].input, 7); assert.equal(e.pricing['gpt-5.6-sol'], undefined);
  // A later failure keeps the cached list and reports the error.
  const broken = createPriceSync({ cacheFile, fetchImpl: async () => ({ ok: false, status: 503 }) });
  await broken.refresh();
  assert.equal(broken.status().models, 4); assert.equal(broken.status().error, 'HTTP 503');
});
