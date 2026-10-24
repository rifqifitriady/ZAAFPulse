// Cost Control, sub-project 1: the cost ledger. After each index refresh `update()` reads what is new in every source,
// prices it with the version of its day, attributes it to a cost center and stores daily rows (lib/cost/ledger.js).
// Today stays open: its rows follow new events, the current prices and the current rules. A past day is closed: it
// only grows by late events, priced with that day's version, and changes otherwise only through a restate.
// Rows carry list cost only: what was billed is derived when the ledger is read, from the billing history
// (lib/cost/billing.js, lib/cost/billing-view.js), so the pass never decides a bill or writes a plan row.
//
// Fail closed: each step of a pass (a collector, the plan step, the retag) works on a staging layer over the store and
// is applied whole or not at all. A step that needs a month the store could not read stops before it changes anything,
// its cursor stays where it was, and the next pass reads the same lines again: the logs keep the data, so nothing is
// lost and nothing is counted twice.
const fs = require('fs');
const path = require('path');
const { normalizeModel } = require('../pricing');
const { dayOf, isDay } = require('./days');
const { settingsOf, compile, rateFor } = require('./rules');
const { createPriceVersions } = require('./prices');
const { createBillingHistory } = require('./billing');
const { billedRows } = require('./billing-view');
const { localEvents, gatewayEvent, judgeEvent, judgeLine, priceEvent, readNew } = require('./collect');
const L = require('./ledger');
const { writePrivate, appendPrivate, readJson } = require('./files');

const LOCAL = new Set(['claude', 'codex']);
const COLLECTORS = {
  local: { sources: ['claude', 'codex'], label: 'the log index' },
  gateway: { sources: ['gateway', 'replay', 'collab', 'judge'], label: 'the gateway log' },
  judge: { sources: ['judge'], label: 'the judge call log' },
};
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const storeCode = (e) => !!e && [L.UNREAD, L.CORRECTIONS_UNREAD, 'BILLING_UNREAD'].includes(e.code);
// A fixed phrase and the error code: never a path. The store's own errors are path-free phrases already (a month id at
// most), with the OS code in `reason`.
const failure = (what, e) =>
  storeCode(e)
    ? `${e.message}${typeof e.reason === 'string' ? ` (${e.reason})` : ''}`
    : `${what}${e && typeof e.code === 'string' ? ` (${e.code})` : ''}`;

// Writes for one step, read through to the store. A put or remove asks the store for its row first, so a month that is
// unavailable throws here, before anything is applied; commit() then cannot meet one (availability only changes in
// load() and flush()).
function staging(store) {
  const days = new Map(); // day -> Map(rowKey -> { row, gone })
  const at = (day) => {
    if (!days.has(day)) days.set(day, new Map());
    return days.get(day);
  };
  const staged = (d) => {
    const m = days.get(d.day);
    return m && m.get(L.rowKey(d));
  };
  return {
    get(d) {
      const s = staged(d);
      if (s) return s.gone ? null : L.cloneRow(s.row);
      return store.get(d);
    },
    put(r) {
      store.get(r);
      at(r.day).set(L.rowKey(r), { row: L.cloneRow(r), gone: false });
    },
    remove(r) {
      store.get(r);
      at(r.day).set(L.rowKey(r), { row: L.cloneRow(r), gone: true });
    },
    day(day) {
      const out = new Map(store.day(day).map((r) => [L.rowKey(r), r]));
      for (const [k, s] of days.get(day) || []) {
        if (s.gone) out.delete(k);
        else out.set(k, L.cloneRow(s.row));
      }
      return [...out.values()];
    },
    earliestDay(source) {
      let first = store.earliestDay(source);
      for (const [day, m] of days)
        for (const s of m.values())
          if (!s.gone && s.row.source === source && s.row.kind !== 'plan' && (!first || day < first)) first = day;
      return first;
    },
    commit() {
      for (const m of days.values())
        for (const s of m.values()) {
          if (s.gone) store.remove(s.row);
          else store.put(s.row);
        }
    },
  };
}

