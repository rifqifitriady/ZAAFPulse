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
const { normalizeModel, makePricer } = require('../pricing');
const { dayOf, isDay } = require('./days');
const { SOURCES, settingsOf, compile, rateFor, planFee } = require('./rules');
const { createPriceVersions } = require('./prices');
const { createBillingHistory } = require('./billing');
const { billedRows } = require('./billing-view');
const { localEvents, gatewayEvent, judgeEvent, judgeLine, priceEvent, readNew } = require('./collect');
const L = require('./ledger');
const { writePrivate, appendPrivate, setAside } = require('./files');

const LOCAL = new Set(['claude', 'codex']);
const COLLECTORS = {
  local: { sources: ['claude', 'codex'], label: 'the log index' },
  gateway: { sources: ['gateway', 'replay', 'collab', 'judge'], label: 'the gateway log' },
  judge: { sources: ['judge'], label: 'the judge call log' },
};
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_REASON = 200;
const MAX_RESTATES = 100; // the history the Settings page lists
// No good copy of the log positions on a later run: reading the gateway and judge logs from 0 would count every line
// still in them a second time, so they wait for a rebuild by hand (docs/cost.md). Path-free.
const CURSORS_LOST = 'cursor state lost: gateway and judge lines are paused; see docs/cost.md (rebuild)';

