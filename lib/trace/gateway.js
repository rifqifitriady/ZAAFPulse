// Agent Gateway sessions for the trace explorer: collaboration runs (full span tree, step text on demand)
// and plain requests grouped by conversation (metadata only: the gateway never stores request text).
// Titles hold the pattern, state, model and counts, never a task or a prompt.
const { spanId, span, maskTitle } = require('./model');
const { adjust } = require('./adjust');
const { runSpanId } = require('../otel');

const HOUR = 3600000;
const kindOf = (name) =>
  /^invoke_workflow/.test(name) ? 'session' : /^invoke_agent/.test(name) ? 'agent' : /^chat|^embeddings/.test(name) ? 'chat' : 'tool';
const failed = (r) => r.status >= 400 || !!r.error;
// Model names and span names come from requests and provider replies: masked and capped like a title.
const clip = (v) => maskTitle(String(v)) || '';
const OPS = new Set(['chat', 'embeddings', 'execute_tool', 'invoke_agent', 'invoke_workflow', 'plan', 'judge']);
const opOf = (r, a) => [a['gen_ai.operation.name'], String(r.n).split(' ')[0]].find((v) => OPS.has(v)) || 'span';
const num = (v) => (Number.isFinite(v) ? v : 0);
// Labels of a stored trace the search box matches: agent ids, model and tool names, masked.
const tagsOf = (s) => [...s.agents, ...s.models, ...s.tools].map(clip).filter(Boolean);

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

// A stored span record (lib/trace/recorder.js) as an explorer span. Times become milliseconds; OTel counts cached
// tokens inside input, the explorer next to it. Names and labels are masked and capped like a title. A span from
// the return channel carries no usage or cost: it was not billed here, and a model call the remote agent made
// through this gateway is counted already.
function fromRecord(r, textOf) {
  const a = r.a || {};
  const kind = r.k === 'server' ? 'session' : r.k === 'client' && /^a2a /.test(r.n) ? 'agent' : kindOf(r.n);
  const chat = kind === 'chat';
  const billed = chat && r.src !== 'remote';
  const cached = num(a['gen_ai.usage.cache_read.input_tokens']);
  return span({
    id: r.s,
    parent: r.p || null,
    kind,
    op: opOf(r, a),
    name: clip(r.n),
    start: r.st / 1000,
    end: (r.st + r.d) / 1000,
    status: r.ok ? 'ok' : 'error',
    model: chat ? maskTitle(a['gen_ai.request.model']) : null,
    provider: chat ? maskTitle(a['gen_ai.provider.name']) : null,
    usage:
      billed && a['gen_ai.usage.input_tokens'] != null
        ? { input: Math.max(0, num(a['gen_ai.usage.input_tokens']) - cached), output: num(a['gen_ai.usage.output_tokens']), cacheRead: cached }
        : null,
    cost: billed ? num(a['zaafpulse.cost.usd']) || null : null,
    tool: kind === 'tool' && a['gen_ai.tool.name'] ? { name: clip(a['gen_ai.tool.name']), target: null } : null,
    // The integration's own span inside an agent's execute_tool span: the same call, not counted twice.
    ...(kind === 'tool' && a['zaafpulse.tool.nested'] === true ? { nested: true } : {}),
    service: typeof r.svc === 'string' ? clip(r.svc) || null : null,
    error: r.ok ? null : clip(r.err || 'error'),
    text: textOf.get(r.s) || null,
  });
}

// A span of run.trace (times in ms since the run started) as an explorer span; names masked like a title.
function fromRunSpan(r, s, { id, parent, live, text = null, service = null }) {
  const a = s.attrs || {};
  const open = !Number.isFinite(s.end);
  const kind = kindOf(s.name);
  // Named like a stored tool span, so a run reads the same with or without the store.
  const toolName = a['gen_ai.tool.name'] || (/^execute_tool /.test(s.name) ? s.name.slice('execute_tool '.length) : null);
  return span({
    id,
    parent,
    kind,
    op: s.name.split(' ')[0],
    name: clip(s.name),
    start: r.createdAt + num(s.start),
    end: open ? null : r.createdAt + s.end,
    status: s.status === 'error' ? 'error' : open ? (live ? 'running' : 'unknown') : 'ok',
    model: maskTitle(a['gen_ai.request.model']),
    usage: a['gen_ai.usage.input_tokens'] != null ? { input: num(a['gen_ai.usage.input_tokens']), output: num(a['gen_ai.usage.output_tokens']), cacheRead: 0 } : null,
    cost: a['zp.cost_usd'] || null,
    tool: kind === 'tool' && toolName ? { name: clip(toolName), target: null } : null,
    ...(service ? { service } : {}),
    text,
  });
}
const isLive = (r) => r.state === 'working' || r.state === 'submitted';

