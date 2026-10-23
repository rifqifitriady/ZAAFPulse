// Replaying dataset examples against models, text only: the recorded messages go out with their tools declared, and
// a tool call the model proposes is recorded, never run (one call per example and model). Calls go through the
// gateway (gateway.replay), so usage, cost and OTLP export apply; calls are recorded as dashboard calls (no API key,
// so no key budget applies).
const crypto = require('crypto');
const { maskPii } = require('../evals/pii');
const { maskText, capField } = require('./shape');
const { scoreResult, summarize } = require('./score');

const REPLAY_DEFAULTS = { maxCostUSD: 0.5, maxRequests: 100, timeoutMs: 120000 };
const OUTPUT_CAP = 4000; // characters of a stored output text or proposal arguments (head + tail)
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/; // what OpenAI-style tool names accept
const ERROR_CHARS = 200;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

// A tool result has no tool_call_id to pair it with, so it goes out as user text. An external model gets every
// content with personal data hidden too (the same rule as the external judge).
function toMessages(input, { external = false } = {}) {
  const src = input || {};
  const out = [];
  const put = (role, text) => {
    const content = String(text ?? '');
    out.push({ role, content: external ? maskPii(content) : content });
  };
  if (typeof src.system === 'string' && src.system) put('system', src.system);
  for (const m of Array.isArray(src.messages) ? src.messages : []) {
    if (!m) continue;
    if (m.role === 'tool') put('user', `[tool result: ${m.name || 'tool'}]\n${m.text ?? ''}`);
    else if (m.role === 'system' || m.role === 'user' || m.role === 'assistant') put(m.role, m.text);
  }
  return out;
}

