// Local calendar days (YYYY-MM-DD in this machine's time zone): the day boundary the Overview uses (lib/aggregate.js).
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');

function dayOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The shape, and a date that exists (no 2026-02-30).
function isDay(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}

// Calendar arithmetic at local noon, so a daylight-saving change never skips or repeats a day.
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return dayOf(new Date(y, m - 1, d + n, 12).getTime());
}

const monthOf = (day) => day.slice(0, 7);

function daysInMonth(day) {
  const [y, m] = day.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function daysInYear(day) {
  const y = Number(day.slice(0, 4));
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
}

// Every day from `from` to `to`, both included.
function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

module.exports = { dayOf, isDay, addDays, monthOf, daysInMonth, daysInYear, daysBetween };
