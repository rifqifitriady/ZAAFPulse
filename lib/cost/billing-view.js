// The ledger as billed: stored rows carry list cost only, and billing is derived from the billing history
// (lib/cost/billing.js) when the ledger is read. A usage row on a day its source was on a plan is billed 0, otherwise
// its list price. Each day a source was on a plan gets one plan row carrying that day's share of the fee. Plan rows are
// made here, never stored, so a day is billed exactly once whatever order the passes ran in (and whether the server
// ran on it at all). Plan rows found in storage (an older format, or a correction) are ignored.
const { SOURCES } = require('./rules');
const { daysBetween, monthOf } = require('./days');
const { planRow } = require('./ledger');

// `rows` is store.view(from, to); its `unread` (months, 'folder', 'corrections') carries over, and no plan row is made
// on a day whose month did not read. Plan rows stop at `today`: a future day is not paid yet.
function billedRows(rows, { from, to, today, billingFor, backfilled = () => false }) {
  const unread = (rows && rows.unread) || [];
  const skip = new Set(unread);
  const out = [];
  for (const r of rows || []) {
    if (r.kind === 'plan') continue;
    const b = billingFor(r.source, r.day);
    const row = { ...r, billedUSD: b.mode === 'plan' ? 0 : r.listUSD };
    if (b.assumed) row.billingAssumed = true; // the history of that day was lost: billed as metered until restated
    out.push(row);
  }
  const last = to < today ? to : today;
  if (!skip.has('folder') && from <= last)
    for (const day of daysBetween(from, last)) {
      if (skip.has(monthOf(day))) continue;
      for (const source of SOURCES) {
        const b = billingFor(source, day);
        if (b.mode === 'plan') out.push(planRow(day, source, b, backfilled(day)));
      }
    }
  return Object.defineProperty(out, 'unread', { value: unread });
}

module.exports = { billedRows };
