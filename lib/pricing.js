// API-equivalent list prices in USD per 1M tokens. These estimate what the usage would
// cost on the pay-as-you-go API; a subscription plan is not billed per token.
// Edit them in Settings (stored in config.json) when prices change.
const DEFAULT_PRICING = {
  'claude-fable-5': { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  'claude-haiku-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
  'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
};

// Longest matching prefix wins, so "claude-opus-5-5" beats "claude-opus-5".
function makePricer(pricing) {
  const keys = Object.keys(pricing).sort((a, b) => b.length - a.length);
  const memo = new Map();
  const find = (model) => {
    if (!memo.has(model)) memo.set(model, keys.find((k) => model.startsWith(k)) || null);
    return memo.get(model);
  };
  return {
    priced: (model) => find(model) !== null,
    // [input, output, cache read, cache write] cost in USD.
    parts(model, input, output, cacheRead, cw5m, cw1h) {
      const k = find(model);
      if (!k) return [0, 0, 0, 0];
      const p = pricing[k];
      return [
        (input * p.input) / 1e6,
        (output * p.output) / 1e6,
        (cacheRead * (p.cacheRead || 0)) / 1e6,
        (cw5m * (p.cacheWrite5m || 0) + cw1h * (p.cacheWrite1h || 0)) / 1e6,
      ];
    },
  };
}

module.exports = { DEFAULT_PRICING, makePricer };
