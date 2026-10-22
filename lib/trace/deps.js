// Which agents call which models, tools, agents and remote services, over the stored traces in a time range
// (Jaeger's GetDependencies). A remote service that sent spans back appears behind the call that reached it.
const { maskTitle } = require('./model');

// One place builds id and label from the masked name, so a secret in a name never reaches the client and the two
// cannot drift (maskTitle is deterministic, so the id still identifies the node).
const node = (kind, raw) => {
  const label = maskTitle(String(raw || '')) || kind;
  return { id: `${kind}:${label}`, kind, label };
};
// The name after its operation prefix, only when the span name has that prefix.
const after = (sp, prefix) => (sp.n.startsWith(prefix) ? sp.n.slice(prefix.length) : '');

function nodeOf(sp) {
  const a = sp.a || {};
  const op = a['gen_ai.operation.name'];
  if (sp.src === 'remote' || (sp.svc && sp.svc !== 'zaafpulse')) return node('service', sp.svc);
  if (sp.k === 'client' && a['rpc.system'] === 'a2a') return node('remote', a['server.address'] || sp.n);
  if (op === 'invoke_agent' || sp.n.startsWith('invoke_agent ')) return node('agent', a['gen_ai.agent.id'] || after(sp, 'invoke_agent '));
  if (op === 'chat' || sp.n.startsWith('chat ')) return node('model', a['gen_ai.request.model'] || after(sp, 'chat '));
  if (op === 'execute_tool' || sp.n.startsWith('execute_tool ')) return node('tool', a['gen_ai.tool.name'] || after(sp, 'execute_tool '));
  return null;
}
const CALLERS = /^(agent|remote):/;

function dependencies(store, { from = 0, to = Infinity, limit = 500 } = {}) {
  const pool = store
    .summaries()
    .filter((s) => s.end >= from * 1000 && s.start <= to * 1000)
    .sort((a, b) => b.start - a.start)
    .slice(0, limit);
  const nodes = new Map();
  const edges = new Map();
  for (const s of pool) {
    const spans = store.getSpans(s.traceId) || [];
    const byId = new Map(spans.map((x) => [x.s, x]));
    for (const sp of spans) {
      const n0 = nodeOf(sp);
      if (!n0) continue;
      // An integration's own span inside its tool call is the same call (as in summary.js): no count, no edge.
      if (sp.src !== 'remote' && (!sp.svc || sp.svc === 'zaafpulse') && (sp.a || {})['zaafpulse.tool.nested'] === true) continue;
      // A remote service counts once per call: only its entry span, not the spans it ran inside.
      if (n0.kind === 'service') {
        const par = byId.get(sp.p);
        if (par && par.svc === sp.svc) continue;
      }
      const to = n0.id;
      const node = nodes.get(to) || { ...n0, count: 0 };
      node.count++;
      nodes.set(to, node);
      // The caller: the nearest agent or remote call above, skipping a tool that wraps another tool.
      let caller = null;
      for (let p = byId.get(sp.p), i = 0; p && i < 100; p = byId.get(p.p), i++) {
        const n = nodeOf(p);
        if (n && CALLERS.test(n.id)) {
          caller = n.id;
          break;
        }
      }
      if (!caller || caller === to) continue;
      const k = `${caller}\n${to}`;
      const e = edges.get(k) || { from: caller, to, count: 0, errors: 0, ms: [] };
      e.count++;
      if (!sp.ok) e.errors++;
      e.ms.push(sp.d / 1000);
      edges.set(k, e);
    }
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => b.count - a.count),
    edges: [...edges.values()]
      .map(({ ms, ...e }) => {
        ms.sort((a, b) => a - b);
        return { ...e, p95Ms: ms[Math.max(0, Math.ceil(ms.length * 0.95) - 1)] };
      })
      .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)),
  };
}

module.exports = { dependencies, nodeOf };
