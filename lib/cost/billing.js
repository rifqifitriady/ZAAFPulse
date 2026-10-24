// Billing history: how each source was billed on each day, kept like the price versions so that billing is derived
// when the ledger is read instead of being decided (and stored) by the pass. Stored rows carry list cost only; the
// reader bills them (lib/cost/billing-view.js). File: <dir>/billing.json { version: 1, entries, overrides }.
//  - entries: { source, from, billing }. A change of a source's billing in the settings starts a new entry dated the
//    day it is seen, never before the source's previous entry. A source with no entry is metered.
//  - overrides: { source, from, to, billing }, written by a restate. Inside its range an override wins over the
//    entries, and a later override wins over an earlier one.
const fs = require('fs');
const path = require('path');
const { isDay } = require('./days');
const { SOURCES, LIMITS } = require('./rules');
const { writePrivate } = require('./files');

const METERED = Object.freeze({ mode: 'metered' });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// The billing as stored: only the fields that matter, in a fixed order, so two equal settings compare equal.
function normalize(b) {
  if (!isObj(b)) return null;
  if (b.mode === 'metered') return { mode: 'metered' };
  if (b.mode !== 'plan') return null;
  const plan = typeof b.plan === 'string' ? b.plan.trim() : '';
  if (!plan || plan.length > LIMITS.plan) return null;
  if (typeof b.feeUSD !== 'number' || !Number.isFinite(b.feeUSD) || b.feeUSD < 0 || b.feeUSD > 1e6) return null;
  if (b.period !== 'month' && b.period !== 'year') return null;
  return { mode: 'plan', plan, feeUSD: b.feeUSD, period: b.period };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const entryOf = (e) =>
  isObj(e) && SOURCES.includes(e.source) && isDay(e.from) && normalize(e.billing)
    ? { source: e.source, from: e.from, billing: normalize(e.billing) }
    : null;
const overrideOf = (o) =>
  isObj(o) && SOURCES.includes(o.source) && isDay(o.from) && isDay(o.to) && o.from <= o.to && normalize(o.billing)
    ? { source: o.source, from: o.from, to: o.to, billing: normalize(o.billing) }
    : null;
const byFrom = (a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0);
const copy = (v) => JSON.parse(JSON.stringify(v));

function unreadError(cause) {
  const e = new Error('the billing history could not be read');
  e.code = 'BILLING_UNREAD';
  if (cause && typeof cause.code === 'string') e.reason = cause.code;
  return e;
}

function createBillingHistory({ dir = null } = {}) {
  const file = dir && path.join(dir, 'billing.json');
  let entries = []; // sorted by source, then from
  let overrides = []; // in the order they were added
  let failure = null; // the read error while billing.json exists but does not read: nothing is written then
  const problems = [];

  // A file that does not read (permissions, a lock) keeps the history unavailable, and it is retried: writing it then
  // would replace the history. A file that reads but does not parse is kept aside and the history starts again.
  function load() {
    if (!file) return;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') {
        failure = null;
        return;
      }
      failure = e;
      return;
    }
    failure = null;
    let raw = null;
    try {
      raw = JSON.parse(text);
    } catch {
      /* below */
    }
    if (!isObj(raw) || !Array.isArray(raw.entries)) {
      let bad = `${file}.bad`;
      for (let n = 1; fs.existsSync(bad); n++) bad = `${file}.bad.${n}`;
      try {
        fs.renameSync(file, bad);
      } catch {
        /* best effort: the next write replaces it */
      }
      problems.push('the billing history was unreadable: kept aside and started again');
      return;
    }
    const es = raw.entries.map(entryOf);
    const os = (Array.isArray(raw.overrides) ? raw.overrides : []).map(overrideOf);
    const dropped = es.filter((e) => !e).length + os.filter((o) => !o).length;
    if (dropped) problems.push(`the billing history had ${dropped} unusable entries that were ignored`);
    entries = es.filter(Boolean).sort((a, b) => SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) || byFrom(a, b));
    overrides = os.filter(Boolean);
  }
  load();

  const ready = () => {
    if (failure) load();
    if (failure) throw unreadError(failure);
  };
  const save = (es, os) => {
    if (file) writePrivate(file, JSON.stringify({ version: 1, entries: es, overrides: os }));
  };

  // Compares the current billing settings with each source's newest entry. `firstUse(source)` gives the day a source
  // without any entry was first used (its billing then applies from that day: the first-run backfill), or undefined
  // to leave that source for a later call; without `firstUse` such sources are left alone. Returns whether it changed.
  function observe(settings, today, { firstUse = null } = {}) {
    ready();
    const next = entries.map((e) => ({ ...e }));
    let changed = false;
    for (const source of SOURCES) {
      const cur = normalize(isObj(settings) ? settings[source] : null) || { ...METERED };
      const mine = next.filter((e) => e.source === source);
      if (!mine.length) {
        if (!firstUse) continue;
        const day = firstUse(source);
        if (day === undefined) continue;
        next.push({ source, from: isDay(day) && day < today ? day : today, billing: cur });
        changed = true;
        continue;
      }
      const last = mine[mine.length - 1];
      if (same(last.billing, cur)) continue;
      // The newest of a day wins, and an entry is never dated before the previous one (a clock that went back).
      if (last.from >= today) last.billing = cur;
      else next.push({ source, from: today, billing: cur });
      changed = true;
    }
    if (!changed) return false;
    next.sort((a, b) => SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) || byFrom(a, b));
    save(next, overrides);
    entries = next;
    return true;
  }

  // The billing in force for `source` on `day`. While the history does not read this is metered, and the caller's
  // status says so.
  function billingFor(source, day) {
    for (let i = overrides.length - 1; i >= 0; i--) {
      const o = overrides[i];
      if (o.source === source && o.from <= day && day <= o.to) return o.billing;
    }
    let hit = null;
    for (const e of entries) if (e.source === source && e.from <= day) hit = e.billing;
    return hit || METERED;
  }

  function addOverride(o) {
    const x = overrideOf(o);
    if (!x) throw new TypeError('not a valid billing override');
    ready();
    save(entries, [...overrides, x]);
    overrides = [...overrides, x];
    return copy(x);
  }

  // Demo: entries held in memory.
  function seed(list) {
    entries = (list || []).map(entryOf).filter(Boolean);
  }

  return {
    observe,
    billingFor,
    addOverride,
    seed,
    has: (source) => entries.some((e) => e.source === source),
    list: () => ({ entries: copy(entries), overrides: copy(overrides) }),
    problems: () => [...problems],
    error: () => (failure ? unreadError(failure) : null),
  };
}

module.exports = { createBillingHistory, normalizeBilling: normalize };
