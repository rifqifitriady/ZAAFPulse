// The dashboard's own data, packaged for the acc connector. The indexer is created lazily,
// so listing tools never touches the logs; each summary does an incremental rescan first.
const path = require('path');
const { Indexer } = require('./indexer');
const { summarize } = require('./aggregate');
const { DEFAULT_PRICING } = require('./pricing');
const processes = require('./processes');

function createLocal({ cacheDir, config = {}, indexer: shared = null }) {
  let indexer = shared;
  const pricing = { ...DEFAULT_PRICING, ...(config.pricing || {}) };
  return {
    async summary(range) {
      if (!indexer) indexer = new Indexer([require('./claude'), require('./codex')], path.join(cacheDir, 'index.json'));
      if (!shared) await indexer.refresh();
      return summarize(indexer.results(), { rangeDays: range, pricing });
    },
    liveApps: () => processes.snapshot(),
    integrationsStatus: async () => [],
  };
}

module.exports = { createLocal };
