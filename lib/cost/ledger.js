// The cost ledger store: one row per day and dimension tuple in <dir>/ledger-YYYY-MM.jsonl, plus the corrections a
// restate appends to <dir>/corrections.jsonl. Rows hold numbers and names only. A month file is rewritten whole
// (temp file + rename) when one of its rows changes, and only once it has been read in full; a line that does not load
// is moved to ledger-YYYY-MM.jsonl.bad and the month still loads. Readers apply the corrections on top of the stored
// rows, which a restate never rewrites. With dir null (demo) everything stays in memory.
const fs = require('fs');
const path = require('path');
const { isDay, monthOf } = require('./days');
const { SOURCES, planFee } = require('./rules');
const { writePrivate, appendPrivate } = require('./files');

const DIMS = ['day', 'source', 'provider', 'model', 'project', 'center', 'keyId', 'agent', 'kind'];
const KEY_FIELDS = [...DIMS, 'geo', 'plan'];
const TOKENS = ['in', 'out', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];

const zeroTokens = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
const rowKey = (r) => JSON.stringify(KEY_FIELDS.map((f) => r[f] ?? null));
// The key without the cost center: a late event on a closed day finds its row by it, so the day keeps its center.
const baseKey = (r) => JSON.stringify(KEY_FIELDS.filter((f) => f !== 'center').map((f) => r[f] ?? null));
// A number or 0: rows that reach the sums from outside the store must never join a string into a count or an amount.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const tokenTotal = (r) => TOKENS.reduce((a, f) => a + num(r.tokens && r.tokens[f]), 0);

function newRow(d) {
  return {
    day: d.day,
    source: d.source,
    provider: d.provider ?? null,
    model: d.model ?? null,
    project: d.project ?? null,
    center: d.center ?? null,
    keyId: d.keyId ?? null,
    agent: d.agent ?? null,
    kind: d.kind,
    geo: d.geo ?? null,
    plan: d.plan ?? null,
    requests: 0,
    tokens: zeroTokens(),
    webSearches: 0,
    listUSD: 0,
    billedUSD: 0,
    priceVersion: null,
    unpriced: false,
    estimated: false,
    free: false,
    backfilled: false,
  };
}
const cloneRow = (r) => ({ ...r, tokens: { ...zeroTokens(), ...(r.tokens || {}) } });

// Two rows that share a key after a re-attribution become one.
function mergeRows(a, b) {
  const out = cloneRow(a);
  out.requests = num(a.requests) + num(b.requests);
  for (const f of TOKENS) out.tokens[f] = num(out.tokens[f]) + num(b.tokens && b.tokens[f]);
  out.webSearches = num(a.webSearches) + num(b.webSearches);
  out.listUSD = num(a.listUSD) + num(b.listUSD);
  out.billedUSD = num(a.billedUSD) + num(b.billedUSD);
  out.priceVersion = Math.max(a.priceVersion || 0, b.priceVersion || 0) || null;
  out.unpriced = !!(a.unpriced || b.unpriced);
  out.estimated = !!(a.estimated || b.estimated);
  out.backfilled = !!(a.backfilled || b.backfilled);
  return out;
}

// What a source on a plan paid that day: the fee spread over the period's days. It has no center.
const planRow = (day, source, billing, backfilled) => ({
  ...newRow({ day, source, kind: 'plan', plan: billing.plan }),
  billedUSD: planFee(billing, day),
  backfilled: !!backfilled,
});

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
// Missing token fields count as 0; an unknown one or a count that is not a number means the line was not ours.
const validTokens = (t) =>
  t === undefined || (isObject(t) && Object.entries(t).every(([k, v]) => TOKENS.includes(k) && isCount(v)));