function createCost({
  dir = null,
  gatewayLog = null,
  entries = () => [],
  getPricing = () => ({}),
  getSettings = () => undefined,
  isPrivate = () => false,
  home = '',
  now = Date.now,
  nocase,
  demo = null,
} = {}) {
  const store = L.createLedgerStore({ dir });
  const prices = createPriceVersions({ dir: dir && path.join(dir, 'prices'), now });
  const cursorFile = dir && path.join(dir, 'cursors.json');
  const judgeFile = dir && path.join(dir, 'judge-calls.jsonl');
  let cursors = (cursorFile && readJson(cursorFile, null)) || {};
  if (!isObj(cursors)) cursors = {};
  const status = Object.fromEntries(
    Object.keys(COLLECTORS).map((k) => [
      k,
      // `total` and `skippedLocalClients` count from `since`, this process's start: they are not kept across restarts.
      {
        at: (isObj(cursors[k]) && cursors[k].at) || null,
        read: 0,
        total: 0,
        error: null,
        skippedLocalClients: 0,
        since: now(),
      },
    ]),
  );
  let storeError = null;
  let billingError = null; // the billing history could not be read or written
  let retagError = null; // the retag stopped
  let settingsError = null;
  let seenFiles = new Map(); // indexed file -> `${mtimeMs}:${size}` at the last local pass that was applied
  let localVersion = null; // the price version today's local rows were last built with
  const sticky = new Map(); // day -> Map(baseKey -> center), rebuilt each pass

  try {
    store.load();
  } catch (e) {
    storeError = failure('the ledger could not be read', e);
  }
  // Earlier passes left data: without a good copy of the billing history that history was lost (its closed days are
  // then billed as metered, marked assumed), never a first run (which would re-bill them from the current settings).
  const earlierData = () =>
    (!!cursorFile && fs.existsSync(cursorFile)) ||
    (!!dir && fs.existsSync(path.join(dir, 'prices'))) ||
    store.unread().length > 0 ||
    store.all().some((r) => r.kind !== 'plan');
  const billing = createBillingHistory({ dir, earlierData });
  if (demo) {
    prices.seed(demo.versions);
    for (const r of demo.rows) store.put(r);
    cursors.firstDay = demo.firstDay;
    for (const [k, v] of Object.entries(demo.collectors || {})) Object.assign(status[k], v);
    // The demo's billing: its own history, else its settings from each source's first demo day.
    if (Array.isArray(demo.billing)) billing.seed(demo.billing);
    else {
      const b = (isObj(demo.settings) && isObj(demo.settings.billing) && demo.settings.billing) || {};
      const first = (source) =>
        store
          .all()
          .filter((r) => r.source === source && r.kind !== 'plan')
          .reduce((a, r) => (!a || r.day < a ? r.day : a), null) || demo.firstDay;
      billing.seed(Object.entries(b).map(([source, x]) => ({ source, from: first(source), billing: x })));
    }
  }

  function settingsNow() {
    const s = settingsOf(getSettings(), { home });
    settingsError = s.error;
    return { value: s.value, rules: compile(s.value, nocase === undefined ? {} : { nocase }) };
  }
  const backfilledDay = (day) => isDay(cursors.firstDay) && day < cursors.firstDay;
  const dimsOf = (ev, day) => ({
    day,
    source: ev.source,
    provider: ev.provider,
    model: normalizeModel(ev.model) || null,
    project: ev.project,
    keyId: ev.keyId,
    agent: ev.agent,
    kind: ev.kind,
    geo: ev.geo,
    plan: null,
  });
  // Today uses the rules; a closed day keeps the center its rows already have, and a new row on it uses the rules.
  function centerFor(tx, dims, ev, today, rules) {
    if (dims.day === today) return rules.centerOf(ev);
    let m = sticky.get(dims.day);
    if (!m) {
      m = new Map();
      for (const r of tx.day(dims.day)) if (r.kind !== 'plan') m.set(L.baseKey(r), r.center);
      sticky.set(dims.day, m);
    }
    const bk = L.baseKey(dims);
    if (!m.has(bk)) m.set(bk, rules.centerOf(ev));
    return m.get(bk);
  }
  // `billedUSD` is stored as the list price (the metered bill) to keep the row format; readers derive the real bill.
  function addEvent(row, ev, version) {
    const p = priceEvent(prices.pricerFor(version.id), ev);
    row.requests += 1;
    for (const f of L.TOKENS) row.tokens[f] += ev.tokens[f] || 0;
    row.webSearches += ev.webSearches || 0;
    row.listUSD += p.listUSD;
    row.billedUSD += p.listUSD;
    row.unpriced = row.unpriced || p.unpriced;
    row.estimated = row.estimated || p.estimated;
    row.free = !!ev.free;
    row.priceVersion = version.id;
    row.backfilled = backfilledDay(row.day);
  }

  // Local logs: the days whose files changed (and all of today after a price change) are rebuilt from the deduplicated
  // events. Today is replaced; a closed day takes a rebuilt row only when it grew (logs that were deleted never shrink it).
  // The files seen and the price version are kept only when the step is applied, so a stopped step is redone in full.
  function localPass(tx, today, s) {
    const list = entries() || [];
    const days = new Set();
    const seen = new Map();
    for (const e of list) {
      const stamp = `${e.mtimeMs}:${e.size}`;
      seen.set(e.file, stamp);
      if (seenFiles.get(e.file) === stamp) continue;
      for (const x of (e.result && e.result.events) || []) if (Number.isFinite(x[0])) days.add(dayOf(x[0]));
    }
    const todayVersion = prices.versionFor(today);
    if (todayVersion.id !== localVersion) days.add(today);
    const apply = () => {
      seenFiles = seen;
      localVersion = todayVersion.id;
    };
    if (!days.size) return { read: 0, apply };
    const byDay = new Map();
    for (const ev of localEvents(list.map((e) => e.result), { home })) {
      const day = dayOf(ev.ts);
      if (!days.has(day)) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(ev);
    }
    let read = 0;
    for (const day of days) {
      const version = prices.versionFor(day);
      const computed = new Map();
      for (const ev of byDay.get(day) || []) {
        const dims = dimsOf(ev, day);
        dims.center = centerFor(tx, dims, ev, today, s.rules);
        const k = L.rowKey(dims);
        if (!computed.has(k)) computed.set(k, L.newRow(dims));
        addEvent(computed.get(k), ev, version);
        read++;
      }
      if (day === today) {
        // Usage rows only: a stored plan row (an older format) is left for the readers, which ignore it.
        for (const r of tx.day(day)) if (LOCAL.has(r.source) && r.kind !== 'plan') tx.remove(r);
        for (const r of computed.values()) tx.put(r);
        continue;
      }
      for (const r of computed.values()) {
        const have = tx.get(r);
        if (!have || r.requests > have.requests || L.tokenTotal(r) > L.tokenTotal(have)) tx.put(r);
      }
    }
    return { read, apply };
  }

  // An append-only log read from its cursor. The rows and the new cursor are applied together, or neither is.
  function additivePass(tx, name, file, toEvent, today, s) {
    if (!file) return { read: 0 };
    const got = readNew(file, cursors[name]);
    const staged = new Map();
    let read = 0;
    for (const raw of got.rows) {
      const ev = toEvent(raw);
      if (!ev) continue;
      const day = dayOf(ev.ts);
      const dims = dimsOf(ev, day);
      dims.center = centerFor(tx, dims, ev, today, s.rules);
      const k = L.rowKey(dims);
      if (!staged.has(k)) staged.set(k, tx.get(dims) || L.newRow(dims));
      addEvent(staged.get(k), ev, prices.versionFor(day));
      read++;
    }
    for (const row of staged.values()) tx.put(row);
    return { read, cursor: { ...got.cursor } };
  }

  // Today follows the current rules, whichever pass wrote its rows. Rows that come to share a key are merged before
  // anything is written, so no merged row is removed again later in the same loop.
  function retagToday(tx, today, s) {
    const rows = tx.day(today).filter((r) => r.kind !== 'plan');
    const out = new Map();
    let changed = false;
    for (const r of rows) {
      const center = s.rules.centerOf(r);
      if (center !== r.center) changed = true;
      const next = { ...r, center };
      const k = L.rowKey(next);
      out.set(k, out.has(k) ? L.mergeRows(out.get(k), next) : next);
    }
    if (!changed) return;
    for (const r of rows) tx.remove(r);
    for (const r of out.values()) tx.put(r);
  }

  // The billing history follows the settings: a change starts a new entry dated today. A source with no entry yet
  // (the first run) takes the current billing from its first day of use, once every collector that reads it has read
  // in full this pass; until then it is metered, and the readers re-bill it once it is recorded.
  const owners = (source) => Object.keys(COLLECTORS).filter((k) => COLLECTORS[k].sources.includes(source));
  // While the saved settings are invalid the defaults apply to attribution, but the billing history is not rewritten
  // from them: a hand edit with a typo must not record every source as metered for good. An earlier billing error
  // stays shown meanwhile: nothing has been written since, so it still holds.
  function observeBilling(today, s, firstUse) {
    if (settingsError) return;
    try {
      billing.observe(s.value.billing, today, { firstUse });
      billingError = null;
    } catch (e) {
      billingError = failure('the billing history could not be written', e);
    }
  }
  function firstUseAfterPass(source) {
    if (!owners(source).every((k) => status[k].error === null)) return undefined;
    try {
      return store.earliestDay(source);
    } catch (e) {
      if (e.code === L.UNREAD) return undefined; // a month that could hold an earlier day did not read
      throw e;
    }
  }

  // One step on its own staging layer: applied whole when it returns, dropped whole when it throws.
  function step(fn) {
    const tx = staging(store);
    try {
      const out = fn(tx);
      tx.commit();
      return out;
    } catch (e) {
      sticky.clear(); // centers looked up through the dropped layer
      throw e;
    }
  }

  function run(name, fn) {
    const st = status[name];
    const counts = { skippedLocalClients: 0 };
    try {
      const out = step((tx) => fn(tx, counts));
      if (out.apply) out.apply();
      st.at = now();
      st.read = out.read;
      st.total += out.read;
      st.skippedLocalClients += counts.skippedLocalClients;
      st.error = null;
      cursors[name] = { ...(out.cursor || (isObj(cursors[name]) ? cursors[name] : {})), at: st.at };
    } catch (e) {
      st.error = failure(`${COLLECTORS[name].label} could not be read`, e);
    }
  }

  function save() {
    let rowsWritten = true;
    try {
      store.flush();
      storeError = null;
    } catch (e) {
      storeError = failure('the ledger could not be written', e);
      // flush() writes every readable month before it throws for an unread one, and no step puts to an unread month,
      // so every row this pass applied is on disk then: the cursors may follow. After any other failure they may not
      // (months written before it keep this pass's rows: like the crash window of decision 4, a restart then may read
      // those lines again).
      rowsWritten = e.code === L.UNREAD;
    }
    if (!rowsWritten || !cursorFile) return;
    try {
      // After the rows: a crash between the two writes can only make the next pass read those lines again.
      writePrivate(cursorFile, JSON.stringify({ ...cursors, version: 1 }));
    } catch (e) {
      storeError = storeError || failure('the ledger could not be written', e);
    }
  }

  function update() {
    if (demo) return statusOf();
    const today = dayOf(now());
    const s = settingsNow();
    // Before anything else is written, so a later start can tell this first run from a lost history.
    try {
      billing.ensure(today);
    } catch (e) {
      billingError = failure('the billing history could not be written', e);
    }
    try {
      prices.observe(getPricing() || {}, today);
    } catch (e) {
      storeError = failure('the price versions could not be written', e);
      return statusOf();
    }
    // A month (or the corrections) that did not read: try again before the steps need it. flush() is the store's retry,
    // and also writes what an earlier failed write left in memory.
    if (store.unread().length) {
      try {
        store.flush();
      } catch {
        /* still unavailable: the steps that need it stop, and save() reports it */
      }
    }
    if (!isDay(cursors.firstDay)) cursors.firstDay = today;
    sticky.clear();
    retagError = null;
    run('local', (tx) => localPass(tx, today, s));
    run('gateway', (tx, counts) =>
      additivePass(tx, 'gateway', gatewayLog, (line) => gatewayEvent(line, { isPrivate, counts }), today, s),
    );
    run('judge', (tx) => additivePass(tx, 'judge', judgeFile, judgeEvent, today, s));
    observeBilling(today, s, firstUseAfterPass);
    try {
      step((tx) => retagToday(tx, today, s));
    } catch (e) {
      retagError = failure("today's rows could not be re-attributed", e);
    }
    save();
    return statusOf();
  }

  function recordJudge(call) {
    if (demo || !judgeFile) return;
    try {
      const line = judgeLine(call || {}, now());
      if (line) appendPrivate(judgeFile, JSON.stringify(line) + '\n');
    } catch {
      /* the ledger must never break judging */
    }
  }

  function statusOf() {
    settingsNow();
    let rows = 0;
    let requests = 0;
    let backfilled = 0;
    for (const r of store.all()) {
      if (r.kind === 'plan') continue; // an older format's stored plan row: not usage
      if (r.unpriced) {
        rows++;
        requests += r.requests;
      }
      if (r.backfilled) backfilled++;
    }
    const v = prices.current();
    return {
      demo: !!demo,
      collectors: Object.fromEntries(
        Object.entries(COLLECTORS).map(([k, c]) => [k, { sources: c.sources, ...status[k] }]),
      ),
      priceVersion: v ? { id: v.id, from: v.from, hash: v.hash } : null,
      prices: { problems: [...new Set(prices.problems())] },
      unpriced: { rows, requests },
      backfill: { firstDay: isDay(cursors.firstDay) ? cursors.firstDay : null, rows: backfilled },
      settings: { error: settingsError },
      billing: {
        error: billingError || (billing.error() && failure('', billing.error())),
        historyLost: billing.lost(),
        problems: billing.problems(),
      },
      // `unread` names what the counts above and every ledger answer leave out: months, 'folder', 'corrections'.
      ledger: {
        badLines: store.badLines(),
        corrections: store.corrections().length,
        error: storeError || retagError,
        unread: store.unread(),
      },
    };
  }

  function ledger({ from, to, groupBy = ['day'], currency = null }) {
    const s = settingsNow();
    const rateOf = currency ? (day) => rateFor(s.value.currency, day) : null;
    const rows = billedRows(store.view(from, to), {
      from,
      to,
      today: dayOf(now()),
      billingFor: billing.billingFor,
      backfilled: backfilledDay,
    });
    const g = L.groupRows(rows, { groupBy, rateOf });
    return {
      from,
      to,
      groupBy,
      currency: currency || 'USD',
      rows: g.rows,
      totals: g.totals,
      missingRate: g.missingRate,
      corrections: store.corrections().filter((c) => c.from <= to && c.to >= from).length,
      unread: [...g.unread],
      // Billing is metered while its history does not read, and assumed (rows marked billingAssumed) where it was lost.
      billing: {
        error: billing.error() ? failure('', billing.error()) : null,
        historyLost: billing.lost(),
      },
    };
  }

  // After a settings save: today's rows take the new centers, and a billing change is recorded at once (dated today),
  // so a day is never billed under settings it did not have, whether or not a pass runs before midnight.
  function retag() {
    const today = dayOf(now());
    const s = settingsNow();
    // A source with no entry waits for the next pass (its first day of use), except in the demo, where no pass runs.
    observeBilling(today, s, demo ? () => today : null);
    try {
      step((tx) => retagToday(tx, today, s));
      retagError = null;
    } catch (e) {
      retagError = failure("today's rows could not be re-attributed", e);
    }
    save();
  }

  const versions = () => {
    const v = prices.current();
    return {
      current: v ? v.id : null,
      versions: prices
        .list()
        .map(({ id, from, at, hash, changed, changedCount }) => ({ id, from, at, hash, changed, changedCount })),
    };
  };

  // The billing history, and a restate of a range's billing (Task 7): { source, from, to, billing }.
  const billingHistory = () => billing.list();
  const addBillingOverride = (o) => billing.addOverride(o);

  return { update, recordJudge, ledger, status: statusOf, versions, retag, billingHistory, addBillingOverride };
}

module.exports = { createCost };
