// The budgets in force and what they spent, for the API, the Monitors engine and the gateway guard. The list is
// config.json "cost.budgets" (validated; while a hand edit does not validate or config.json does not parse, the last
// valid list stays in force, kept across restarts in budgets.last.json) plus the old settings read as budgets
// (monthlyBudgetUSD, a key's budgetUSD); a saved budget wins over the old setting of the same id. Spent is the
// ledger's (cost.budgetRows) plus the gateway calls recorded since the last pass that read the gateway log.
//
// No double count: record() runs right after the gateway appended the line (synchronously, lib/gateway/store.js),
// and a ledger pass is synchronous too, so no call is recorded while a pass reads. pass() takes the last sequence
// number before the pass; when the pass applied its gateway step (cost.gatewayPasses() went up), every call up to
// that number is in the ledger and is dropped here. A call recorded after the mark, or a pass whose gateway step
// stopped, keeps its increment until a pass reads it. So every cost.update() runs inside pass(), and a restate or a
// billing override is followed by invalidate(). Known bounds: the calls between the last pass and a shutdown count
// nowhere until the first pass after the restart reads them; a log rotated twice between passes loses a generation,
// as it does for the ledger.
//
// Attribution: while config.json does not parse or its cost section does not validate, the ledger pass waits (its rows
// keep the centers the last good settings gave them), and the last cost settings that validated (the currency, the
// centers, keyCenters and folderRules) attribute the gateway calls it has not read yet and answer keyCenter(). They are
// kept in budgets.last.json beside the list, each part written when it validates, so a restart on a broken config.json
// still knows a key's center. A first start on an invalid section with no file keeps the defaults as that context:
// what applies anyway.
const fs = require('fs');
const B = require('./budgets');
const { settingsOf, compile } = require('./rules');
const { dayOf } = require('./days');
const { writePrivate } = require('./files');

// Path-free status phrases: the list in force while config.json's does not validate or read.
const LIST_KEPT = 'budgets in config.json are invalid; the last valid list is in force';
const LIST_NONE = 'budgets in config.json are invalid and no valid list was kept; only the old settings apply';
const UNREAD_KEPT = 'config.json could not be read; the last valid budget list is in force';
const UNREAD_NONE = 'config.json could not be read and no valid budget list was kept; only the old settings apply';
const MAX_WINDOWS = 24; // cached ledger reads: three periods a day, a few days

