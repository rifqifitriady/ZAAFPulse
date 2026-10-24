// Billing history: how each source was billed on each day, kept like the price versions so that billing is derived
// when the ledger is read instead of being decided (and stored) by the pass. Stored rows carry list cost only; the
// reader bills them (lib/cost/billing-view.js).
// File: <dir>/billing.json { version: 1, entries, overrides, lostBefore }, with billing.json.bak, the same content
// written after each save: the last good copy. It is the only record of past billing, so it is never restarted
// silently:
//  - entries: { source, from, billing }. A change of a source's billing in the settings starts a new entry dated the
//    day it is seen, never before the source's previous entry. A source with no entry is metered.
//  - overrides: { source, from, to, billing }, written by a restate. Inside its range an override wins over the
//    entries, and a later override wins over an earlier one.
//  - lostBefore: the day the history was found lost (no good copy left while the ledger already had data). Days
//    before it are billed as metered and marked assumed until a restate says otherwise.
const fs = require('fs');
const path = require('path');
const { isDay } = require('./days');
const { SOURCES, LIMITS } = require('./rules');
const { writePrivate } = require('./files');

const METERED = Object.freeze({ mode: 'metered' });
const ASSUMED = Object.freeze({ mode: 'metered', assumed: true });
const LOST = 'history lost: past days are billed as metered until restated';
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
const order = (a, b) =>
  SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0);
const copy = (v) => JSON.parse(JSON.stringify(v));

// A history file's content, whole or not at all: one unusable entry makes the file unusable (it is then recovered
// from the last good copy), so a save never drops what it could not read.
function parse(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || !Array.isArray(raw.entries)) return null;
  if (raw.overrides !== undefined && !Array.isArray(raw.overrides)) return null;
  if (raw.lostBefore != null && !isDay(raw.lostBefore)) return null;
  const entries = raw.entries.map(entryOf);
  const overrides = (raw.overrides || []).map(overrideOf);
  if (entries.some((e) => !e) || overrides.some((o) => !o)) return null;
  return { entries: entries.sort(order), overrides, lostBefore: raw.lostBefore || null };
}

function unreadError(cause) {
  const e = new Error('the billing history could not be read');
  e.code = 'BILLING_UNREAD';
  if (cause && typeof cause.code === 'string') e.reason = cause.code;
  return e;
}

