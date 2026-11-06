// Refused requests in the governance audit log (AI Governance 4), at most LIMIT per account a minute. A reviewer's or a
// viewer's page that keeps asking for an owner-only route, or someone who scripts it, must not bury the log: past the
// limit the refusals of that minute are counted, and once the minute is over one audit.refused_dropped entry says how
// many were left out. Requires nothing; the clock and the recorder are passed in.
const LIMIT = 30;
const WINDOW_MS = 60e3;

// createRefusalLog({ record, now, limit, windowMs }) -> { refused(user, entry, actor), flush() }. record(entry) writes
// one audit entry (server.js govRecord). refused() records the entry, or counts it when the account is over its limit;
// it returns whether the entry was written. flush() writes the counts of the minutes that are over (server.js calls it
// every minute; refused() does too).
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
  function refused(user, entry, actor = null) {
    flush();
    let s = users.get(user);
    if (!s) users.set(user, (s = { start: now(), n: 0, dropped: 0, actor: null }));
    if (s.n < limit) {
      s.n++;
      record(entry);
      return true;
    }
    s.dropped++;
    s.actor = actor; // the last one left out speaks for the count
    return false;
  }
  return { refused, flush };
}

module.exports = { createRefusalLog, LIMIT, WINDOW_MS };
