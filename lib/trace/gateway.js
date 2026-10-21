// Agent Gateway sessions for the trace explorer: collaboration runs (full span tree, step text on demand)
// and plain requests grouped by conversation (metadata only: the gateway never stores request text).
// Titles hold the pattern, state, model and counts, never a task or a prompt.
const { spanId, span, maskTitle } = require('./model');

const HOUR = 3600000;
const kindOf = (name) =>
  /^invoke_workflow/.test(name) ? 'session' : /^invoke_agent/.test(name) ? 'agent' : /^chat|^embeddings/.test(name) ? 'chat' : 'tool';
const failed = (r) => r.status >= 400 || !!r.error;
// Model names and span names come from requests and provider replies: masked and capped like a title.
const clip = (v) => maskTitle(String(v)) || '';
const num = (v) => (Number.isFinite(v) ? v : 0);

// A step is one agent call, and the agent call makes one chat span per tool round: the step's text is the
// last round's reply. Which chat span that is:
//  - a step stored with the id of its invoke_agent span (new runs) goes to that span's last-ending chat;
//  - older steps are matched structurally: the k-th text-bearing step of an agent takes the final chat of
//    that agent's k-th top-level invoke_agent span. Failed steps (no text) and failed agent spans do not take
//    a slot. This is best effort: parallel runs of the same agent complete in a different order than they start;
//  - steps made by a bare model call (synthesizer, critic, judge) have no agent span: they take the k-th chat
//    span of the same agent and model that sits outside any agent span.
function linkSteps(trace, steps) {
  const out = new Map();
  const kids = new Map(); // parent span id -> its chat spans, in trace order
  const byId = new Map(trace.map((s) => [s.id, s]));
  for (const s of trace) if (s.parent && kindOf(s.name) === 'chat') (kids.get(s.parent) || kids.set(s.parent, []).get(s.parent)).push(s);
  const endOf = (s) => (Number.isFinite(s.end) ? s.end : -1);
  const finalChat = (parent) => (kids.get(parent) || []).reduce((best, s) => (!best || endOf(s) >= endOf(best) ? s : best), null);
  const claimed = new Set();
  const loose = [];
  steps.forEach((st, i) => {
    if (!st || typeof st.text !== 'string' || !st.text) return;
    const c = st.span && byId.has(st.span) ? finalChat(st.span) : null;
    if (c) {
      out.set(c.id, i);
      claimed.add(st.span);
    } else loose.push(i);
  });
  const agentOf = (s) => (s.attrs && s.attrs['gen_ai.agent.id']) || s.name.slice('invoke_agent '.length);
  const queues = new Map(); // agent id -> its top-level invoke_agent spans that did not fail
  for (const s of trace) {
    const up = byId.get(s.parent);
    if (kindOf(s.name) !== 'agent' || claimed.has(s.id) || s.status === 'error' || (up && kindOf(up.name) === 'agent')) continue;
    (queues.get(agentOf(s)) || queues.set(agentOf(s), []).get(agentOf(s))).push(s);
  }
  const bare = new Map(); // agent|model -> chat spans outside any agent span
  for (const s of trace) {
    const up = byId.get(s.parent);
    if (kindOf(s.name) !== 'chat' || (up && kindOf(up.name) === 'agent')) continue;
    const a = s.attrs || {};
    const key = `${a['zp.agent']}\0${a['gen_ai.request.model']}`;
    (bare.get(key) || bare.set(key, []).get(key)).push(s);
  }
  for (const i of loose) {
    const agentSpan = (queues.get(steps[i].agent) || []).shift();
    const c = agentSpan && finalChat(agentSpan.id);
    if (c) out.set(c.id, i);
    else if (!agentSpan) {
      const b = (bare.get(`${steps[i].agent}\0${steps[i].model}`) || []).shift();
      if (b) out.set(b.id, i);
    }
  }
  return out;
}

