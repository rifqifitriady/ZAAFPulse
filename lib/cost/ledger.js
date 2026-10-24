// The cost ledger store: one row per day and dimension tuple in <dir>/ledger-YYYY-MM.jsonl, plus the corrections a
// restate appends to <dir>/corrections.jsonl. Rows hold numbers and names only. A month file is rewritten whole
// (temp file + rename) when one of its rows changes; a line that does not load is moved to ledger-YYYY-MM.jsonl.bad and
// the month still loads. Readers apply the corrections on top of the stored rows, which a restate never rewrites.
// With dir null (demo) everything stays in memory.
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
const tokenTotal = (r) => TOKENS.reduce((a, f) => a + ((r.tokens && r.tokens[f]) || 0), 0);

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
  out.requests += b.requests || 0;
  for (const f of TOKENS) out.tokens[f] += (b.tokens && b.tokens[f]) || 0;
  out.webSearches += b.webSearches || 0;
  out.listUSD += b.listUSD || 0;
  out.billedUSD += b.billedUSD || 0;
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

const validRow = (r, month) =>
  !!r &&
  typeof r === 'object' &&
  !Array.isArray(r) &&
  isDay(r.day) &&
  monthOf(r.day) === month &&
  SOURCES.includes(r.source) &&
  typeof r.kind === 'string' &&
  [r.requests, r.listUSD, r.billedUSD].every(Number.isFinite);

function createLedgerStore({ dir = null } = {}) {
  const months = new Map(); // 'YYYY-MM' -> Map(rowKey -> row)
  const dirty = new Set();
  let corrections = [];
  let bad = 0;
  const fileOf = (m) => path.join(dir, `ledger-${m}.jsonl`);
  const monthMap = (m) => {
    if (!months.has(m)) months.set(m, new Map());
    return months.get(m);
  };

  function load() {
    months.clear();
    dirty.clear();
    corrections = [];
    bad = 0;
    if (!dir) return;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const name of names.sort()) {
      const m = /^ledger-(\d{4}-\d{2})\.jsonl$/.exec(name);
      if (!m) continue;
      const rows = monthMap(m[1]);
      const badLines = [];
      for (const line of fs.readFileSync(fileOf(m[1]), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let r = null;
        try {
          r = JSON.parse(line);
        } catch {
          /* kept aside below */
        }
        if (validRow(r, m[1])) rows.set(rowKey(r), cloneRow(r));
        else badLines.push(line);
      }
      if (badLines.length) {
        // Kept aside, not lost; the month is written again without them on the next flush.
        appendPrivate(`${fileOf(m[1])}.bad`, badLines.map((l) => l + '\n').join(''));
        bad += badLines.length;
        dirty.add(m[1]);
      }
    }
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, 'corrections.jsonl'), 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line);
        if (c && Array.isArray(c.rows)) corrections.push(c);
        else bad++;
      } catch {
        bad++; // a torn last line from a crash mid-append
      }
    }
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
    },
    remove(r) {
      const m = monthOf(r.day);
      if (monthMap(m).delete(rowKey(r))) dirty.add(m);
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
    flush() {
      for (const m of [...dirty]) {
        if (dir) writePrivate(fileOf(m), [...monthMap(m).values()].map((r) => JSON.stringify(r) + '\n').join(''));
        dirty.delete(m);
      }
    },
    corrections: () => corrections.slice(),
    addCorrection(c) {
      if (dir) appendPrivate(path.join(dir, 'corrections.jsonl'), JSON.stringify(c) + '\n');
      corrections.push(c);
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
    g.requests += r.requests || 0;
    for (const f of TOKENS) g.tokens[f] += (r.tokens && r.tokens[f]) || 0;
    g.webSearches += r.webSearches || 0;
    g.listUSD += r.listUSD || 0;
    g.billedUSD += r.billedUSD || 0;
    g.unpriced = g.unpriced || !!r.unpriced;
    g.estimated = g.estimated || !!r.estimated;
    g.backfilled = g.backfilled || !!r.backfilled;
    totals.requests += r.requests || 0;
    totals.listUSD += r.listUSD || 0;
    totals.billedUSD += r.billedUSD || 0;
    if (!rateOf) continue;
    const rate = rateOf(r.day);
    if (rate == null) {
      missing.add(r.day);
      g.list = g.billed = totals.list = totals.billed = null;
      continue;
    }
    if (g.list !== null) {
      g.list += (r.listUSD || 0) * rate;
      g.billed += (r.billedUSD || 0) * rate;
    }
    if (totals.list !== null) {
      totals.list += (r.listUSD || 0) * rate;
      totals.billed += (r.billedUSD || 0) * rate;
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
