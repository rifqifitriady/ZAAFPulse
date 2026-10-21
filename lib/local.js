// The dashboard's own data, packaged for the acc connector. The indexer is created lazily,
// so listing tools never touches the logs; each summary does an incremental rescan first.
const path = require('path');
const { Indexer } = require('./indexer');
const { summarize } = require('./aggregate');
const { DEFAULT_PRICING } = require('./pricing');
const processes = require('./processes');
const { createTrace, contentDefaultOff } = require('./trace');

// `contentOff` comes from the server, which knows its mode; the MCP process is never in server mode.
function createLocal({
  cacheDir,
  config = {},
  indexer: shared = null,
  contentOff = contentDefaultOff(process.env, false),
}) {
  let indexer = shared;
  const pricing = { ...DEFAULT_PRICING, ...(config.pricing || {}) };
  let trace = null;
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
      const idx = await ready();
      if (!trace) trace = createTrace({ indexer: idx, contentOff, pricing });
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
    liveApps: () => processes.snapshot(),
    integrationsStatus: async () => [],
  };
}

module.exports = { createLocal };
