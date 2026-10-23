// The dashboard's own data, packaged for the acc connector. The indexer is created lazily,
// so listing tools never touches the logs; each summary does an incremental rescan first.
const path = require('path');
const { Indexer } = require('./indexer');
const { summarize } = require('./aggregate');
const { DEFAULT_PRICING } = require('./pricing');
const processes = require('./processes');
const { createTrace, contentDefaultOff } = require('./trace');
const { traceView } = require('./trace/views');
const { createEvalStore } = require('./evals/store');
const { evalsOverview, demoOverview } = require('./evals/overview');

// `dataDir` holds .data/evals.jsonl for acc_evals (the folder above the cache by default).
// `contentOff`: the stdio MCP process follows ZAAFPULSE_CONTENT; the server passes true, because its integrations also
// answer gateway API keys. `light` replaces the default Kiro, Gemini and Antigravity sources (for tests). `demo`
// (DEMO=1) lists the synthetic trace sessions only, so no log of this machine is read.
function createLocal({
  cacheDir,
  config = {},
  indexer: shared = null,
  contentOff = contentDefaultOff(process.env, false),
  light,
  demo = false,
  dataDir = path.dirname(cacheDir),
}) {
  let indexer = shared;
  const pricing = { ...DEFAULT_PRICING, ...(config.pricing || {}) };
  let trace = null;
  // The trace registry is built once, on the first call that needs it.
  async function getTrace() {
    if (!trace)
      trace = demo
        ? createTrace({ demo: true, contentOff })
        : createTrace({ indexer: await ready(), contentOff, light, pricing });
    return trace;
  }
  async function ready() {
    if (!indexer) indexer = new Indexer([require('./claude'), require('./codex')], path.join(cacheDir, 'index.json'));
    if (!shared) await indexer.refresh();
    return indexer;
  }
  return {
    async summary(range) {
      return summarize((await ready()).results(), { rangeDays: range, pricing });
    },
    // Session metadata only. No roots and no gateway are given, so the registry cannot read any transcript text,
    // and the keys it makes belong to this process. A title comes from a transcript, so it is null with content off.
    async traceSessions({ range, limit } = {}) {
      const trace = await getTrace();
      const n = Math.floor(Number(limit));
      const days = Number(range);
      return trace
        .sessions({ range: Number.isFinite(days) && days > 0 ? days : undefined })
        .slice(0, n >= 1 ? Math.min(n, 200) : 50)
        .map((r) => ({
          key: r.key,
          source: r.source,
          title: r.title,
          project: r.project,
          start: r.start,
          end: r.end,
          turns: r.turns,
          tools: r.tools,
          errors: r.errors,
          cost: r.cost,
          flags: r.flags,
        }));
    },
    // One session that traceSessions listed, in small views (lib/trace/views.js): structure, timing and status
    // only. Its key must come from this process.
    async traceGet({ key, turn, view, span } = {}) {
      const trace = await getTrace();
      // A bad turn is the registry's to reject ('bad turn'); it must not quietly read the last turn.
      return traceView(await trace.session(String(key || ''), { turn: turn ?? undefined }), view, span);
    },
    // Pass rates and the latest failures as ids and labels, read from the results file and the index. It opens the
    // store read-only and has no model, so it can never start judging; explanations and text stay out.
    async evals({ range } = {}) {
      const days = Number(range);
      const from = Number.isFinite(days) && days > 0 ? Date.now() - days * 86400e3 : 0;
      const trace = await getTrace();
      if (demo) return demoOverview({ trace, from });
      return evalsOverview({
        store: createEvalStore({ file: path.join(dataDir, '.data', 'evals.jsonl'), readOnly: true }),
        indexer: await ready(),
        keyFor: (source, sid) => trace.keyFor(source, sid),
        from,
      });
    },
    liveApps: () => processes.snapshot(),
    integrationsStatus: async () => [],
  };
}

module.exports = { createLocal };