// `earlierData()` tells whether the ledger already holds data from earlier passes: with no good copy of the history
// left, that means the history was lost, not that this is the first run.
function createBillingHistory({ dir = null, earlierData = () => false } = {}) {
  const file = dir && path.join(dir, 'billing.json');
  const bak = file && `${file}.bak`;
  let entries = []; // sorted by source, then from
  let overrides = []; // in the order they were added
  let lostBefore = null;
  let lost = false; // lost, and not yet dated (the first save dates it today)
  let saved = !dir; // the history is on disk (or kept in memory only)
  let failure = null; // a read error: the history is unavailable and nothing is written
  const problems = [];

  const read = (f) => {
    try {
      return { text: fs.readFileSync(f, 'utf8') };
    } catch (e) {
      if (e.code === 'ENOENT') return { missing: true };
      return { error: e };
    }
  };
  const setAside = (f) => {
    let bad = `${f}.bad`;
    for (let n = 1; fs.existsSync(bad); n++) bad = `${f}.bad.${n}`;
    try {
      fs.renameSync(f, bad);
    } catch {
      /* best effort: the next save replaces it */
    }
  };
  const use = (h) => {
    entries = h.entries;
    overrides = h.overrides;
    lostBefore = h.lostBefore;
    lost = false;
  };
  const save = (h) => {
    if (!file) return;
    const text = JSON.stringify({ version: 1, entries: h.entries, overrides: h.overrides, lostBefore: h.lostBefore });
    writePrivate(file, text);
    writePrivate(bak, text); // after the file: a crash between the two leaves a good file, and an older good copy
    saved = true;
  };

  function load() {
    if (!file) return;
    const main = read(file);
    if (main.error) {
      failure = main.error;
      return;
    }
    failure = null;
    const h = main.text !== undefined ? parse(main.text) : null;
    if (h) {
      use(h);
      saved = true;
      return;
    }
    if (main.text !== undefined) setAside(file);
    const last = read(bak);
    if (last.error) {
      failure = last.error; // the last good copy may be fine: wait for it
      return;
    }
    const good = last.text !== undefined ? parse(last.text) : null;
    if (good) {
      use(good);
      const how = main.text !== undefined ? 'damaged' : 'missing';
      problems.push(`the billing history was ${how} and was recovered from its last good copy`);
      try {
        save(good);
      } catch {
        saved = false; // the next save writes it
      }
      return;
    }
    if (main.text !== undefined) problems.push('the billing history was damaged and kept aside');
    // No good copy. On a true first run the history simply starts; otherwise it was lost.
    entries = [];
    overrides = [];
    lostBefore = null;
    lost = earlierData();
    saved = false;
  }
  load();

  const ready = () => {
    if (failure) load();
    if (failure) throw unreadError(failure);
  };

  // Writes the history when it is not on disk yet, so a later start can tell a first run from a lost history. A lost
  // history is dated here: days before `today` are billed as assumed.
  function ensure(today) {
    ready();
    if (saved && !lost) return;
    const h = { entries, overrides, lostBefore: lost ? today : lostBefore };
    save(h);
    lostBefore = h.lostBefore;
    lost = false;
  }

  // Compares the current billing settings with each source's newest entry. `firstUse(source)` gives the day a source
  // without any entry was first used (its billing then applies from that day: the first-run backfill), or undefined
  // to leave that source for a later call; without `firstUse` such sources are left alone. After a lost history a
  // source with no entry starts today: its first day of use would re-bill closed days. Returns whether it changed.
  function observe(settings, today, { firstUse = null } = {}) {
    ensure(today);
    const next = entries.map((e) => ({ ...e }));
    let changed = false;
    for (const source of SOURCES) {
      const cur = normalize(isObj(settings) ? settings[source] : null) || { ...METERED };
      const mine = next.filter((e) => e.source === source);
      if (!mine.length) {
        if (!firstUse) continue;
        const day = lostBefore ? today : firstUse(source);
        if (day === undefined) continue;
        next.push({ source, from: isDay(day) && day < today ? day : today, billing: cur });
        changed = true;
        continue;
      }
      const last = mine[mine.length - 1];
      if (same(last.billing, cur)) continue;
      // The newest of a day wins. A clock that went back changes nothing: an entry is never dated before the previous
      // one, and a past entry is never rewritten; the change is recorded once the clock reaches it again.
      if (last.from > today) continue;
      if (last.from === today) last.billing = cur;
      else next.push({ source, from: today, billing: cur });
      changed = true;
    }
    if (!changed) return false;
    next.sort(order);
    save({ entries: next, overrides, lostBefore });
    entries = next;
    return true;
  }

  // The billing in force for `source` on `day`; `assumed` when the history was lost for that day. While the history
  // does not read this is metered, and the caller's status says so.
  function billingFor(source, day) {
    for (let i = overrides.length - 1; i >= 0; i--) {
      const o = overrides[i];
      if (o.source === source && o.from <= day && day <= o.to) return o.billing;
    }
    if (lost || (lostBefore && day < lostBefore)) return ASSUMED;
    let hit = null;
    for (const e of entries) if (e.source === source && e.from <= day) hit = e.billing;
    return hit || METERED;
  }

  function addOverride(o) {
    const x = overrideOf(o);
    if (!x) throw new TypeError('not a valid billing override');
    ready();
    const next = [...overrides, x];
    save({ entries, overrides: next, lostBefore });
    overrides = next;
    return copy(x);
  }

  // Demo: entries held in memory.
  function seed(list) {
    entries = (list || []).map(entryOf).filter(Boolean).sort(order);
  }

  return {
    ensure,
    observe,
    billingFor,
    addOverride,
    seed,
    has: (source) => entries.some((e) => e.source === source),
    list: () => ({ entries: copy(entries), overrides: copy(overrides), lostBefore }),
    problems: () => [...problems, ...(lost || lostBefore ? [LOST] : [])],
    lost: () => lost || !!lostBefore,
    error: () => (failure ? unreadError(failure) : null),
  };
}

module.exports = { createBillingHistory, normalizeBilling: normalize, LOST };
