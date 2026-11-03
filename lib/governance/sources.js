// Governance inventory (AI Governance 3): checks on what server.js reads for the inventory, so that a source that
// reports its failure as data (an { error } snapshot, a non-200 reply) counts as failed, not as empty.

// The process snapshot, or a throw when it carries an error.
function liveOrThrow(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.error)
    throw new Error('the process list could not be read');
  return snapshot;
}

// The body of the runtimes reply, or a throw unless the reply is a 200 with a list.
function runtimesOrThrow(reply) {
  if (!reply || reply.status !== 200 || !Array.isArray(reply.body)) throw new Error('the runtimes could not be read');
  return reply.body;
}

// The log index's state, or a throw until its first scan in this run is done: what it holds before that (its cache file
// from an earlier run, or nothing) is not the tools and models in use now, so the summary counts as failed and a first
// build keeps its baseline open. During a later rescan it still holds the previous scan, which is used.
function indexReadyOrThrow(state) {
  if (!state || typeof state !== 'object' || !state.lastScan) throw new Error('the log index is not ready');
  return state;
}

module.exports = { liveOrThrow, runtimesOrThrow, indexReadyOrThrow };
