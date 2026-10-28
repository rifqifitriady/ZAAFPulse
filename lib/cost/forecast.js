// Cost Control, sub-project 4a: the forecast every cost figure uses (the Overview burn-down, a budget's `projected`
// and its "runs out" date). A mean per weekday over the last 4 weeks of finished days; with less history a plain daily
// mean; with too little, no forecast. Pure: no I/O and no clock (`today` is an argument). Days are local YYYY-MM-DD,
// as in the ledger.
const { addDays, daysBetween, isDay, monthOf } = require('./days');

const WEEKS = 4;
const MIN_KNOWN = 3; // fewer known days: no forecast (and no anomaly), as the spike rule had
const WEEKDAY_FROM = 7; // known days from which each weekday has its own mean
const MIN_RATIOS = 3; // fewer day ratios: the band is the forecast itself
const BAND_MAX = 10;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round8 = (v) => Math.round(v * 1e8) / 1e8;
const clampBand = (v) => Math.min(BAND_MAX, Math.max(0, v));

// Monday is 0, as a budget's week (lib/cost/budgets.js periodBounds). Local noon, so no time zone moves the day.
function weekday(day) {
  const [y, m, d] = day.split('-').map(Number);
  return (new Date(y, m - 1, d, 12).getDay() + 6) % 7;
}

// The q-quantile with linear interpolation between the two nearest values (the spreadsheet PERCENTILE).
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/**
 * The spend model of the finished days in [today − 7·weeks, today − 1]. `rows` are { day, usd } of one measure (plan
 * rows left out by the caller), one per row or per day. A day counts only from the ledger's first day, `since`
 * (cost.firstDay): before the ledger began is unknown, not zero, and a day in the known span without a row is a real
 * zero. `since` keeps every reader on the same known days whatever window it read; without it the first row passed in
 * stands in (and a row before `since` moves it back). A day of a month in `unread` is unknown too, so a month that did
 * not read never lowers the forecast; 'folder' or 'corrections' in it means nothing read as it should: no model.
 * Returns null, or { method: 'weekday' | 'mean', known, byWeekday: [Mon..Sun], mean, low, high, days }; `days` are the
 * known days, which the anomaly drivers compare against (lib/cost/anomaly.js).
 */
function dailyModel(rows, { today, weeks = WEEKS, unread = [], since = null } = {}) {
  const skip = new Set(unread || []);
  if (skip.has('folder') || skip.has('corrections')) return null;
  const from = addDays(today, -7 * weeks);
  const to = addDays(today, -1);
  const sums = new Map();
  let first = null;
  for (const r of rows || []) {
    if (!r || typeof r.day !== 'string' || r.day > to) continue;
    if (!first || r.day < first) first = r.day;
    if (r.day >= from) sums.set(r.day, (sums.get(r.day) || 0) + num(r.usd));
  }
  if (isDay(since) && (!first || since < first)) first = since;
  if (!first) return null;
  const days = daysBetween(first > from ? first : from, to).filter((d) => !skip.has(monthOf(d)));
  if (days.length < MIN_KNOWN) return null;
  const value = (d) => sums.get(d) || 0;
  const mean = days.reduce((a, d) => a + value(d), 0) / days.length;
  const method = days.length >= WEEKDAY_FROM ? 'weekday' : 'mean';
  const byWeekday = Array(7).fill(mean);
  if (method === 'weekday') {
    const sum = Array(7).fill(0);
    const n = Array(7).fill(0);
    for (const d of days) {
      sum[weekday(d)] += value(d);
      n[weekday(d)]++;
    }
    for (let w = 0; w < 7; w++) if (n[w]) byWeekday[w] = sum[w] / n[w]; // a weekday with no known day keeps the mean
  }
  // The band: how far a known day falls from what its own model expected, as the 25th and 75th percentile ratio.
  const ratios = [];
  for (const d of days) {
    const e = byWeekday[weekday(d)];
    if (e > 0) ratios.push(value(d) / e);
  }
  ratios.sort((a, b) => a - b);
  const few = ratios.length < MIN_RATIOS;
  return {
    method,
    known: days.length,
    byWeekday,
    mean,
    low: few ? 1 : Math.min(1, clampBand(quantile(ratios, 0.25))), // the band always holds the line itself
    high: few ? 1 : Math.max(1, clampBand(quantile(ratios, 0.75))),
    days,
  };
}

/**
 * The cumulative forecast from `today` to `to`, both included: [{ day, cum, low, high }]. `spentSoFar` is the period's
 * spend up to yesterday plus today so far (today's plan fee included, as the reader bills it), `todaySoFar` today's
 * usage so far. Today never forecasts less than what it spent already; each later day adds its weekday's usage and
 * `planPerDay(day)`, the exact plan fee of that day (the Paid measure only). The band scales the usage only.
 */
function project(model, { today, spentSoFar = 0, todaySoFar = 0, to, planPerDay = () => 0 } = {}) {
  if (!model || !today || !to || to < today) return [];
  let cum = num(spentSoFar);
  let low = cum;
  let high = cum;
  const so = num(todaySoFar);
  const out = [];
  for (const day of daysBetween(today, to)) {
    const e = Math.max(0, model.byWeekday[weekday(day)]); // credits can make a weekday negative
    if (day === today) {
      cum += Math.max(0, e - so);
      low += Math.max(0, e * model.low - so);
      high += Math.max(0, e * model.high - so);
    } else {
      const fee = num(planPerDay(day));
      cum += e + fee;
      low += e * model.low + fee;
      high += e * model.high + fee;
    }
    out.push({ day, cum: round8(cum), low: round8(low), high: round8(high) });
  }
  return out;
}

// The first day whose forecast passes `amount` (equal is not passed), or null: none passes, no line, or an amount
// that is not a positive number.
function runsOut(line, amount) {
  if (!(typeof amount === 'number' && Number.isFinite(amount) && amount > 0) || !Array.isArray(line)) return null;
  const hit = line.find((p) => p && p.cum > amount);
  return hit ? hit.day : null;
}

module.exports = { WEEKS, MIN_KNOWN, WEEKDAY_FROM, weekday, quantile, dailyModel, project, runsOut };
