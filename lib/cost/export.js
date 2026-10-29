// Cost Control 5: the ledger grouping as a file to download (GET /api/cost/export). Pure: the grouped answer of
// cost.ledger() in, CSV text or a JSON object out. Rows hold dimension values and numbers only, as the ledger does.
// CSV is RFC 4180 (comma, CRLF, quotes doubled), and a text cell a spreadsheet would run as a formula gets a leading '.
const MAX_ROWS = 100000;
const TOO_MANY = 'too many rows; narrow the range or group by fewer dimensions';
const COLUMNS = [
  'requests',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'listUSD',
  'billedUSD',
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round8 = (v) => Math.round(v * 1e8) / 1e8;

// The columns of an export: the groupBy dimensions, the counts and USD amounts, and the display currency's two amounts.
const columnsOf = (groupBy, currency) => [
  ...groupBy,
  ...COLUMNS,
  ...(currency && currency !== 'USD' ? [`list${currency}`, `billed${currency}`] : []),
];

// One grouped ledger row as an export row. `measure` decides which rows are kept, as the Breakdown table does: under
// usage value (list) a plan fee row (no requests, no usage value) is left out; under paid (billed) every row stays.
function exportRows(led, { measure = 'list' } = {}) {
  const groupBy = led.groupBy || [];
  const cur = led.currency && led.currency !== 'USD' ? led.currency : null;
  const out = [];
  for (const r of led.rows || []) {
    if (measure === 'list' && !num(r.requests) && !num(r.listUSD)) continue;
    const t = r.tokens || {};
    const row = {};
    for (const d of groupBy) row[d] = r[d] ?? null;
    row.requests = num(r.requests);
    row.inputTokens = num(t.in);
    row.outputTokens = num(t.out);
    row.cacheReadTokens = num(t.cacheRead);
    row.cacheWriteTokens = num(t.cacheWrite5m) + num(t.cacheWrite1h);
    row.listUSD = num(r.listUSD);
    row.billedUSD = num(r.billedUSD);
    if (cur) {
      row[`list${cur}`] = r.list ?? null;
      row[`billed${cur}`] = r.billed ?? null;
    }
    out.push(row);
  }
  return out;
}

// The sums of the rows kept. A currency amount is null when any row's is (a day without a rate), as the ledger's.
function totalsOf(rows, currency) {
  const cur = currency && currency !== 'USD' ? currency : null;
  const t = Object.fromEntries(COLUMNS.map((c) => [c, 0]));
  if (cur) Object.assign(t, { [`list${cur}`]: 0, [`billed${cur}`]: 0 });
  for (const r of rows) {
    for (const c of COLUMNS) t[c] += num(r[c]);
    if (!cur) continue;
    for (const c of [`list${cur}`, `billed${cur}`]) t[c] = t[c] === null || r[c] === null ? null : t[c] + num(r[c]);
  }
  for (const c of ['listUSD', 'billedUSD']) t[c] = round8(t[c]);
  if (cur) for (const c of [`list${cur}`, `billed${cur}`]) if (t[c] !== null) t[c] = Math.round(t[c] * 1e4) / 1e4;
  return t;
}

// More rows than a download may hold: 413, before anything is encoded.
function checkSize(rows, max = MAX_ROWS) {
  if (rows.length > max) throw Object.assign(new Error(TOO_MANY), { status: 413 });
}

// A CSV cell. Text that starts with = + - @, a tab or a CR is prefixed with ' (CSV injection); a cell holding a comma,
// a quote, a CR or an LF is quoted, its quotes doubled. Numbers are plain: integers as they are, amounts to 8 decimals.
function csvCell(v, { amount = false } = {}) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? (amount ? v.toFixed(8) : String(v)) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvLine = (cells) => cells.join(',') + '\r\n';
const isAmount = (c) => /^(list|billed)/.test(c);

// The CSV text: a header row, one line per row, and `# unread: …` last when a month (or the corrections) did not read.
function toCsv({ groupBy, currency, rows, unread = [] }) {
  const cols = columnsOf(groupBy, currency);
  let text = csvLine(cols.map((c) => csvCell(c)));
  for (const r of rows)
    text += csvLine(cols.map((c) => (groupBy.includes(c) ? csvCell(r[c]) : csvCell(r[c], { amount: isAmount(c) }))));
  // A comment line, not a record: month ids and fixed names only, so it needs no quoting.
  if (unread.length) text += `# unread: ${unread.join(', ')}\r\n`;
  return text;
}

// The JSON answer: what the CSV holds, with the totals and the range it covers.
function toJson({ from, to, groupBy, currency, measure, rows, unread = [] }) {
  return { from, to, groupBy, currency, measure, rows, totals: totalsOf(rows, currency), unread: [...unread] };
}

// "zaafpulse-cost-2026-10-01-2026-10-29.csv": the days are checked dates, so the name needs no escaping.
const fileName = (from, to, ext) => `zaafpulse-cost-${from}-${to}.${ext}`;

module.exports = {
  MAX_ROWS,
  TOO_MANY,
  COLUMNS,
  columnsOf,
  exportRows,
  totalsOf,
  checkSize,
  csvCell,
  toCsv,
  toJson,
  fileName,
};