// A stored row: names where names go, numbers where numbers go (a string amount would be joined, not added). With a
// month, the row must also belong to that month's file.
const validRow = (r, month) =>
  isObject(r) &&
  isDay(r.day) &&
  (month === undefined || monthOf(r.day) === month) &&
  SOURCES.includes(r.source) &&
  typeof r.kind === 'string' &&
  isCount(r.requests) &&
  (r.webSearches === undefined || isCount(r.webSearches)) &&
  validTokens(r.tokens) &&
  Number.isFinite(r.listUSD) &&
  Number.isFinite(r.billedUSD);

// One side of a corrected row: what view() reads from it. `billedUSD` is optional: a restate no longer writes it, since
// billing is derived when the ledger is read (an older correction's billed amounts are ignored there).
const validState = (s) =>
  isObject(s) &&
  Number.isFinite(s.listUSD) &&
  (s.billedUSD === undefined || Number.isFinite(s.billedUSD)) &&
  (s.priceVersion == null || Number.isFinite(s.priceVersion)) &&
  (s.center == null || typeof s.center === 'string');

// A correction is applied whole or not at all: one bad entry rejects it, so it is never half applied.
const validCorrection = (c) =>
  isObject(c) &&
  isDay(c.from) &&
  isDay(c.to) &&
  c.from <= c.to &&
  (c.billing === undefined || Array.isArray(c.billing)) &&
  Array.isArray(c.rows) &&
  c.rows.every(
    (x) =>
      isObject(x) &&
      typeof x.key === 'string' &&
      validState(x.after) &&
      (x.before == null ? validRow(x.row) && rowKey(x.row) === x.key : validState(x.before)),
  );

const LEDGER_FILE = /^ledger-(\d{4}-\d{2})\.jsonl$/;
const lines = (text) => text.split('\n').filter((l) => l.trim());
const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null; // a torn last line from a crash mid-append, or a hand edit
  }
};
// Fail closed: a month whose file was not read in full is unavailable. Writing it would overwrite the rows that were
// not read, and a row built from an empty read would replace the real one, so it is neither read nor written until a
// later load or flush reads it. Path-free and with a stable code, so a caller can stop its pass and show it as status.
const UNREAD = 'LEDGER_MONTH_UNREAD';
const CORRECTIONS_UNREAD = 'LEDGER_CORRECTIONS_UNREAD';
function unreadError(what, cause) {
  const e = new Error(
    what === 'folder' ? 'the ledger folder could not be read' : `ledger month ${what} could not be read`,
  );
  e.code = UNREAD;
  if (cause && typeof cause.code === 'string') e.reason = cause.code;
  return e;
}
function correctionsError(cause) {
  const e = new Error('the ledger corrections could not be read');
  e.code = CORRECTIONS_UNREAD;
  if (cause && typeof cause.code === 'string') e.reason = cause.code;
  return e;
}
// 'YYYY-MM' of every month from a's to b's (none for a malformed day, which would never reach the end).
function monthsBetween(a, b) {
  const out = [];
  if (!isDay(a) || !isDay(b)) return out;
  let [y, m] = monthOf(a).split('-').map(Number);
  const end = monthOf(b);
  for (let id = monthOf(a); id <= end; id = `${y}-${String(m).padStart(2, '0')}`) {
    out.push(id);
    if (++m > 12) [y, m] = [y + 1, 1];
  }
  return out;
}

