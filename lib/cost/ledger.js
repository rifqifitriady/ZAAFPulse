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

// One side of a corrected row: what view() reads from it.
const validState = (s) =>
  isObject(s) &&
  Number.isFinite(s.listUSD) &&
  Number.isFinite(s.billedUSD) &&
  (s.priceVersion == null || Number.isFinite(s.priceVersion)) &&
  (s.center == null || typeof s.center === 'string');

// A correction is applied whole or not at all: one bad entry rejects it, so it is never half applied.
const validCorrection = (c) =>
  isObject(c) &&
  isDay(c.from) &&
  isDay(c.to) &&
  c.from <= c.to &&
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
// Path-free: the caller shows it as status. The code of the first failure is kept for that status.
function unreadError(code) {
  const e = new Error('part of the cost ledger could not be read, so it is not written');
  if (typeof code === 'string') e.code = code;
  return e;
}

function createLedgerStore({ dir = null } = {}) {
  const months = new Map(); // 'YYYY-MM' -> Map(rowKey -> row)
  const dirty = new Set();
  // A month is written only once its file has been read in full: a month written from a partial read would overwrite
  // the rows that were not read. Until the folder is listed (no load yet, or listing failed) every month counts as
  // unread. The puts and removes made to an unread month wait in `held` and are replayed on top of the file once it
  // reads; every flush tries those reads again.
  let listed = !dir;
  const unread = new Map(); // month -> error code of the last failed read (or null)
  const held = new Map(); // month -> [{ put: row } | { remove: key }]
  let correctionsRead = !dir;
  let lastCode = null;
  let corrections = [];
  let bad = 0;
  const fileOf = (m) => path.join(dir, `ledger-${m}.jsonl`);
  const correctionsFile = () => path.join(dir, 'corrections.jsonl');
  const monthMap = (m) => {
    if (!months.has(m)) months.set(m, new Map());
    return months.get(m);
  };
  const writable = (m) => listed && !unread.has(m);
  const hold = (m, op) => {
    if (!held.has(m)) held.set(m, []);
    held.get(m).push(op);
  };
  const writeMonth = (m) =>
    writePrivate(fileOf(m), [...monthMap(m).values()].map((r) => JSON.stringify(r) + '\n').join(''));

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
    const ops = held.get(m) || [];
    for (const op of ops) {
      if (op.put) rows.set(rowKey(op.put), cloneRow(op.put));
      else rows.delete(op.remove);
    }
    months.set(m, rows);
    if (badLines.length) {
      // Kept aside, not lost. If this append fails the month stays unread, so its file is not rewritten without them.
      appendPrivate(`${fileOf(m)}.bad`, badLines.map((l) => l + '\n').join(''));
      bad += badLines.length;
    }
    unread.delete(m);
    held.delete(m);
    if (!badLines.length && !ops.length) return;
    dirty.add(m);
    if (!badLines.length) return;
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
    // The file holds every correction added while it could not be read, so it replaces what is in memory.
    corrections = good.map((g) => g.c);
    correctionsRead = true;
    if (!badLines.length) return;
    bad += badLines.length;
    try {
      appendPrivate(`${correctionsFile()}.bad`, badLines.map((l) => l + '\n').join(''));
      writePrivate(correctionsFile(), good.map((g) => g.line + '\n').join(''));
    } catch {
      /* the lines stay where they are and are skipped again on the next load */
    }
  }

  // Reads whatever is still unread. Returns the failures; the months that did read are usable and writable.
  function catchUp() {
    const failures = [];
    if (!dir) return failures;
    if (!listed) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch (e) {
        if (e.code !== 'ENOENT') return [e];
      }
      listed = true;
      for (const name of names) {
        const m = LEDGER_FILE.exec(name);
        if (m) unread.set(m[1], null);
      }
      // Months touched before the listing that have no file: replaying their held changes over nothing is what
      // memory already holds, and it lets them be written.
      for (const m of held.keys()) if (!unread.has(m)) unread.set(m, null);
    }
    // A failure on one month does not stop the others.
    for (const m of [...unread.keys()].sort()) {
      try {
        readMonth(m);
      } catch (e) {
        unread.set(m, typeof e.code === 'string' ? e.code : null);
        failures.push(e);
      }
    }
    if (!correctionsRead) {
      try {
        readCorrections();
      } catch (e) {
        failures.push(e);
      }
    }
    return failures;
  }

  const blocked = () => !listed || unread.size > 0 || !correctionsRead;

  function load() {
    months.clear();
    dirty.clear();
    corrections = [];
    bad = 0;
    // Held changes stay: they are replayed once their month reads.
    if (dir) {
      listed = false;
      correctionsRead = false;
      unread.clear();
    }
    const failures = catchUp();
    if (!failures.length) return;
    lastCode = failures[0].code;
    throw unreadError(lastCode);
  }

  const range = (from, to) => {
    const out = [];
    for (const [m, rows] of months)
      if (m >= monthOf(from) && m <= monthOf(to))
        for (const r of rows.values()) if (r.day >= from && r.day <= to) out.push(cloneRow(r));
    return out;
  };

  // The rows of [from, to] as readers see them: every correction applied in the order it was made (R13).
  function view(from, to) {
    const out = new Map(range(from, to).map((r) => [rowKey(r), { ...r, key: rowKey(r) }]));
    for (const c of corrections) {
      if (c.to < from || c.from > to) continue;
      for (const x of c.rows) {
        if (!x || typeof x.key !== 'string' || !x.after) continue;
        if (!x.before) {
          if (x.row && x.row.day >= from && x.row.day <= to) out.set(x.key, { ...cloneRow(x.row), key: x.key });
          continue;
        }
        const r = out.get(x.key);
        if (!r) continue;
        r.listUSD += x.after.listUSD - x.before.listUSD;
        r.billedUSD += x.after.billedUSD - x.before.billedUSD;
        r.priceVersion = x.after.priceVersion;
        r.center = x.after.center;
        r.unpriced = !!x.after.unpriced;
      }
    }
    return [...out.values()];
  }

  return {
    load,
    get(d) {
      const r = (months.get(monthOf(d.day)) || new Map()).get(rowKey(d));
      return r ? cloneRow(r) : null;
    },
    put(r) {
      const m = monthOf(r.day);
      monthMap(m).set(rowKey(r), cloneRow(r));
      dirty.add(m);
      if (!writable(m)) hold(m, { put: cloneRow(r) });
    },
    remove(r) {
      const m = monthOf(r.day);
      const had = monthMap(m).delete(rowKey(r));
      // An unread month may have the row on disk even when memory does not.
      if (!writable(m)) hold(m, { remove: rowKey(r) });
      if (had || !writable(m)) dirty.add(m);
    },
    day: (day) => range(day, day),
    range,
    all: () => [...months.values()].flatMap((rows) => [...rows.values()].map(cloneRow)),
    earliestDay(source) {
      let first = null;
      for (const rows of months.values())
        for (const r of rows.values())
          if (r.source === source && r.kind !== 'plan' && (!first || r.day < first)) first = r.day;
      return first;
    },
    // Writes every changed month that was read in full. While any part is unread it throws after writing the rest,
    // so the caller's error stays up; the unread months keep their changes in memory for a later flush.
    flush() {
      if (blocked()) {
        const failures = catchUp();
        if (failures.length) lastCode = failures[0].code;
      }
      for (const m of [...dirty]) {
        if (!writable(m)) continue;
        if (dir) writeMonth(m);
        dirty.delete(m);
      }
      if (blocked()) throw unreadError(lastCode);
    },
    // What is not written until it reads: month ids, plus 'folder' and 'corrections'. Names only, never paths.
    unread: () => [
      ...(listed ? [] : ['folder']),
      ...[...unread.keys()].sort(),
      ...(correctionsRead ? [] : ['corrections']),
    ],
    corrections: () => corrections.map((c) => JSON.parse(JSON.stringify(c))),
    addCorrection(c) {
      if (!validCorrection(c)) throw new TypeError('not a valid correction');
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
  return { rows: out, totals: money(totals), missingRate: missing.size };
}

module.exports = {
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
};