// Declared with an open schema: a proposal is never run anyway. An imported description can hold anything, so an
// external model gets it with personal data hidden, like the messages.
function toTools(tools, { external = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    const name = t && t.name;
    if (typeof name !== 'string' || !TOOL_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    const description = String((t && t.description) || '');
    out.push({
      type: 'function',
      function: {
        name,
        description: external ? maskPii(description) : description,
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      },
    });
  }
  return out;
}

// Exactly what one call sends (once() builds the same), so the owner sees the declared tools as well as the text.
const previewOf = (example, model, { external = false } = {}) => ({
  model,
  messages: toMessages(example && example.input, { external }),
  tools: toTools(example && example.input && example.input.tools, { external }),
});

// Ties a confirmed preview to what it showed: the same dataset, examples and models in any order.
function confirmToken(secret, { dataset, exampleIds, models }) {
  const material = JSON.stringify([dataset, [...(exampleIds || [])].sort(), [...(models || [])].sort()]);
  return crypto.createHmac('sha256', secret).update(material).digest('hex').slice(0, 32);
}

const orderModels = (models, tierOf) => [
  ...models.filter((m) => tierOf(m) === 'private'),
  ...models.filter((m) => tierOf(m) !== 'private'),
];

const errorText = (err) => maskText(String((err && err.message) || err || 'replay failed')).slice(0, ERROR_CHARS);

// About 4 characters a token, as the judge estimates. The input is what was sent: every message content and every
// declared tool's name and description.
const tokensOf = (chars) => chars / 4;
const sentChars = (messages, tools) =>
  messages.reduce((n, m) => n + m.content.length, 0) +
  tools.reduce((n, t) => n + t.function.name.length + t.function.description.length, 0);

// What an external call counts against the cost cap. A provider that sends no usage is recorded at cost 0, and a cost
// below what the input alone costs cannot be the whole bill, so the call then counts at least its estimate (D-F-1).
function chargeOf(usage, inEst, outEst) {
  const reported = usage && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null;
  if (reported !== null && usage.input > 0 && reported >= inEst) return reported;
  return Math.max(reported || 0, inEst + outEst);
}

function createReplayRunner({ replay, judge, now = Date.now, timeoutMs = REPLAY_DEFAULTS.timeoutMs }) {
  // One example against one model: the stored row, and what scoring reads. Scoring sees the raw text and the raw
  // proposal (a secret or a risky command must not hide behind the mask or the cap); the row keeps neither. Only the
  // timeout aborts a call: a cancel or a cap stops the run before the next call, never the one in flight (R8).
  async function once(example, model, { external }) {
    const messages = toMessages(example.input, { external });
    const tools = toTools(example.input && example.input.tools, { external });
    // Only an external call with a known price is estimated; a private one costs what it reports (0 is allowed).
    const price = external && typeof replay.priceOf === 'function' ? replay.priceOf(model) : null;
    const inEst = price ? (tokensOf(sentChars(messages, tools)) * (price.input || 0)) / 1e6 : 0;
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeoutMs);
    const started = now();
    try {
      const r = await replay.complete({ model, messages, tools, signal: ctl.signal });
      const ms = now() - started;
      const text = typeof r.text === 'string' ? r.text : '';
      const call = Array.isArray(r.toolCalls) && r.toolCalls[0] ? r.toolCalls[0] : null;
      const raw = call
        ? { name: String(call.name || '').slice(0, 200), arguments: String(call.arguments || '') }
        : null;
      const output = {
        text: capField(maskText(text), OUTPUT_CAP),
        proposal: raw ? { name: raw.name, arguments: capField(maskText(raw.arguments), OUTPUT_CAP) } : null,
      };
      let cost = r.usage && Number.isFinite(r.usage.cost) ? r.usage.cost : 0;
      if (price) {
        const outChars = text.length + (raw ? raw.arguments.length : 0);
        cost = chargeOf(r.usage, inEst, (tokensOf(outChars) * (price.output || 0)) / 1e6);
      }
      const row = { exampleId: example.id, model, output, error: null, labels: {}, cost, ms };
      return { row, scored: { ...row, output: { text: output.text, proposal: raw }, rawText: text } };
    } catch (err) {
      const error = timedOut ? `no answer within ${Math.ceil(timeoutMs / 1000)} s` : errorText(err);
      // The text may have reached the provider before it failed, so an external call counts its input (as the judge).
      const row = { exampleId: example.id, model, output: null, error, labels: {}, cost: inEst, ms: now() - started };
      return { row, scored: row };
    } finally {
      clearTimeout(timer);
    }
  }

  async function run({
    id,
    dataset: meta,
    examples = [],
    models = [],
    evaluators = [],
    maxCostUSD = REPLAY_DEFAULTS.maxCostUSD,
    maxRequests = REPLAY_DEFAULTS.maxRequests,
    signal,
    onProgress = () => {},
  }) {
    // Refused before any call: an unknown name, or an external model whose cost the cap could not count.
    for (const m of models) {
      const tier = replay.tierOf(m);
      if (!tier) throw badRequest(`unknown model ${m}`);
      if (tier === 'external' && !replay.priced(m))
        throw badRequest(`no price known for ${m}, so the cost cap cannot apply`);
    }
    const ordered = orderModels(models, replay.tierOf);
    const startedAt = now();
    const total = examples.length * ordered.length;
    const perExample = [];
    let requests = 0;
    let cost = 0;
    let stopped = null;
    // Judge calls keep the eval engine's own caps and lane; the run's signal lets a cancel reach a waiting one.
    const judgeOf = (evaluatorId, material) => judge(evaluatorId, material, { signal });

    outer: for (const example of examples) {
      for (const model of ordered) {
        // Checked before each call; a call is never interrupted, so the cost can pass a cap by one call.
        if (signal && signal.aborted) stopped = 'cancelled';
        else if (requests >= maxRequests) stopped = 'request cap';
        else if (cost >= maxCostUSD) stopped = 'cost cap';
        if (stopped) break outer;
        const { row, scored } = await once(example, model, { external: replay.tierOf(model) === 'external' });
        requests++;
        cost += row.cost;
        row.labels = await scoreResult({ example, result: scored, evaluators, judge: judgeOf });
        perExample.push(row);
        try {
          onProgress({ done: perExample.length, total, requests, cost });
        } catch {
          /* a progress listener must not break the run */
        }
      }
    }

    return {
      id,
      dataset: meta && meta.slug,
      datasetName: meta && meta.name,
      models: ordered,
      evaluators,
      startedAt,
      endedAt: now(),
      status: stopped ? 'stopped' : 'done',
      stopped,
      caps: { maxCostUSD, maxRequests },
      usage: { requests, cost },
      perExample,
      summary: summarize(perExample, { models: ordered, evaluators, examples }),
    };
  }

  return { run };
}

module.exports = {
  REPLAY_DEFAULTS,
  OUTPUT_CAP,
  toMessages,
  toTools,
  previewOf,
  confirmToken,
  orderModels,
  createReplayRunner,
};
