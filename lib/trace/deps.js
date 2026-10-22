// Which agents call which models, tools, agents and remote services, over the stored traces in a time range
// (Jaeger's GetDependencies). A remote service that sent spans back appears behind the call that reached it.
const { maskTitle } = require('./model');

function nodeOf(sp) {
  const a = sp.a || {};
  const op = a['gen_ai.operation.name'];
  if (sp.src === 'remote' || (sp.svc && sp.svc !== 'zaafpulse')) return `service:${sp.svc}`;
  if (sp.k === 'client' && a['rpc.system'] === 'a2a') return `remote:${a['server.address'] || sp.n}`;
  if (op === 'invoke_agent' || sp.n.startsWith('invoke_agent ')) return `agent:${a['gen_ai.agent.id'] || sp.n.slice(13)}`;
  if (op === 'chat' || sp.n.startsWith('chat ')) return `model:${a['gen_ai.request.model'] || sp.n.slice(5)}`;
  if (op === 'execute_tool' || sp.n.startsWith('execute_tool ')) return `tool:${a['gen_ai.tool.name'] || sp.n.slice(13)}`;
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
      const to = nodeOf(sp);
      if (!to) continue;
      const [kind, ...rest] = to.split(':');
      const node = nodes.get(to) || { id: to, kind, label: maskTitle(rest.join(':')) || kind, count: 0 };
      node.count++;
      nodes.set(to, node);
      // The caller: the nearest agent or remote call above, skipping a tool that wraps another tool.
      let caller = null;
      for (let p = byId.get(sp.p), i = 0; p && i < 100; p = byId.get(p.p), i++) {
        const n = nodeOf(p);
        if (n && CALLERS.test(n)) {
          caller = n;
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