// The log positions as saved: an object of version 1 whose cursors are objects with a whole offset. Anything else
// (an empty or torn file after a crash, a hand edit) does not count as a copy.
function parseCursors(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v) || v.version !== 1) return null;
  for (const k of Object.keys(COLLECTORS)) {
    if (v[k] === undefined) continue;
    if (!isObj(v[k])) return null;
    if (v[k].offset !== undefined && !(Number.isSafeInteger(v[k].offset) && v[k].offset >= 0)) return null;
  }
  return v;
}
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
  const cursorBak = cursorFile && `${cursorFile}.bak`;
  const judgeFile = dir && path.join(dir, 'judge-calls.jsonl');
  let storeError = null;
  let billingError = null; // the billing history could not be read or written
  let retagError = null; // the retag stopped
  let settingsError = null;
  let seenFiles = new Map(); // indexed file -> `${mtimeMs}:${size}` at the last local pass that was applied
  let localVersion = null; // the price version today's local rows were last built with
  const sticky = new Map(); // day -> Map(baseKey -> center), rebuilt each pass
  // Gateway steps applied since start: the budget service drops the calls a pass read (lib/cost/budget-service.js), so
  // every update() runs inside its pass().
  let gatewayPasses = 0;

  try {
    store.load();
  } catch (e) {
    storeError = failure('the ledger could not be read', e);
  }
  let cursorsSeen = false; // cursors.json or its last good copy was there at a load: a pass saved before
  // Earlier passes left data: without a good copy of the billing history that history was lost (its closed days are
  // then billed as metered, marked assumed), never a first run (which would re-bill them from the current settings).
  const earlierData = () =>
    cursorsSeen ||
    (!!cursorFile && fs.existsSync(cursorFile)) ||
    (!!dir && fs.existsSync(path.join(dir, 'prices'))) ||
    store.unread().length > 0 ||
    store.all().some((r) => r.kind !== 'plan');

  // The log positions, like the billing history: cursors.json, else its last good copy cursors.json.bak (written
  // after each save). A file that does not parse is kept aside. With no good copy on a later run (the billing
  // history's test, or a billing history on disk) the positions are lost: `cursorsLost` pauses the gateway and judge
  // steps and nothing is saved over them, so a restart stays paused instead of reading the logs from 0. A read error
  // (not a missing file) leaves the file where it is, and the next pass tries again.
  let cursors = {};
  let cursorsLost = false;
  const cursorProblems = [];
  const readText = (f) => {
    try {
      return { text: fs.readFileSync(f, 'utf8') };
    } catch (e) {
      return e.code === 'ENOENT' ? { missing: true } : { error: e };
    }
  };
  function loadCursors() {
    cursorsLost = false;
    if (!cursorFile) return;
    const main = readText(cursorFile);
    if (!main.missing) cursorsSeen = true;
    const good = main.text !== undefined ? parseCursors(main.text) : null;
    if (good) {
      cursors = good;
      return;
    }
    if (main.text !== undefined) setAside(cursorFile);
    const last = readText(cursorBak);
    if (!last.missing) cursorsSeen = true;
    const copy = last.text !== undefined ? parseCursors(last.text) : null;
    if (copy) {
      cursors = copy;
      const how = main.missing ? 'missing' : main.error ? 'unreadable' : 'damaged';
      cursorProblems.push(`the log positions were ${how} and were recovered from their last good copy`);
      try {
        writePrivate(cursorFile, JSON.stringify(copy));
      } catch {
        /* the next save writes it */
      }
      return;
    }
    cursors = {};
    const billingOnDisk = !!dir && ['billing.json', 'billing.json.bak'].some((f) => fs.existsSync(path.join(dir, f)));
    cursorsLost = earlierData() || billingOnDisk;
  }
  loadCursors();
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
    return {
      value: s.value,
      rules: compile(s.value, nocase === undefined ? {} : { nocase }),
      unreadable: !!s.unreadable,
    };
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
  // While the saved settings are invalid the pass waits, and the billing history is not rewritten from the defaults
  // either: a hand edit with a typo must not record every source as metered for good. An earlier billing error
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
      if (name === 'gateway') gatewayPasses++;
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
    // Lost positions are never saved over: a cursors.json without them would read the logs from 0 at the next start.
    if (!rowsWritten || !cursorFile || cursorsLost) return;
    try {
      // After the rows: a crash between the two writes can only make the next pass read those lines again. The copy
      // after the file, as for the billing history: a crash between the two leaves a good file and an older copy.
      const text = JSON.stringify({ ...cursors, version: 1 });
      writePrivate(cursorFile, text);
      writePrivate(cursorBak, text);
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
    // config.json does not parse (a hand edit, or an editor caught mid-write), or its cost section does not validate:
    // the defaults would date every plan source as metered and move today's rows to unassigned (a day that closed
    // meanwhile would keep them), so the pass waits. The logs keep the data; the first pass after the fix reads it with
    // the fixed rules, late lines on closed days included.
    if (s.unreadable || settingsError) return statusOf();
    if (cursorsLost) loadCursors(); // a copy that did not read may read now
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
    // While the positions are lost the first day is unknown too: setting it today would mark the past as backfilled.
    if (!isDay(cursors.firstDay) && !cursorsLost) cursors.firstDay = today;
    sticky.clear();
    retagError = null;
    run('local', (tx) => localPass(tx, today, s)); // rebuilt from the index: it needs no position
    if (cursorsLost) for (const k of ['gateway', 'judge']) status[k].error = CURSORS_LOST;
    else {
      run('gateway', (tx, counts) =>
        additivePass(tx, 'gateway', gatewayLog, (line) => gatewayEvent(line, { isPrivate, counts }), today, s),
      );
      run('judge', (tx) => additivePass(tx, 'judge', judgeFile, judgeEvent, today, s));
    }
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
      // The log positions: `error` while they are lost (the gateway and judge steps wait), `problems` for a recovery.
      cursors: { error: cursorsLost ? CURSORS_LOST : null, problems: [...cursorProblems] },
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
    if (s.unreadable || settingsError) return; // the settings do not read: today's rows keep their centers (see update)
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
  // The history is set up first (as the first thing a pass does), so a lost one is dated before anything is saved.
  const addBillingOverride = (o) => {
    billing.ensure(dayOf(now()));
    return billing.addOverride(o);
  };

  // The range a restate (or its preview) may cover: past days only.
  function checkRestateRange(from, to, today) {
    if (!isDay(from) || !isDay(to)) throw fail(400, 'from and to must be days (YYYY-MM-DD)');
    if (!(from <= to)) throw fail(400, 'from must be on or before to');
    // A correction moves amounts by (after - before); today's rows are rebuilt each pass, so it would count twice.
    if (to >= today) throw fail(400, 'today follows the current prices and rules already; restate up to yesterday');
  }
  // What a restate is built on must read: a month or the corrections that did not read are tried again (as a pass
  // does) before refusing, and the settings in force must validate. Returns them.
  function restateBase(from, to) {
    if (store.unread().length) {
      try {
        store.flush();
      } catch {
        /* still unavailable: assertReadable says which */
      }
    }
    store.assertReadable(from, to);
    const s = settingsNow();
    // The defaults that stand in for invalid settings would re-attribute the range to no center and re-bill every
    // source as metered for good: like observeBilling, a restate never writes billing from them.
    if (settingsError) throw fail(409, `${settingsError}: fix them before a restate`);
    return s;
  }

  // Restate a past range on purpose (R13): list cost and centers through one correction (re-priced with the current
  // prices, re-attributed with the current rules), and billing through one override per source with its current
  // billing, so the readers re-bill the whole range. Fail closed: what the restate is built on must read in full
  // (LEDGER_MONTH_UNREAD, LEDGER_CORRECTIONS_UNREAD, BILLING_UNREAD otherwise), and it throws before writing anything
  // but the billing history's own set-up.
  // The overrides are written first, as one save, and the correction last: it is the record that the restate
  // happened, so it never names overrides that were not written.
  function restate({ from, to, reason } = {}) {
    const today = dayOf(now());
    checkRestateRange(from, to, today);
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (!why || why.length > MAX_REASON) throw fail(400, `reason: 1 to ${MAX_REASON} characters`);
    const s = restateBase(from, to);
    // Before the first pass after a start the history may be lost and not yet dated: date it (BILLING_UNREAD while it
    // does not read), so the overrides are saved with the loss and days outside the range stay assumed.
    billing.ensure(today);
    const version = prices.observe(getPricing() || {}, today);
    const written = billing.addOverrides(
      SOURCES.map((source) => ({ source, from, to, billing: s.rules.billingOf(source) })),
    );
    const c = L.restate(store, {
      from,
      to,
      reason: why,
      ts: now(),
      version,
      pricer: prices.pricerFor(version.id),
      rules: s.rules,
      billing: written.map((o) => ({ source: o.source, ...o.billing })),
    });
    save();
    return c;
  }

  // What restate() would record for [from, to], computed and not written (Cost Control 3b): the same refusals, then no
  // billing set-up, no price version and no correction. `version` is null while today's prices are not a version yet
  // (`newPrices`); the rows then carry the id the restate would record, so they equal what it records. `total` counts
  // the usage rows of the range; `billing` is each source's billing the restate would set over it.
  function restatePreview({ from, to } = {}) {
    checkRestateRange(from, to, dayOf(now()));
    const s = restateBase(from, to);
    const peek = prices.peek(getPricing() || {});
    const rows = L.restateRows(store, {
      from,
      to,
      version: peek.version || { id: peek.next },
      pricer: peek.pricer,
      rules: s.rules,
    });
    const before = [...new Set(rows.map((x) => x.before.priceVersion))];
    return {
      from,
      to,
      rows,
      total: store.view(from, to).filter((r) => r.kind !== 'plan').length,
      versionsBefore: before.sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b)),
      version: peek.version ? peek.version.id : null,
      newPrices: !peek.version,
      billing: SOURCES.map((source) => ({ source, ...s.rules.billingOf(source) })),
    };
  }

  // The restates recorded, newest first, at most 100 (Cost Control 3b): what each did, its rows counted, not listed.
  // LEDGER_CORRECTIONS_UNREAD while the corrections do not read (tried again first), never an empty history.
  function corrections() {
    if (store.unread().includes('corrections')) {
      try {
        store.flush();
      } catch {
        /* a month still unread does not matter here */
      }
    }
    if (store.unread().includes('corrections'))
      throw Object.assign(new Error('the ledger corrections could not be read'), { code: L.CORRECTIONS_UNREAD });
    return store
      .corrections()
      .reverse()
      .slice(0, MAX_RESTATES)
      .map((c) => ({
        ts: c.ts,
        from: c.from,
        to: c.to,
        reason: c.reason,
        priceVersion: c.priceVersion,
        rows: c.rows.length,
        billing: Array.isArray(c.billing) ? c.billing : [],
      }));
  }

  // The rows a budget sums (lib/cost/budgets.js): the reader's view with the corrections and the billing applied, plan
  // rows included. `unread` names what the view skipped; `billingError` is set while the billing history does not
  // read (the rows are then billed as metered, which a budget on what was paid must not take for the bill).
  function budgetRows({ from, to }) {
    const rows = billedRows(store.view(from, to), {
      from,
      to,
      today: dayOf(now()),
      billingFor: billing.billingFor,
      backfilled: backfilledDay,
    });
    return {
      rows,
      unread: [...rows.unread],
      billingError: billing.error() ? 'the billing history could not be read' : null,
      // Days whose billing was lost are billed as metered (rows marked billingAssumed): the Cost Control pages say so.
      historyLost: billing.lost(),
    };
  }

  // What a row's cache reads saved against paying the input price for them, in USD, at the base rates of the row's
  // price version (the version of its day). Prompt-length tiers and US-only pricing are not applied, so the Value
  // page labels it an estimate. 0 for a row without a version, an unpriced, free or plan row, a model the version
  // does not price, or a cache read that is not cheaper than input.
  function cacheSaved(row) {
    if (!row || row.kind === 'plan' || row.free || row.unpriced || !Number.isInteger(row.priceVersion)) return 0;
    const n = row.tokens && row.tokens.cacheRead;
    if (!(typeof n === 'number' && n > 0)) return 0;
    const e = prices.pricerFor(row.priceVersion).entry(row.model);
    if (!e) return 0;
    const diff = (Number(e.input) || 0) - (Number(e.cacheRead) || 0);
    return diff > 0 ? (n * diff) / 1e6 : 0;
  }

  // One gateway log line as the row the next pass adds for it (the same collector, the price version of its day and
  // the same attribution), for the budget guard's count of the calls the ledger has not read yet. null for a line the
  // ledger does not take (a local tool's line, a failed attempt). Before the first pass there is no price version:
  // the current prices stand in; a price change is picked up when the pass retires the row. `rules` attributes the
  // call (the budget service passes the last cost settings that validated); without them the current settings do.
  function priceGatewayLine(line, { rules } = {}) {
    const ev = gatewayEvent(line, { isPrivate });
    if (!ev) return null;
    const day = dayOf(ev.ts);
    const v = prices.versionFor(day);
    const p = priceEvent(v ? prices.pricerFor(v.id) : makePricer(getPricing() || {}), ev);
    const b = billing.billingFor(ev.source, day);
    return {
      day,
      source: ev.source,
      provider: ev.provider,
      model: normalizeModel(ev.model) || null,
      project: null,
      center: (rules || settingsNow().rules).centerOf(ev),
      keyId: ev.keyId,
      agent: ev.agent,
      kind: ev.kind,
      listUSD: p.listUSD,
      billedUSD: b.mode === 'plan' ? 0 : p.listUSD,
      ...(b.assumed ? { billingAssumed: true } : {}),
    };
  }

  return {
    update,
    recordJudge,
    ledger,
    status: statusOf,
    versions,
    retag,
    billingHistory,
    addBillingOverride,
    restate,
    restatePreview,
    corrections,
    budgetRows,
    cacheSaved,
    priceGatewayLine,
    gatewayPasses: () => gatewayPasses,
    // The billing in force for a source on a day, as budgetRows bills it: for the ranking of a billed budget's pause
    // (lib/monitors/index.js). A copy of { mode, assumed }, so no caller can change the history.
    billingFor: (source, day) => {
      const b = billing.billingFor(source, day);
      return { mode: b && b.mode === 'plan' ? 'plan' : 'metered', assumed: !!(b && b.assumed === true) };
    },
    // A source's plan fee for one day in USD, as budgetRows bills it (0 while metered): what the forecast adds for each
    // day to come under "Paid" (lib/cost/forecast.js). A day to come takes the billing in force now.
    planFeeFor: (source, day) => {
      const b = billing.billingFor(source, day);
      return b && b.mode === 'plan' ? planFee(b, day) : 0;
    },
  };
}

module.exports = { createCost };
