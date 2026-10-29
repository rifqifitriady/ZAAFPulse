// Cost Control 5: a read-only view of the cost data for the owner's stdio MCP (mcp.js): the ledger months and their
// corrections, the billing history, and the budgets list as the server last saved them (config.json, else
// budgets.last.json). No ledger pass and no write of any kind: a bad line or a damaged file is skipped and left where it
// is. Every call reads the files again, so it follows the running server.
const fs = require('fs');
const path = require('path');
const L = require('./ledger');
const { createBillingHistory } = require('./billing');
const { billedRows } = require('./billing-view');
const { createBudgetService } = require('./budget-service');
const { planFee } = require('./rules');
const { dayOf, addDays } = require('./days');

const RANGES = ['7', '30', '90', 'month', 'lastmonth'];
const DIMS = ['source', 'provider', 'model', 'project', 'center', 'keyId'];
const TOP = 50;
const FOLDER_UNREAD = 'the ledger folder could not be read';
// What a budget view says to an agent: no enforcement, no legacy or period internals.
const BUDGET_FIELDS = [
  'id',
  'name',
  'scope',
  'period',
  'from',
  'to',
  'amount',
  'currency',
  'measure',
  'state',
  'projected',
  'percent',
  'spent',
  'spentUSD',
  'amountUSD',
  'forecastUSD',
  'runsOut',
  'reason',
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round8 = (v) => Math.round(v * 1e8) / 1e8;

/** The days of an acc_cost range, ending today: 7, 30 or 90 days, this month, or last month. */
function rangeDays(range, today) {
  if (range === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  if (range === 'lastmonth') {
    const last = addDays(`${today.slice(0, 8)}01`, -1);
    return { from: `${last.slice(0, 8)}01`, to: last };
  }
  return { from: addDays(today, -(Number(range) - 1)), to: today };
}

function createCostReader({ dir, configFile, keysFile, home = '', now = Date.now, nocase } = {}) {
  const readJson = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return e && e.code === 'ENOENT' ? fallback : undefined;
    }
  };
  // config.json as the server reads it: {} when missing, false when it does not parse (the cost section then
  // reads as unknown and the budgets fall back to budgets.last.json, as in the server).
  const config = () => {
    let text = '';
    try {
      text = fs.readFileSync(configFile, 'utf8');
    } catch (e) {
      return e && e.code === 'ENOENT' ? {} : false;
    }
    if (!text.trim()) return {}; // empty reads as no settings, as in the server
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      return false;
    }
    return v && typeof v === 'object' && !Array.isArray(v) ? v : false;
  };

  function open() {
    const store = L.createLedgerStore({ dir, readOnly: true });
    try {
      store.load();
    } catch {
      /* what did not read is named in each view's `unread` */
    }
    const billing = createBillingHistory({
      dir,
      readOnly: true,
      earlierData: () => store.all().some((r) => r.kind !== 'plan'),
    });
    const rowsOf = (from, to) =>
      billedRows(store.view(from, to), { from, to, today: dayOf(now()), billingFor: billing.billingFor });
    return { store, billing, rowsOf };
  }

  /** acc_cost: spend over a range grouped by 1–2 dimensions, the top 50 by usage value, then Other. */
  function spend({ range = '30', groupBy = ['model'] } = {}) {
    if (!RANGES.includes(range)) throw new Error(`range: one of ${RANGES.join(', ')}`);
    const dims = Array.isArray(groupBy) ? groupBy : [];
    if (!dims.length || dims.length > 2 || dims.some((d) => !DIMS.includes(d)) || new Set(dims).size !== dims.length)
      throw new Error(`groupBy: 1 or 2 of ${DIMS.join(', ')}`);
    const { from, to } = rangeDays(range, dayOf(now()));
    const { store, billing, rowsOf } = open();
    // A month that did not read is named in `unread`; a folder that did not read leaves nothing to answer from.
    if (store.unread().includes('folder')) throw new Error(FOLDER_UNREAD);
    const rows = rowsOf(from, to);
    const g = L.groupRows(rows, { groupBy: dims });
    const shape = (x) => ({
      ...Object.fromEntries(dims.map((d) => [d, x[d] ?? null])),
      requests: num(x.requests),
      tokens: {
        input: num(x.tokens.in),
        output: num(x.tokens.out),
        cacheRead: num(x.tokens.cacheRead),
        cacheWrite: num(x.tokens.cacheWrite5m) + num(x.tokens.cacheWrite1h),
      },
      listUSD: x.listUSD,
      billedUSD: x.billedUSD,
    });
    const all = g.rows.map(shape).sort((a, b) => b.listUSD - a.listUSD || b.billedUSD - a.billedUSD);
    const out = all.slice(0, TOP);
    if (all.length > TOP) {
      const rest = all.slice(TOP);
      const other = { ...Object.fromEntries(dims.map((d) => [d, 'Other'])), count: rest.length, requests: 0 };
      other.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      other.listUSD = 0;
      other.billedUSD = 0;
      for (const x of rest) {
        other.requests += x.requests;
        for (const k of Object.keys(other.tokens)) other.tokens[k] += x.tokens[k];
        other.listUSD += x.listUSD;
        other.billedUSD += x.billedUSD;
      }
      other.listUSD = round8(other.listUSD);
      other.billedUSD = round8(other.billedUSD);
      out.push(other);
    }
    return {
      from,
      to,
      groupBy: dims,
      rows: out,
      totals: { requests: g.totals.requests, listUSD: g.totals.listUSD, billedUSD: g.totals.billedUSD },
      unread: [...rows.unread],
      // Paid amounts are assumed (billed as metered) when the history is lost or does not read.
      billing: {
        error: billing.error() ? 'the billing history could not be read' : null,
        historyLost: billing.lost(),
      },
    };
  }

  /** acc_budgets: the budgets in force with their state and forecast, as GET /api/cost/budgets has them. */
  function budgets() {
    const { store, billing, rowsOf } = open();
    const cost = {
      budgetRows: ({ from, to }) => {
        const rows = rowsOf(from, to);
        return {
          rows,
          unread: [...rows.unread],
          billingError: billing.error() ? 'the billing history could not be read' : null,
          historyLost: billing.lost(),
        };
      },
      firstDay: () => store.firstDay(),
      planFeeFor: (source, day) => {
        const b = billing.billingFor(source, day);
        return b && b.mode === 'plan' ? planFee(b, day) : 0;
      },
    };
    const cfg = config();
    const service = createBudgetService({
      getSettings: () => (cfg === false ? false : cfg.cost),
      getLegacy: () => {
        const k = readJson(keysFile, { keys: [] });
        return { monthlyBudgetUSD: cfg ? cfg.monthlyBudgetUSD : undefined, keys: (k && k.keys) || [] };
      },
      cost,
      home,
      now,
      nocase,
      lastFile: dir && path.join(dir, 'budgets.last.json'),
      readOnly: true,
    });
    const views = service.evaluate();
    return {
      budgets: views.map((v) => Object.fromEntries(BUDGET_FIELDS.map((f) => [f, v[f] === undefined ? null : v[f]]))),
      error: service.status().error,
    };
  }

  return { spend, budgets };
}

module.exports = { createCostReader, rangeDays, RANGES, DIMS, TOP };
