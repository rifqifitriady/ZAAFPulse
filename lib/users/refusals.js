// A reviewer's or a viewer's repeatable entries in the governance audit log (AI Governance 4): refused requests,
// errors, evidence exports and requests that changed nothing, at most LIMIT per account a minute. A page that keeps
// asking for an owner-only route, or someone who scripts calls, must not bury the log: past the limit the entries of
// that minute are counted, and once the minute is over one audit.refused_dropped entry says how many were left out.
// Requires nothing; the clock and the recorder are passed in.
const LIMIT = 30;
const WINDOW_MS = 60e3;

// createRefusalLog({ record, now, limit, windowMs }) -> { refused(user, entry), flush() }. record(entry) writes one
// audit entry and returns it (server.js govWrite). refused() records the entry, or counts it when the account is over
// its limit; it returns what record() returned, or null when the entry was left out. flush() writes the counts of the
// minutes that are over (server.js calls it every minute; refused() does too). The count entry carries the actor of
// the last entry left out.
function createRefusalLog({ record, now = Date.now, limit = LIMIT, windowMs = WINDOW_MS } = {}) {
  const users = new Map(); // account -> { start, n, dropped, actor }
  function flush() {
    const t = now();
    for (const [user, s] of users) {
      if (t - s.start < windowMs) continue;
      users.delete(user);
      if (s.dropped)
        record({
          action: 'audit.refused_dropped',
          outcome: 'refused',
          target: { type: 'user', id: user },
          dropped: s.dropped,
          ...(s.actor ? { actor: s.actor } : {}),
        });
    }
  }
  function refused(user, entry) {
    flush();
    let s = users.get(user);
    if (!s) users.set(user, (s = { start: now(), n: 0, dropped: 0, actor: null }));
    if (s.n < limit) {
      s.n++;
      return record(entry);
    }
    s.dropped++;
    s.actor = (entry && entry.actor) || null; // the last one left out speaks for the count
    return null;
  }
  return { refused, flush };
}

module.exports = { createRefusalLog, LIMIT, WINDOW_MS };
