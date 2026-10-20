// Worker thread for the indexer: parses one log file per message with the parser module the
// main thread names (an absolute path from its require.cache) and posts the result back.
const { parentPort } = require('worker_threads');

parentPort.on('message', async ({ file, mod }) => {
  try {
    const result = await require(mod).parseFile(file);
    parentPort.postMessage({ result });
  } catch (err) {
    parentPort.postMessage({ error: String((err && err.message) || err) });
  }
});
parentPort.postMessage({ ready: true });
