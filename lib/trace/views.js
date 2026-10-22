// Small views of one explorer skeleton for an AI client (acc_trace_get), shaped like Jaeger's MCP tools: the
// topology first, then the critical path, the errors, or one span. Never text, content ids or file paths.
const MAX_SPANS = 2000;
const fail = (status, message) => Object.assign(new Error(message), { status });
const msOf = (s) => (Number.isFinite(s.start) && Number.isFinite(s.end) ? Math.round(s.end - s.start) : null);

function traceView(sk, view, spanId) {
  const spans = Array.isArray(sk && sk.spans) ? sk.spans : [];
  const an = (sk && sk.analysis) || null;
  const byId = new Map(spans.map((s) => [s.id, s]));
  const onPath = new Set(an ? an.criticalPath.map((x) => x.spanId) : []);
  if (view === 'topology')
    return {
      spans: spans.slice(0, MAX_SPANS).map((s) => ({ id: s.id, parent: s.parent, kind: s.kind, name: s.name, ms: msOf(s), status: s.status })),
      truncated: spans.length > MAX_SPANS,
    };
  if (view === 'critical_path') {
    const sections = (an ? an.criticalPath : []).map((x) => ({
      id: x.spanId,
      name: byId.has(x.spanId) ? byId.get(x.spanId).name : null,
      ms: Math.round(x.end - x.start),
    }));
    return { totalMs: sections.reduce((n, x) => n + x.ms, 0), sections };
  }
  if (view === 'errors')
    return {
      rootCause: an ? an.rootCause : null,
      failed: spans
        .filter((s) => s.status === 'error')
        .map((s) => ({ id: s.id, parent: s.parent, name: s.name, ms: msOf(s), error: typeof s.error === 'string' ? s.error : null })),
    };
  if (view === 'span') {
    const s = byId.get(spanId);
    if (!s) throw fail(404, 'unknown span: take an id from the topology view');
    return {
      id: s.id,
      parent: s.parent,
      kind: s.kind,
      name: s.name,
      start: s.start,
      end: s.end,
      ms: msOf(s),
      status: s.status,
      model: s.model || null,
      provider: s.provider || null,
      usage: s.usage || null,
      cost: s.cost ?? null,
      tool: s.tool && s.tool.name ? { name: s.tool.name } : null,
      error: typeof s.error === 'string' ? s.error : null,
      selfMs: an && an.selfTime && Number.isFinite(an.selfTime[s.id]) ? Math.round(an.selfTime[s.id]) : null,
      rollup: (an && an.rollup && an.rollup[s.id]) || null,
      onCriticalPath: onPath.has(s.id),
    };
  }
  throw fail(400, 'view must be topology, critical_path, errors or span');
}

module.exports = { traceView };