function createBudgetService({
  getSettings = () => undefined,
  getLegacy = () => ({}),
  cost,
  home = '',
  now = Date.now,
  nocase,
  demo = null,
  lastFile = null, // <cost dir>/budgets.last.json; null keeps nothing on disk (the demo)
} = {}) {
  const NONE = {}; // no getter returns this, so the first read always validates
  let lastRaw = NONE;
  let saved = [];
  let inForce = false; // `saved` came from a list that validated (this process or budgets.last.json)
  let listError = null;
  let reasons = [];
  let keepError = null;
  let keptText = null; // what budgets.last.json holds, so it is written only when the list or the context changes
  let keptList; // the list budgets.last.json holds (the last one that validated); undefined until known
  let file; // budgets.last.json as read once at start: { budgets, settings } or null; undefined until read
  // The last cost settings that validated (from config.json, else from budgets.last.json): the display currency, the
  // centers, keyCenters and folderRules.
  let good = settingsOf(undefined).value;
  let goodFrom = 'defaults'; // 'config' | 'file' | 'defaults'
  let rules = compile(good, nocase === undefined ? {} : { nocase });
  let guardError = null;
  // { budget, reason, since }: each budget the guard lets requests through for (lib/cost/guard.js); budget null is the
  // list that did not read.
  let guardProblems = [];
  let seq = 0;
  let pending = []; // { seq, row }: gateway calls the ledger has not read yet
  const windows = new Map(); // `${from}|${to}|${today}` -> cost.budgetRows(...)

  const contextOf = (v) => ({
    currency: v.currency ? v.currency.code : null,
    centers: v.centers.map((c) => c.id),
    home,
  });

  const useGood = (v, from) => {
    good = v;
    goodFrom = from;
    rules = compile(good, nocase === undefined ? {} : { nocase });
  };

  // budgets.last.json (0600, fsync, rename) when it changed: the last list that validated and the last good settings.
  // Legacy budgets are never stored: they always come from the current old settings.
  function persist() {
    if (!lastFile) return;
    if (keptList === undefined) {
      const f = fromFile();
      keptList = f && Array.isArray(f.budgets) ? f.budgets : null;
    }
    const text = JSON.stringify({
      version: 1,
      budgets: keptList,
      context: {
        currency: good.currency,
        centers: good.centers,
        keyCenters: good.keyCenters,
        folderRules: good.folderRules,
      },
    });
    if (text === keptText) return;
    try {
      writePrivate(lastFile, text);
      keptText = text;
      keepError = null;
    } catch (e) {
      const code = e && typeof e.code === 'string' ? ` (${e.code})` : '';
      keepError = `the last valid budget list could not be kept${code}`;
    }
  }

  // A list that validated: in force, and kept.
  function keep(list) {
    saved = list;
    inForce = true;
    keptList = list;
    persist();
  }

  // budgets.last.json, read once: null when it is missing, does not parse or its settings do not validate.
  function fromFile() {
    if (file !== undefined) return file;
    file = null;
    if (!lastFile) return null;
    let v;
    try {
      keptText = fs.readFileSync(lastFile, 'utf8');
      v = JSON.parse(keptText);
    } catch {
      return null;
    }
    if (!v || typeof v !== 'object' || v.version !== 1) return null;
    const c = settingsOf(v.context && typeof v.context === 'object' ? v.context : null, { home });
    if (c.error || !v.context) return null;
    file = { budgets: v.budgets, settings: c.value };
    return file;
  }

  // The kept list after a restart, validated against the last good settings (the current ones, else the file's).
  // null when it does not validate: then only the legacy budgets apply.
  function kept() {
    const f = fromFile();
    if (!f || !Array.isArray(f.budgets)) return null;
    const r = B.validateList(f.budgets, contextOf(good));
    return r.ok ? r.value : null;
  }

  // Not valid now: the list in force stays, else the kept one is read once; the warning says which applies.
  function fallBack(whenKept, whenNone) {
    if (!inForce) {
      const k = kept();
      if (k) {
        saved = k;
        inForce = true;
      }
    }
    listError = inForce ? whenKept : whenNone;
  }

  function readSaved() {
    const raw = getSettings();
    if (raw === lastRaw) return;
    lastRaw = raw;
    const s = settingsOf(raw, { home });
    const degraded = !!s.error; // config.json does not parse, or its cost section does not validate
    if (!degraded) useGood(s.value, 'config');
    else if (goodFrom === 'defaults' && fromFile()) useGood(file.settings, 'file'); // a restart on a broken config
    if (raw === false) {
      reasons = [];
      fallBack(UNREAD_KEPT, UNREAD_NONE);
      return;
    }
    const list = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.budgets : undefined;
    if (list === undefined || list === null) {
      listError = null;
      reasons = [];
      keep([]);
      return;
    }
    const r = B.validateList(list, contextOf(good));
    if (r.ok) {
      listError = null;
      reasons = [];
      keep(r.value);
    } else {
      reasons = r.errors;
      fallBack(LIST_KEPT, LIST_NONE);
      if (!degraded) persist(); // the settings validate: kept beside the last list that did, whatever this one holds
    }
  }

  function legacy() {
    try {
      return B.legacyBudgets(getLegacy() || {});
    } catch {
      return [];
    }
  }

  function list() {
    readSaved();
    const old = legacy();
    return {
      budgets: B.effectiveBudgets(saved, old),
      saved: saved.map(B.copyBudget),
      legacy: old,
      error: listError,
      reasons: [...reasons],
      complete: listError === null,
    };
  }

  const invalidate = () => windows.clear();
  // One ledger read per period window and day, until a pass or a change invalidates it.
  function rowsFor(from, to, t) {
    const k = `${from}|${to}|${dayOf(t)}`;
    if (!windows.has(k)) {
      if (windows.size >= MAX_WINDOWS) windows.clear();
      windows.set(k, cost.budgetRows({ from, to }));
    }
    return windows.get(k);
  }

  function evaluateOne(b, t = now()) {
    readSaved();
    const p = B.periodBounds(b.period, t);
    // The demo's stand-in for an input that did not read: shown as no_data, with its reason.
    if (demo && demo.noData && Object.hasOwn(demo.noData, b.id)) return B.noDataView(b, p, demo.noData[b.id]);
    let w;
    try {
      w = rowsFor(p.from, p.to, t);
    } catch {
      return B.noDataView(b, p, 'the ledger could not be read');
    }
    return B.evaluateBudget(b, {
      rows: w.rows,
      extra: pending.map((x) => x.row),
      unread: w.unread,
      billingError: w.billingError,
      currency: good.currency,
      now: t,
    });
  }

  function evaluate() {
    const t = now();
    return list().budgets.map((b) => evaluateOne(b, t));
  }

  // Calls from before the earliest current period (the month's or the week's start) can never count again.
  function prune(t) {
    const keep = [B.periodBounds('month', t).from, B.periodBounds('week', t).from].sort()[0];
    pending = pending.filter((x) => x.row.day >= keep);
  }

  function record(e) {
    if (!cost || typeof cost.priceGatewayLine !== 'function') return;
    let row = null;
    try {
      readSaved(); // after a config change, the first call may write budgets.last.json (small, bounded)
      row = cost.priceGatewayLine(e, { rules });
    } catch {
      row = null; // a budget never fails a request
    }
    if (!row) return;
    pending.push({ seq: ++seq, row });
    prune(now());
  }

  function pass(run) {
    if (!cost || typeof cost.gatewayPasses !== 'function') return run();
    const mark = seq;
    const before = cost.gatewayPasses();
    try {
      return run();
    } finally {
      if (cost.gatewayPasses() > before) pending = pending.filter((x) => x.seq > mark);
      invalidate();
      prune(now());
    }
  }

  function monthly() {
    readSaved();
    let m;
    try {
      m = (getLegacy() || {}).monthlyBudgetUSD;
    } catch {
      m = undefined;
    }
    return B.monthlyFigure({ saved, monthlyBudgetUSD: m, currency: good.currency, now: now() });
  }

  readSaved(); // on load: a list that validates is kept at once, before any request reads it
  return {
    list,
    evaluate,
    evaluateOne,
    record,
    pass,
    invalidate,
    pendingCount: () => pending.length,
    complete: () => list().complete,
    keyCenter(keyId) {
      readSaved();
      return rules.centerOf({ keyId });
    },
    centerOfProject(project) {
      readSaved();
      return rules.centerOf({ project });
    },
    // 'plan' or 'metered' for a source on a day, null when the ledger cannot say: the engine ranks the sessions of a
    // billed budget's pause by what they were billed (nothing on a plan day).
    billingMode(source, day) {
      if (!cost || typeof cost.billingFor !== 'function') return null;
      try {
        const b = cost.billingFor(source, day);
        return b && b.mode === 'plan' ? 'plan' : 'metered';
      } catch {
        return null;
      }
    },
    monthly,
    reportGuard(message, problems = []) {
      guardError = message || null;
      guardProblems = Array.isArray(problems) ? problems.map((p) => ({ ...p })) : [];
    },
    status() {
      readSaved();
      return {
        error: listError,
        reasons: [...reasons],
        guard: guardError,
        guardProblems: guardProblems.map((p) => ({ ...p })),
        kept: keepError,
      };
    },
  };
}

module.exports = { createBudgetService, LIST_KEPT, LIST_NONE, UNREAD_KEPT, UNREAD_NONE };
