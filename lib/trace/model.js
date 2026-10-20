// The one span shape every trace source produces. Names and kinds follow the OTel GenAI conventions
// (invoke_agent / chat / execute_tool), so an export bridge can map spans one to one later.
const crypto = require('crypto');

const spanId = (...parts) => crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);

function span(f) {
  return { parent: null, status: 'ok', usage: null, cost: null, tool: null, signals: [], text: null, model: null, provider: null, end: null, ...f };
}

function validate(spans) {
  const ids = new Map(spans.map((s) => [s.id, s]));
  const out = [];
  const roots = spans.filter((s) => !s.parent);
  if (roots.length !== 1) out.push(`expected one root, found ${roots.length}`);
  for (const s of spans) {
    if (s.parent && !ids.has(s.parent)) out.push(`${s.id}: parent ${s.parent} missing`);
    const p = s.parent && ids.get(s.parent);
    if (p && Number.isFinite(p.start) && Number.isFinite(s.start) && s.start < p.start) out.push(`${s.id}: starts before its parent`);
  }
  return out;
}

function totals(spans) {
  const t = { input: 0, output: 0, cacheRead: 0, cost: 0, tools: 0, errors: 0 };
  for (const s of spans) {
    if (s.usage) {
      t.input += s.usage.input || 0;
      t.output += s.usage.output || 0;
      t.cacheRead += s.usage.cacheRead || 0;
    }
    if (s.cost) t.cost += s.cost;
    if (s.kind === 'tool') t.tools++;
    if (s.status === 'error') t.errors++;
  }
  return t;
}

module.exports = { spanId, span, validate, totals };