// `readOnly` (the MCP reader, lib/cost/reader.js): a bad line is skipped and left where it is, and nothing is written.
function createLedgerStore({ dir = null, readOnly = false } = {}) {
  const months = new Map(); // 'YYYY-MM' -> Map(rowKey -> row), readable months only
  const dirty = new Set();
  // Until the folder has been listed (no load yet, or listing failed) every month is unavailable.
  let listed = !dir;
  const unread = new Map(); // month -> the error of its last failed read
  let listError = null;
  let correctionsRead = !dir;
  let correctionsFailure = null;
  let corrections = [];
  let bad = 0;
  const fileOf = (m) => path.join(dir, `ledger-${m}.jsonl`);
  const correctionsFile = () => path.join(dir, 'corrections.jsonl');
  const available = (m) => listed && !unread.has(m);
  // Every access to one month goes through here: an unavailable month throws instead of answering from memory.
  const monthMap = (m) => {
    if (!listed) throw unreadError('folder', listError);
    if (unread.has(m)) throw unreadError(m, unread.get(m));
    if (!months.has(m)) months.set(m, new Map());
    return months.get(m);
  };
  const writeMonth = (m) => {
    if (readOnly) throw new Error('the ledger is open read-only');
    writePrivate(fileOf(m), [...months.get(m).values()].map((r) => JSON.stringify(r) + '\n').join(''));
  };
  // What a range read skips, by name: the unavailable months in it, and 'corrections' while those did not read.
  const missingIn = (from, to) => [
    ...monthsBetween(from, to).filter((m) => !available(m)),
    ...(correctionsRead ? [] : ['corrections']),
  ];

  // Throws when the file does not read or its bad lines cannot be set aside; the month then stays unavailable.
  function readMonth(m) {
    let text = '';
    try {
      text = fs.readFileSync(fileOf(m), 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const rows = new Map();
    const badLines = [];
    for (const line of lines(text)) {
      const r = parse(line);
      if (validRow(r, m)) rows.set(rowKey(r), cloneRow(r));
      else badLines.push(line);
    }
    // Kept aside, not lost: if this append fails the month stays unavailable, so it is not rewritten without them.
    if (badLines.length && !readOnly) appendPrivate(`${fileOf(m)}.bad`, badLines.map((l) => l + '\n').join(''));
    months.set(m, rows);
    unread.delete(m);
    if (!badLines.length) return;
    bad += badLines.length;
    if (readOnly) return;
    dirty.add(m);
    // Written again at once, so a second load before the next flush does not set the same lines aside twice.
    try {
      writeMonth(m);
      dirty.delete(m);
    } catch {
      /* still dirty: the next flush writes it */
    }
  }

  function readCorrections() {
    let text = '';
    try {
      text = fs.readFileSync(correctionsFile(), 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const good = [];
    const badLines = [];
    for (const line of lines(text)) {
      const c = parse(line);
      if (validCorrection(c)) good.push({ line, c });
      else badLines.push(line);
    }
    corrections = good.map((g) => g.c);
    correctionsRead = true;
    correctionsFailure = null;
    if (!badLines.length) return;
    bad += badLines.length;
    if (readOnly) return;
    try {
      appendPrivate(`${correctionsFile()}.bad`, badLines.map((l) => l + '\n').join(''));
      writePrivate(correctionsFile(), good.map((g) => g.line + '\n').join(''));
    } catch {
      /* the lines stay where they are and are skipped again on the next load */
    }
  }

  // Reads whatever is still unavailable; a failure on one month does not stop the others.
  function catchUp() {
    if (!dir) return;
    if (!listed) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          listError = e;
          return;
        }
      }
      listed = true;
      listError = null;
      for (const name of names) {
        const m = LEDGER_FILE.exec(name);
        if (m) unread.set(m[1], null);
      }
    }
    for (const m of [...unread.keys()].sort()) {
      try {
        readMonth(m);
      } catch (e) {
        months.delete(m);
        unread.set(m, e);
      }
    }
    if (!correctionsRead) {
      try {
        readCorrections();
      } catch (e) {
        correctionsFailure = e;
      }
    }
  }

  // The first month (or the folder) still unavailable, as the error a caller sees; null when every month read.
  function monthPending() {
    if (!listed) return unreadError('folder', listError);
    const m = [...unread.keys()].sort()[0];
    return m ? unreadError(m, unread.get(m)) : null;
  }
  const pending = () => monthPending() || (correctionsRead ? null : correctionsError(correctionsFailure));

  function load() {
    months.clear();
    dirty.clear();
    corrections = [];
    bad = 0;
    if (dir) {
      listed = false;
      correctionsRead = false;
      unread.clear();
    }
    catchUp();
    const e = pending();
    if (e) throw e;
  }

  // Readable months only. `unread` names what was skipped; it is not enumerable, so the result stays a plain row list.
  const range = (from, to) => {
    const out = [];
    for (const [m, rows] of months)
      if (m >= monthOf(from) && m <= monthOf(to))
        for (const r of rows.values()) if (r.day >= from && r.day <= to) out.push(cloneRow(r));
    return Object.defineProperty(out, 'unread', { value: missingIn(from, to) });
  };

  // The rows of [from, to] as readers see them: every correction applied in the order it was made (R13). An
  // unavailable month is skipped and named in `unread`, so the other months still show.
  function view(from, to) {
    const rows = range(from, to);
    const skip = new Set(rows.unread);
    const out = new Map(rows.map((r) => [rowKey(r), { ...r, key: rowKey(r) }]));
    for (const c of corrections) {
      if (c.to < from || c.from > to) continue;
      for (const x of c.rows) {
        if (!x || typeof x.key !== 'string' || !x.after) continue;
        if (!x.before) {
          if (x.row && x.row.day >= from && x.row.day <= to && !skip.has(monthOf(x.row.day)))
            out.set(x.key, { ...cloneRow(x.row), key: x.key });
          continue;
        }
        const r = out.get(x.key);
        if (!r) continue;
        r.listUSD += x.after.listUSD - x.before.listUSD;
        if (Number.isFinite(x.after.billedUSD) && Number.isFinite(x.before.billedUSD))
          r.billedUSD += x.after.billedUSD - x.before.billedUSD;
        r.priceVersion = x.after.priceVersion;
        r.center = x.after.center;
        r.unpriced = !!x.after.unpriced;
      }
    }
    return Object.defineProperty([...out.values()], 'unread', { value: rows.unread });
  }

  // Throws unless every month of [from, to] and the corrections read: what a view must have to be built on.
  function assertReadable(from, to) {
    if (!correctionsRead) throw correctionsError(correctionsFailure);
    const gap = missingIn(from, to)[0];
    if (gap) throw unreadError(listed ? gap : 'folder', listed ? unread.get(gap) : listError);
  }

  return {
    load,
    get(d) {
      const r = monthMap(monthOf(d.day)).get(rowKey(d));
      return r ? cloneRow(r) : null;
    },
    put(r) {
      const m = monthOf(r.day);
      monthMap(m).set(rowKey(r), cloneRow(r));
      dirty.add(m);
    },
    remove(r) {
      const m = monthOf(r.day);
      if (monthMap(m).delete(rowKey(r))) dirty.add(m);
    },
    // One day is a read-modify-write input, so an unavailable month throws here rather than reading as empty.
    day(day) {
      monthMap(monthOf(day));
      return range(day, day);
    },
    range,
    all: () => [...months.values()].flatMap((rows) => [...rows.values()].map(cloneRow)),
    // An unavailable month at or before the answer could hold an earlier day, so it throws then.
    earliestDay(source) {
      if (!listed) throw unreadError('folder', listError);
      let first = null;
      for (const rows of months.values())
        for (const r of rows.values())
          if (r.source === source && r.kind !== 'plan' && (!first || r.day < first)) first = r.day;
      const before = [...unread.keys()].sort().find((m) => !first || m <= monthOf(first));
      if (before) throw unreadError(before, unread.get(before));
      return first;
    },
    // The ledger's first day: its earliest usage row (a correction's new row included), where the forecast's known days
    // start (lib/cost/forecast.js). A month that did not read and comes first could hold an earlier day: its 1st then.
    // null before the folder was listed, or with no usage row at all.
    firstDay() {
      if (!listed) return null;
      let first = null;
      for (const m of [...months.keys()].sort()) {
        for (const r of months.get(m).values()) if (r.kind !== 'plan' && (!first || r.day < first)) first = r.day;
        if (first) break;
      }
      for (const c of corrections)
        for (const x of c.rows || [])
          if (x && !x.before && x.row && x.row.kind !== 'plan' && isDay(x.row.day) && (!first || x.row.day < first))
            first = x.row.day;
      const before = [...unread.keys()].sort()[0];
      return before && (!first || before < monthOf(first)) ? `${before}-01` : first;
    },
    // Writes every readable month that changed, never an unavailable one, then throws while a month is unavailable,
    // so the caller's error stays up. Each flush tries those reads again. Unread corrections do not make the months
    // unsafe to write, so they do not throw here: unread() names them and addCorrection refuses until they read.
    flush() {
      if (pending()) catchUp();
      for (const m of [...dirty]) {
        if (!available(m)) continue;
        if (dir) writeMonth(m);
        dirty.delete(m);
      }
      const e = monthPending();
      if (e) throw e;
    },
    // What is unavailable: month ids, plus 'folder' and 'corrections'. Names only, never paths.
    unread: () => [
      ...(listed ? [] : ['folder']),
      ...[...unread.keys()].sort(),
      ...(correctionsRead ? [] : ['corrections']),
    ],
    corrections: () => corrections.map((c) => JSON.parse(JSON.stringify(c))),
    assertReadable,
    // A correction is built from view(): with a month or the earlier corrections unavailable it would be built from a
    // partial view, so it is refused then.
    addCorrection(c) {
      if (!validCorrection(c)) throw new TypeError('not a valid correction');
      assertReadable(c.from, c.to);
      if (readOnly) throw new Error('the ledger is open read-only');
      const copy = JSON.parse(JSON.stringify(c));
      if (dir) appendPrivate(correctionsFile(), JSON.stringify(copy) + '\n');
      corrections.push(copy);
    },
    view,
    badLines: () => bad,
  };
}

// Rows summed by the dimensions asked for (R15). With `rateOf` (day → units per USD, or null) each group also carries
// its amounts in the display currency; a day without a rate makes that group's (and the totals') amounts null (R14).
function groupRows(rows, { groupBy = ['day'], rateOf = null } = {}) {
  const groups = new Map();
  const missing = new Set();
  const totals = { requests: 0, listUSD: 0, billedUSD: 0, ...(rateOf ? { list: 0, billed: 0 } : {}) };
  for (const r of rows) {
    const k = JSON.stringify(groupBy.map((d) => r[d] ?? null));
    let g = groups.get(k);
    if (!g) {
      g = {
        ...Object.fromEntries(groupBy.map((d) => [d, r[d] ?? null])),
        requests: 0,
        tokens: zeroTokens(),
        webSearches: 0,
        listUSD: 0,
        billedUSD: 0,
        unpriced: false,
        estimated: false,
        backfilled: false,
        billingAssumed: false,
        ...(rateOf ? { list: 0, billed: 0 } : {}),
      };
      groups.set(k, g);
    }
    g.requests += num(r.requests);
    for (const f of TOKENS) g.tokens[f] += num(r.tokens && r.tokens[f]);
    g.webSearches += num(r.webSearches);
    g.listUSD += num(r.listUSD);
    g.billedUSD += num(r.billedUSD);
    g.unpriced = g.unpriced || !!r.unpriced;
    g.estimated = g.estimated || !!r.estimated;
    g.backfilled = g.backfilled || !!r.backfilled;
    g.billingAssumed = g.billingAssumed || !!r.billingAssumed;
    totals.requests += num(r.requests);
    totals.listUSD += num(r.listUSD);
    totals.billedUSD += num(r.billedUSD);
    if (!rateOf) continue;
    const rate = rateOf(r.day);
    if (rate == null) {
      missing.add(r.day);
      g.list = g.billed = totals.list = totals.billed = null;
      continue;
    }
    if (g.list !== null) {
      g.list += num(r.listUSD) * rate;
      g.billed += num(r.billedUSD) * rate;
    }
    if (totals.list !== null) {
      totals.list += num(r.listUSD) * rate;
      totals.billed += num(r.billedUSD) * rate;
    }
  }
  const usd = (v) => Math.round(v * 1e8) / 1e8;
  const cur = (v) => (v === null ? null : Math.round(v * 1e4) / 1e4);
  const money = (x) => ({
    ...x,
    listUSD: usd(x.listUSD),
    billedUSD: usd(x.billedUSD),
    ...(rateOf ? { list: cur(x.list), billed: cur(x.billed) } : {}),
  });
  const out = [...groups.values()].map(money);
  out.sort(
    (a, b) =>
      String(a.day ?? '').localeCompare(String(b.day ?? '')) || b.listUSD + b.billedUSD - (a.listUSD + a.billedUSD),
  );
  // The months a range read skipped (view().unread), carried so the reader can say what is not shown.
  return { rows: out, totals: money(totals), missingRate: missing.size, unread: (rows && rows.unread) || [] };
}

// A row's list price at another pricer, from its daily sums: each request is taken as the row's average request (which
// also picks the prompt-length tier), times the number of requests.
function repriceRow(r, pricer) {
  const n = Math.max(1, num(r.requests));
  const t = r.tokens || {};
  const extra = r.webSearches || r.geo ? { ws: num(r.webSearches) / n, geo: r.geo } : null;
  const p = pricer.parts(
    r.model,
    num(t.in) / n,
    num(t.out) / n,
    num(t.cacheRead) / n,
    num(t.cacheWrite5m) / n,
    num(t.cacheWrite1h) / n,
    extra,
  );
  return (p[0] + p[1] + p[2] + p[3] + p[4]) * n;
}

const differs = (a, b) =>
  Math.abs(a.listUSD - b.listUSD) > 1e-12 ||
  a.priceVersion !== b.priceVersion ||
  a.center !== b.center ||
  a.unpriced !== b.unpriced;

// What a restate of [from, to] records (R13), computed only: the before and after of every usage row that changes when
// it is re-priced with `pricer` (as version `version.id`) and re-attributed with `rules`. Writes nothing; throws while a
// month of the range or the corrections did not read, as restate() does. The settings and restate previews use it.
function restateRows(store, { from, to, version, pricer, rules }) {
  store.assertReadable(from, to);
  const rows = [];
  for (const r of store.view(from, to)) {
    if (r.kind === 'plan') continue; // a stored plan row (an older format): readers ignore it
    const before = {
      listUSD: r.listUSD,
      priceVersion: r.priceVersion ?? null,
      center: r.center ?? null,
      unpriced: !!r.unpriced,
    };
    const priced = !!r.free || (!!r.model && pricer.priced(r.model));
    const after = {
      listUSD: r.free || !priced ? 0 : repriceRow(r, pricer),
      priceVersion: version.id,
      center: rules.centerOf(r),
      unpriced: !priced,
    };
    // `r.key` is the stored row's key, which every correction of that row refers to, whatever center it shows now.
    if (differs(before, after)) rows.push({ key: r.key, before, after });
  }
  return rows;
}

// Re-prices [from, to] with the current pricing and re-attributes it with the current rules (R13): one correction with
// the before and after of every usage row that changes, appended even when none does. The stored rows are never
// rewritten. Billing is not in it: it is derived when the ledger is read, and a restate re-bills its range through
// billing overrides, which `billing` (each source's billing as restated) records here. Throws, appending nothing,
// while a month of the range or the corrections did not read.
function restate(store, { from, to, reason, ts, version, pricer, rules, billing = [] }) {
  const rows = restateRows(store, { from, to, version, pricer, rules });
  const correction = { ts, from, to, reason, priceVersion: version.id, rows, billing };
  store.addCorrection(correction);
  return correction;
}

module.exports = {
  UNREAD,
  CORRECTIONS_UNREAD,
  DIMS,
  KEY_FIELDS,
  TOKENS,
  newRow,
  cloneRow,
  rowKey,
  baseKey,
  tokenTotal,
  mergeRows,
  planRow,
  createLedgerStore,
  groupRows,
  repriceRow,
  restateRows,
  restate,
};
