// Cost Control, sub-project 1: the cost ledger. After each index refresh `update()` reads what is new in every source,
// prices it with the version of its day, attributes it to a cost center and stores daily rows (lib/cost/ledger.js).
// Today stays open: its rows follow new events, the current prices and the current rules. A past day is closed: it
// only grows by late events, priced with that day's version, and changes otherwise only through a restate.
//
// Fail closed: each step of a pass (a collector, the plan step, the retag) works on a staging layer over the store and
// is applied whole or not at all. A step that needs a month the store could not read stops before it changes anything,
// its cursor stays where it was, and the next pass reads the same lines again: the logs keep the data, so nothing is
// lost and nothing is counted twice.
const path = require('path');
const { normalizeModel } = require('../pricing');
const { dayOf, addDays, daysBetween, isDay } = require('./days');
const { SOURCES, settingsOf, compile, rateFor } = require('./rules');
const { createPriceVersions } = require('./prices');
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
const storeCode = (e) => !!e && (e.code === L.UNREAD || e.code === L.CORRECTIONS_UNREAD);
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
  let planError = null; // the plan step stopped (an unread month, most likely)
  let retagError = null; // the retag stopped
  let passPlans = {}; // source -> the last day a pass saw it (cursors.plans as this pass started)
  let settingsError = null;
  let seenFiles = new Map(); // indexed file -> `${mtimeMs}:${size}` at the last local pass that was applied
  let localVersion = null; // the price version today's local rows were last built with
  const sticky = new Map(); // day -> Map(baseKey -> center), rebuilt each pass

  try {
    store.load();
  } catch (e) {
    storeError = failure('the ledger could not be read', e);
  }
  if (demo) {
    prices.seed(demo.versions);
    for (const r of demo.rows) store.put(r);
    cursors.firstDay = demo.firstDay;
    for (const [k, v] of Object.entries(demo.collectors || {})) Object.assign(status[k], v);
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
  const lastSeen = (source) =>
    isObj(passPlans[source]) && isDay(passPlans[source].lastDay) ? passPlans[source].lastDay : null;
  // Today and backfilled days use the current billing, and so do the days the server was off (after the last day a pass
  // saw the source): the plan step fills those with the current plan, so their usage must not be billed as well. Any
  // other closed day keeps its mode (a plan row says it was on a plan). Taken from the plan cursor as the pass started,
  // so the mode does not depend on whether the plan step could write.
  function billingFor(tx, day, source, today, rules) {
    const last = lastSeen(source);
    if (day === today || backfilledDay(day) || (last && day > last)) return rules.billingOf(source);
    return tx.day(day).some((r) => r.kind === 'plan' && r.source === source) ? { mode: 'plan' } : { mode: 'metered' };
  }
  function addEvent(row, ev, version, billing) {
    const p = priceEvent(prices.pricerFor(version.id), ev);
    row.requests += 1;
    for (const f of L.TOKENS) row.tokens[f] += ev.tokens[f] || 0;
    row.webSearches += ev.webSearches || 0;
    row.listUSD += p.listUSD;
    row.billedUSD += billing.mode === 'plan' ? 0 : p.listUSD;
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
        addEvent(computed.get(k), ev, version, billingFor(tx, day, ev.source, today, s.rules));
        read++;
      }
      if (day === today) {
        // Usage rows only: the plan rows belong to the plan step, which may already have run this pass.
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
      addEvent(staged.get(k), ev, prices.versionFor(day), billingFor(tx, day, ev.source, today, s.rules));
      read++;
    }
    for (const row of staged.values()) tx.put(row);
    return { read, cursor: { ...got.cursor } };
  }

  // For the given sources (R12). Days the server was off get the current plan; a source no pass has seen yet starts
  // from its first day in the ledger, so that step runs after the local collector (first-run backfill, decision 9).
  function planPass(tx, today, s, sources) {
    const plans = isObj(cursors.plans) ? { ...cursors.plans } : {};
    for (const source of sources) {
      const b = s.rules.billingOf(source);
      const last = isObj(plans[source]) && isDay(plans[source].lastDay) ? plans[source].lastDay : null;
      if (b.mode === 'plan') {
        const start = last ? addDays(last, 1) : tx.earliestDay(source) || today;
        for (const day of daysBetween(start < today ? start : today, today)) {
          const have = tx.day(day).filter((r) => r.kind === 'plan' && r.source === source);
          if (day !== today && have.length) continue;
          for (const r of have) tx.remove(r);
          tx.put(L.planRow(day, source, b, backfilledDay(day)));
        }
      } else for (const r of tx.day(today)) if (r.kind === 'plan' && r.source === source) tx.remove(r);
      plans[source] = { lastDay: today };
    }
    return () => {
      cursors.plans = plans;
    };
  }

  // Today follows the current rules and billing modes, whichever pass wrote its rows. Rows that come to share a key are
  // merged before anything is written, so no merged row is removed again later in the same loop.
  function retagToday(tx, today, s) {
    const rows = tx.day(today).filter((r) => r.kind !== 'plan');
    const out = new Map();
    let changed = false;
    for (const r of rows) {
      const center = s.rules.centerOf(r);
      const billedUSD = s.rules.billingOf(r.source).mode === 'plan' ? 0 : r.listUSD;
      if (center !== r.center || billedUSD !== r.billedUSD) changed = true;
      const next = { ...r, center, billedUSD };
      const k = L.rowKey(next);
      out.set(k, out.has(k) ? L.mergeRows(out.get(k), next) : next);
    }
    if (!changed) return;
    for (const r of rows) tx.remove(r);
    for (const r of out.values()) tx.put(r);
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
    planError = null;
    retagError = null;
    passPlans = isObj(cursors.plans) ? { ...cursors.plans } : {};
    // The plan step first, for every source a pass has seen: each day's billing is settled before a collector writes
    // usage on it. Sources seen for the first time wait for the local collector (their first day of use).
    const seen = SOURCES.filter(lastSeen);
    const plan = (sources) => {
      try {
        step((tx) => planPass(tx, today, s, sources))();
      } catch (e) {
        planError = planError || failure('the plan fees could not be added', e);
      }
    };
    plan(seen);
    run('local', (tx) => localPass(tx, today, s));
    run('gateway', (tx, counts) =>
      additivePass(tx, 'gateway', gatewayLog, (line) => gatewayEvent(line, { isPrivate, counts }), today, s),
    );
    run('judge', (tx) => additivePass(tx, 'judge', judgeFile, judgeEvent, today, s));
    // A source on a plan that is new to the ledger waits while the local collector failed: its first day of use is
    // not known yet, and settling it now would lose the backfill of its plan rows.
    const localOk = status.local.error === null;
    plan(SOURCES.filter((x) => !lastSeen(x) && (localOk || s.rules.billingOf(x).mode !== 'plan')));
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
      // `unread` names what the counts above and every ledger answer leave out: months, 'folder', 'corrections'.
      ledger: {
        badLines: store.badLines(),
        corrections: store.corrections().length,
        error: storeError || planError || retagError,
        unread: store.unread(),
      },
    };
  }

  function ledger({ from, to, groupBy = ['day'], currency = null }) {
    const s = settingsNow();
    const rateOf = currency ? (day) => rateFor(s.value.currency, day) : null;
    const g = L.groupRows(store.view(from, to), { groupBy, rateOf });
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
    };
  }

  function retag() {
    try {
      step((tx) => retagToday(tx, dayOf(now()), settingsNow()));
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

  return { update, recordJudge, ledger, status: statusOf, versions, retag };
}

module.exports = { createCost };