function createGatewayAdapter(g, store = null) {
  // Requests by conversation, else by key per hour, each group in time order.
  function groups() {
    const out = new Map();
    for (const r of g.requests()) {
      if (r.runId) continue; // a collaboration run's own model call: the run's skeleton already shows it
      // A request whose trace the store holds is listed from the store. Per request, not by time: an unsampled
      // request, spans lost to a full buffer or a failed write, and traffic while tracing was off stay listed.
      if (store && typeof r.traceId === 'string' && store.getSummary(r.traceId)) continue;
      const key = r.sessionId ? `req:${String(r.sessionId).slice(0, 80)}` : `req:${String(r.keyId || 'nokey').slice(0, 80)}:${new Date(Math.floor(r.ts / HOUR) * HOUR).toISOString()}`;
      (out.get(key) || out.set(key, []).get(key)).push(r);
    }
    for (const list of out.values()) list.sort((a, b) => a.ts - b.ts);
    return out;
  }

  // One row per stored trace, with the run it belongs to. The title is the root span's name and counts, never a
  // task or a prompt.
  // Rebuilt only when the store changed (its generation), not on every listing: at 100,000 stored traces that is
  // 100,000 masked titles each time.
  let cached = { gen: null, list: [] };
  function storedRows() {
    if (!store) return [];
    const gen = typeof store.generation === 'function' ? store.generation() : null;
    if (gen !== null && cached.gen === gen) return cached.list;
    const list = store.summaries().map((s) => {
      const models = s.models.length === 1 ? clip(s.models[0]) : s.models.length ? `${s.models.length} models` : null;
      const row = {
        id: `trace:${s.traceId}`,
        source: 'gateway',
        title: [clip(s.root) || 'trace', `${s.spans} span${s.spans === 1 ? '' : 's'}`, models].filter(Boolean).join(' · '),
        project: 'gateway',
        branch: null,
        start: Math.floor(s.start / 1000),
        end: Math.ceil(s.end / 1000),
        turns: 1,
        tools: s.toolCalls,
        errors: s.errors,
        cost: s.costUSD,
        flags: { errors: s.errors > 0, loop: false, injection: false },
        tags: tagsOf(s),
        stamp: `${s.spans}:${s.end}`,
      };
      return { traceId: s.traceId, runId: s.runId, row };
    });
    cached = { gen, list };
    return list;
  }

  // The stored trace of a run: by run id once its root span is exported, by trace id while it runs.
  const storedOf = (r) =>
    store ? store.byRun(r.id) || (r.otel && r.otel.traceId ? store.getSummary(r.otel.traceId) : null) || null : null;

  function sessions() {
    const runs = g.runs();
    // A run keeps its run: row even when the store holds its trace (evals, feedback and links use that id).
    const rows = runs.map((r) => {
      const spans = r.trace || [];
      const errors = spans.filter((s) => s.status === 'error').length;
      const ends = spans.map((s) => (Number.isFinite(s.end) ? r.createdAt + s.end : 0));
      const row = {
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
      const sum = storedOf(r);
      if (sum) {
        row.tags = tagsOf(sum);
        // Its skeleton comes from the store: a stored span must not leave a cached one stale.
        row.stamp = `${row.end}:${row.tools}:${row.errors}:${sum.spans}:${sum.end}`;
      }
      return row;
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
    const runIds = new Set(runs.map((r) => r.id));
    const runTraces = new Set(runs.map((r) => r.otel && r.otel.traceId).filter(Boolean));
    for (const x of storedRows()) if (!runIds.has(x.runId) && !runTraces.has(x.traceId)) rows.push(x.row);
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
    const live = isLive(r);
    const spans = trace.map((s) => {
      const i = textOf.get(s.id);
      return fromRunSpan(r, s, {
        id: spanId('gw', r.id, s.id),
        parent: s.parent && ids.has(s.parent) ? spanId('gw', r.id, s.parent) : s.parent ? rootId : synth ? rootId : null,
        live,
        text: i !== undefined ? { g: 'run', id: r.id, step: i } : null,
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

  // The run's step text, keyed by the stored id of the chat span it belongs to (otel runSpanId).
  function runText(run) {
    const out = new Map();
    for (const [rtId, step] of linkSteps(Array.isArray(run.trace) ? run.trace : [], Array.isArray(run.steps) ? run.steps : []))
      out.set(runSpanId(run.id, rtId), { g: 'run', id: run.id, step });
    return out;
  }

  // A stored trace's records as explorer spans (not yet adjusted), with the run's step text linked; null when
  // its segments are gone. `svc` is our own service name as the records give it.
  function storedSpans(traceId, run) {
    const recs = store ? store.getSpans(traceId) : null;
    if (!recs || !recs.length) return null;
    const textOf = run ? runText(run) : new Map();
    // The callee knows our client span id (it came in the traceparent): a remote record with an id one of ours
    // uses is dropped, or adjust() could keep it in place of ours.
    const own = recs.filter((r) => r.src !== 'remote');
    const ours = new Set(own.map((r) => r.s));
    const kept = recs.filter((r) => r.src !== 'remote' || !ours.has(r.s));
    const svc = own.length && typeof own[0].svc === 'string' ? clip(own[0].svc) || null : null;
    return { spans: kept.map((r) => fromRecord(r, textOf)), svc };
  }

  // Adjusted spans, the run's answer and the session around them.
  function finish(id, spans, run) {
    let start = Infinity;
    let end = -Infinity;
    for (const s of spans) {
      if (s.start < start) start = s.start;
      const e = Number.isFinite(s.end) ? s.end : s.start;
      if (e > end) end = e;
    }
    // adjust() hangs orphans under a root but leaves every span without a parent a root. A resumed run whose
    // executions have no stored span above them (a dashboard run, or its request span not stored) has one per
    // execution: they go under one synthetic root, as in runSkeleton.
    const tops = spans.filter((s) => !s.parent);
    if (tops.length > 1) {
      const live = !!run && isLive(run);
      const rootId = spanId('gw', run ? run.id : id, 'root');
      for (const s of tops) s.parent = rootId;
      spans.unshift(
        span({
          id: rootId,
          kind: 'session',
          op: run ? 'invoke_workflow' : 'span',
          name: run ? `invoke_workflow ${clip(run.pattern) || 'run'}` : 'trace',
          start,
          end: live ? null : end,
          status: live ? 'running' : 'ok',
        }),
      );
    }
    if (run && typeof run.answer === 'string' && run.answer) {
      const wfs = (run.trace || []).filter((s) => s.parent == null && /^invoke_workflow/.test(s.name));
      const rootId = wfs.length ? runSpanId(run.id, wfs[wfs.length - 1].id) : null;
      const parent = spans.some((s) => s.id === rootId) ? rootId : spans.find((s) => !s.parent).id;
      spans.push(span({ id: spanId('gw', run.id, 'answer'), parent, kind: 'answer', op: 'chat', name: 'answer', start: end, end, text: { g: 'run', id: run.id, answer: true } }));
    }
    return { session: { id, source: 'gateway', project: 'gateway', branch: null, start, end }, turns: [{ index: 0, start: 0, ts: start }], spans };
  }

  function storedSkeleton(id) {
    const traceId = id.slice('trace:'.length);
    const sum = store ? store.getSummary(traceId) : null;
    // By run id once the root span is exported, else the run whose trace this is (it is still running).
    const run = (sum && sum.runId && g.run(sum.runId)) || g.runs().find((r) => r.otel && r.otel.traceId === traceId) || null;
    const got = storedSpans(traceId, run);
    if (!got) throw Object.assign(new Error('session file changed, rescanning'), { status: 404 });
    return finish(id, adjust(got.spans), run);
  }

  // A run whose trace the store holds: the stored spans, plus the spans of run.trace the store lacks. Agent and
  // workflow spans are exported only when the run ends, so while it runs (or after it died mid-way) they come
  // from run.trace, under the ids they will be stored with; chat spans the gateway stored keep their details.
  function storedRunSkeleton(id, r, sum) {
    const got = storedSpans(sum.traceId, r);
    if (!got) return null;
    const stored = got.spans;
    const have = new Set(stored.map((s) => s.id));
    const trace = (Array.isArray(r.trace) ? r.trace : []).filter((s) => s && !have.has(runSpanId(r.id, s.id)));
    const ids = new Set([...have, ...trace.map((s) => runSpanId(r.id, s.id))]);
    // A run root's parent: the request span that started it once stored, else none (finish() adds one root over
    // every parentless span, so the tree keeps its shape before and after the executions are exported).
    const otelSpan = r.otel && r.otel.spanId;
    const top = otelSpan && have.has(otelSpan) ? otelSpan : null;
    const textOf = runText(r);
    const live = isLive(r);
    const merged = trace.map((s) => {
      const id2 = runSpanId(r.id, s.id);
      const up = s.parent != null ? runSpanId(r.id, s.parent) : null;
      return fromRunSpan(r, s, { id: id2, parent: up && ids.has(up) ? up : top, live, text: textOf.get(id2) || null, service: got.svc });
    });
    return finish(id, adjust(stored.concat(merged)), r);
  }

  async function skeleton(_entry, id) {
    if (typeof id === 'string' && id.startsWith('trace:')) return storedSkeleton(id);
    if (typeof id === 'string' && id.startsWith('run:')) {
      const r = g.run(id.slice(4));
      if (!r) throw Object.assign(new Error('run not found'), { status: 404 });
      const sum = storedOf(r);
      return (sum && storedRunSkeleton(id, r, sum)) || runSkeleton(id, r);
    }
    const reqs = groups().get(id);
    if (!reqs) throw Object.assign(new Error('session not found'), { status: 404 });
    return requestSkeleton(id, reqs);
  }

  return { id: 'gateway', sessions, skeleton };
}

module.exports = { createGatewayAdapter };
