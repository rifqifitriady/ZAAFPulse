const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRankings, slimModel } = require('../lib/openrouter');

// The rankings page embeds a dehydrated react-query cache inside self.__next_f.push chunks.
function page(queries) {
  const payload = `6f:["$","$L118",null,{"state":{"mutations":[],"queries":${JSON.stringify(queries)}}}]\n7a:"tail"`;
  return `<html><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></html>`;
}

test('parseRankings reads models, apps and benchmarks from the embedded state', () => {
  const html = page([
    { queryKey: ['rankings', 'models', { view: 'week' }], state: { data: [
      { date: '2026-10-17 00:00:00', model_permaslug: 'z-ai/glm-5.3-20260816', variant: 'standard', total_prompt_tokens: 100, total_completion_tokens: 20, total_native_tokens_reasoning: 0, count: 3 },
      { date: '2026-10-17 00:00:00', model_permaslug: 'deepseek/deepseek-v4.1-flash-20260910', variant: 'standard', total_prompt_tokens: 900, total_completion_tokens: 100, total_native_tokens_reasoning: 0, count: 7 },
    ] } },
    { queryKey: ['rankings', 'apps'], state: { data: { week: [{ rank: 2, total_tokens: '5000', total_requests: 9, app: { title: 'Claude Code', origin_url: 'https://claude.ai/code', categories: ['cli-agent'] } }], day: [], month: [] } } },
    { queryKey: ['rankings', 'benchmarks'], state: { data: { aaData: { coding: [{ heuristic_openrouter_slug: 'anthropic/claude-fable-5.1', aa_name: 'Claude Fable 5.1', score: 81.6 }, { permaslug: 'x/y-20260101', score: 10 }] }, valsIndex: { models: [] } } } },
  ]);
  const r = parseRankings(html);
  assert.equal(r.period, 'week');
  assert.deepEqual(r.models.map((m) => [m.rank, m.slug, m.tokens]), [[1, 'deepseek/deepseek-v4.1-flash', 1000], [2, 'z-ai/glm-5.3', 120]]);
  assert.deepEqual(r.apps.week[0], { rank: 2, title: 'Claude Code', url: 'https://claude.ai/code', categories: ['cli-agent'], description: '', tokens: 5000, requests: 9 });
  assert.deepEqual(r.benchmarks.coding.map((b) => [b.slug, b.score]), [['anthropic/claude-fable-5.1', 81.6], ['x/y', 10]]);
});

test('parseRankings reports a changed page instead of guessing', () => {
  assert.throws(() => parseRankings('<html>nothing here</html>'), /no model leaderboard/);
});

test('slimModel turns per-token prices into per-1M and keeps capabilities', () => {
  const m = slimModel({ id: 'openai/gpt-6.1-sol', name: 'OpenAI: GPT-6.1 Sol', context_length: 1050000, pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000001' },
    supported_parameters: ['tools', 'reasoning', 'temperature'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } });
  assert.equal(m.name, 'GPT-6.1 Sol'); assert.equal(m.vendor, 'openai');
  assert.equal(m.input, 2); assert.equal(m.output, 10); assert.equal(m.cacheRead, 0.1);
  assert.deepEqual(m.params, ['tools', 'reasoning']); assert.deepEqual(m.modalities.in, ['text', 'image']);
});