function createGatewayAdapter(g) {
  // Requests by conversation, else by key per hour, each group in time order.
  function groups() {
    const out = new Map();
    for (const r of g.requests()) {
      if (r.runId) continue; // a collaboration run's own model call: the run's skeleton already shows it
      const key = r.sessionId ? `req:${String(r.sessionId).slice(0, 80)}` : `req:${String(r.keyId || 'nokey').slice(0, 80)}:${new Date(Math.floor(r.ts / HOUR) * HOUR).toISOString()}`;
      (out.get(key) || out.set(key, []).get(key)).push(r);
    }
    for (const list of out.values()) list.sort((a, b) => a.ts - b.ts);
    return out;
  }

  function sessions() {
    const rows = g.runs().map((r) => {
      const spans = r.trace || [];
      const errors = spans.filter((s) => s.status === 'error').length;
      const ends = spans.map((s) => (Number.isFinite(s.end) ? r.createdAt + s.end : 0));
      return {
        id: `run:${r.id}`,
        source: 'gateway',
        title: `${r.pattern} run · ${r.state} · ${(r.steps || []).length} steps`,
        project: 'gateway',
        branch: null,
        start: r.createdAt,
        end: Math.max(r.createdAt, r.updatedAt || 0, ...ends),
        turns: 1,
        tools: spans.filter((s) => kindOf(s.name) === 'tool').length,
        errors,
        cost: (r.spent && r.spent.cost) || 0,
        flags: { errors: r.state === 'failed' || errors > 0, loop: false, injection: false },
      };
    });
    for (const [id, reqs] of groups()) {
      const models = [...new Set(reqs.map((r) => r.model).filter(Boolean))];
      const errors = reqs.filter(failed).length;
      rows.push({
        id,
        source: 'gateway',
        title: `${reqs.length} request${reqs.length === 1 ? '' : 's'} · ${models.length === 1 ? clip(models[0]) : `${models.length} models`}`,
        project: 'gateway',
        branch: null,
        start: reqs[0].ts,
        end: Math.max(...reqs.map((r) => r.ts + num(r.ms))),
        turns: 1,
        tools: 0,
        errors,
        cost: reqs.reduce((a, r) => a + num(r.cost), 0),
        flags: { errors: errors > 0, loop: false, injection: false },
      });
    }
    return rows;
  }

  function runSkeleton(id, r) {
    const trace = Array.isArray(r.trace) ? r.trace : [];
    const steps = Array.isArray(r.steps) ? r.steps : [];
    const ids = new Set(trace.map((s) => s.id));
    // One root, or a synthetic one when the run has none or several (older runs); orphans hang off it.
    const tops = trace.filter((s) => !s.parent);
    const synth = tops.length !== 1;
    const rootId = synth ? spanId('gw', r.id, 'root') : spanId('gw', r.id, tops[0].id);
    // Which step's text each chat span shows (span id -> index into run.steps).
    const textOf = linkSteps(trace, steps);
    const live = r.state === 'working' || r.state === 'submitted';
    const spans = trace.map((s) => {
      const a = s.attrs || {};
      const kind = kindOf(s.name);
      const i = textOf.get(s.id);
      const text = i !== undefined ? { g: 'run', id: r.id, step: i } : null;
      const open = !Number.isFinite(s.end);
      return span({
        id: spanId('gw', r.id, s.id),
        parent: s.parent && ids.has(s.parent) ? spanId('gw', r.id, s.parent) : s.parent ? rootId : synth ? rootId : null,
        kind,
        op: s.name.split(' ')[0],
        name: clip(s.name),
        start: r.createdAt + num(s.start),
        end: open ? null : r.createdAt + s.end,
        status: s.status === 'error' ? 'error' : open ? (live ? 'running' : 'unknown') : 'ok',
        model: maskTitle(a['gen_ai.request.model']),
        usage: a['gen_ai.usage.input_tokens'] != null ? { input: num(a['gen_ai.usage.input_tokens']), output: num(a['gen_ai.usage.output_tokens']), cacheRead: 0 } : null,
        cost: a['zp.cost_usd'] || null,
        text,
      });
    });
    const ends = spans.map((s) => s.end).filter(Number.isFinite);
    if (synth)
      spans.unshift(span({ id: rootId, kind: 'session', op: 'invoke_workflow', name: `invoke_workflow ${r.pattern}`, start: r.createdAt, end: ends.length && !live ? Math.max(...ends) : null, status: live ? 'running' : 'ok' }));
    if (typeof r.answer === 'string' && r.answer) {
      const at = ends.length ? Math.max(...ends) : r.createdAt;
      spans.push(span({ id: spanId('gw', r.id, 'answer'), parent: rootId, kind: 'answer', op: 'chat', name: 'answer', start: at, end: at, text: { g: 'run', id: r.id, answer: true } }));
    }
    return { session: { id, source: 'gateway', project: 'gateway', branch: null, start: r.createdAt, end: Math.max(r.createdAt, r.updatedAt || 0, ...ends) }, turns: [{ index: 0, start: 0, ts: r.createdAt }], spans };
  }

  function requestSkeleton(id, reqs) {
    const end = Math.max(...reqs.map((r) => r.ts + num(r.ms)));
    const root = span({ id: spanId('gw', id), kind: 'session', op: 'invoke_agent', name: 'gateway session', start: reqs[0].ts, end, status: reqs.some(failed) ? 'error' : 'ok' });
    const spans = [
      root,
      ...reqs.map((r, i) =>
        span({
          id: spanId('gw', id, i),
          parent: root.id,
          kind: 'chat',
          op: r.kind === 'embeddings' ? 'embeddings' : 'chat',
          name: `${r.kind === 'embeddings' ? 'embeddings' : 'chat'} ${maskTitle(r.model) || 'model'}`,
          start: r.ts,
          end: r.ts + num(r.ms),
          status: failed(r) ? 'error' : 'ok',
          model: maskTitle(r.model),
          provider: maskTitle(r.provider),
          usage: { input: num(r.input), output: num(r.output), cacheRead: num(r.cached) },
          cost: r.cost || null,
        }),
      ),
    ];
    return { session: { id, source: 'gateway', project: 'gateway', branch: null, start: root.start, end }, turns: [{ index: 0, start: 0, ts: root.start }], spans };
  }

  async function skeleton(_entry, id) {
    if (typeof id === 'string' && id.startsWith('run:')) {
      const r = g.run(id.slice(4));
      if (!r) throw Object.assign(new Error('run not found'), { status: 404 });
      return runSkeleton(id, r);
    }
    const reqs = groups().get(id);
    if (!reqs) throw Object.assign(new Error('session not found'), { status: 404 });
    return requestSkeleton(id, reqs);
  }

  return { id: 'gateway', sessions, skeleton };
}

module.exports = { createGatewayAdapter };
