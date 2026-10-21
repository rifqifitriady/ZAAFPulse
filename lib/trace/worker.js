// Builds one Claude or Codex skeleton off the main thread, so a log of hundreds of MB does not stall the
// server. The registry sends only what the adapter reads (the session's record, its subagent files or usage
// rows); the skeleton goes back as plain data. Any failure is reported and the registry builds in-thread.
const { parentPort, workerData } = require('worker_threads');

const adapters = { claude: () => require('./claude'), codex: () => require('./codex') };

(async () => {
  try {
    const make = adapters[workerData.adapter];
    if (!make) throw new Error('unknown adapter');
    const { entry, sid, turn, entries, pricing } = workerData;
    const skeleton = await make().skeleton(entry, sid, { turn, entries, pricing });
    parentPort.postMessage({ ok: true, skeleton });
  } catch (e) {
    parentPort.postMessage({ ok: false, message: String((e && e.message) || e), status: e && e.status });
  }
})();
