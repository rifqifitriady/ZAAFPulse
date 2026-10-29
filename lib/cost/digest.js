// Cost Control 5: the weekly digest's scheduler. After each ledger pass, check() sends last week's digest (Monday to
// Sunday) once: when it is enabled, outside demo mode, with no send in flight, and when last week's Monday is newer
// than the marker <cost dir>/digest.json { lastWeek }. The marker moves only after a send that reached a channel (or
// when no channel is on), so a restart never sends twice and a missed Monday still sends once that week. A week that
// fails is logged once and tried again on the next pass.
const fs = require('fs');
const { dayOf, isDay } = require('./days');
const { settingsOf } = require('./rules');
const { lastWeek, digestFigures, DIGEST_HISTORY } = require('./report');
const { addDays } = require('./days');
const { PATHLIKE } = require('../monitors/api');
const { writePrivate } = require('./files');

// A message for the log without any path: the owner's folders are not for the console.
function scrub(m) {
  return String(m == null ? '' : m)
    .replace(/~[\\/][^\s"'`]*/g, '[path]')
    .replace(PATHLIKE, '[path]')
    .slice(0, 300);
}

// The figures provider for createDigest: reads [week.from - 28, week.to], the saved anomaly parameters and the ledger's
// first day. Cost settings that do not read (broken config.json, invalid section) throw, so the week is retried.
function digestSource({ cost, getSettings, budgets, anomalyParams, recommendations, home = '' }) {
  const quiet = (fn, fallback) => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  return (week) => {
    const s = settingsOf(getSettings(), { home });
    if (s.error) throw new Error('the cost settings do not read yet');
    const r = cost.budgetRows({ from: addDays(week.from, -DIGEST_HISTORY), to: week.to });
    const rec = recommendations();
    return digestFigures({
      rows: r.rows,
      unread: r.unread,
      week,
      since: cost.firstDay(),
      centers: s.value.centers,
      budgets: quiet(budgets, []),
      anomalyParams: quiet(anomalyParams, null),
      recommendation: rec && rec.items && rec.items[0] ? rec.items[0] : null,
    });
  };
}

function createDigest({
  file = null, // <cost dir>/digest.json; null keeps the marker in memory only (tests, demo)
  getSettings = () => undefined, // the raw cost section, false while config.json does not parse
  figures, // (week) => digestFigures(...); throws when the ledger does not read
  send, // (figures) => Promise<{ ok, tried, errors }> (channels.digest)
  demo = false,
  now = Date.now,
  log = () => {},
} = {}) {
  let enabled = false; // the last digest setting that validated (memory only)
  let sent = null; // the last week settled by this process (kept even if the marker could not be written)
  let failedWeek = null; // the week a failure was logged for
  let busy = false;

  function marker() {
    if (!file) return null;
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return v && isDay(v.lastWeek) ? v.lastWeek : null;
    } catch {
      return null; // missing or broken: none
    }
  }
  function settle(week) {
    sent = week;
    if (!file) return;
    try {
      writePrivate(file, JSON.stringify({ lastWeek: week }));
    } catch (e) {
      log(`cost digest: the marker could not be written${e && e.code ? ` (${e.code})` : ''}`);
    }
  }
  function failed(week, why) {
    if (failedWeek === week) return;
    failedWeek = week;
    log(`cost digest: the week of ${week} was not sent (${why}); trying again on the next pass`);
  }

  async function check() {
    if (demo || busy) return { sent: false };
    busy = true;
    try {
      const s = settingsOf(getSettings());
      if (!s.error) enabled = s.value.digest.enabled === true; // a broken config.json keeps the last valid flag
      if (!enabled) return { sent: false };
      const week = lastWeek(dayOf(now()));
      const last = [marker(), sent].filter(Boolean).sort().pop() || null;
      if (last && last >= week.from) return { sent: false };
      let r;
      try {
        r = await send(figures(week));
      } catch (e) {
        failed(week.from, scrub((e && e.message) || 'the digest could not be built or sent'));
        return { sent: false };
      }
      if (r && (r.ok || r.tried === 0)) {
        settle(week.from);
        return { sent: !!r.ok, week: week.from };
      }
      failed(week.from, scrub(((r && r.errors) || []).join('; ')) || 'no channel delivered it');
      return { sent: false };
    } finally {
      busy = false;
    }
  }

  return { check };
}

module.exports = { createDigest, digestSource };
