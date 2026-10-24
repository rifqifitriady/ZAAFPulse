// The owner's cost settings (config.json "cost"): cost centers, which gateway keys and project folders belong to each,
// how each source is billed (metered, or a plan with a fixed fee), and the display currency with its dated rates.
// Validation lives here, and so does attribution: a key's center first, then the first folder rule whose glob matches
// the project, else Unassigned.
const { isDay, daysInMonth, daysInYear } = require('./days');

const SOURCES = ['claude', 'codex', 'gateway', 'judge', 'replay', 'collab'];
const UNASSIGNED = 'unassigned';
const LIMITS = { centers: 50, keyCenters: 1000, folderRules: 100, rates: 1000, glob: 300, name: 60, plan: 60 };
const FIELDS = ['centers', 'keyCenters', 'folderRules', 'billing', 'currency'];
const CENTER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;
// A glob names folders from the top: ~ (the home folder), /, a drive letter, or a leading wildcard.
const GLOB_START = /^(?:~(?:\/|$)|\/|\*|[A-Za-z]:\/)/;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clip = (s) => String(s).slice(0, 40);
const defaults = () => ({ centers: [], keyCenters: {}, folderRules: [], billing: {}, currency: null });

// Glob → RegExp, matched against a whole project path written with ~ and forward slashes. * stays inside one folder,
// ? is one character, **/ is zero or more folders, ** elsewhere is anything, and a trailing /** also matches the folder
// itself. Everything else is literal (no classes or braces), so a folder name with [ or { needs no escaping.
function globToRegExp(glob, { nocase = false } = {}) {
  let src = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      src += '(?:/.*)?';
      i += 3;
    } else if (glob.startsWith('**/', i)) {
      src += '(?:.*/)?';
      i += 3;
    } else if (glob.startsWith('**', i)) {
      src += '.*';
      i += 2;
    } else {
      const c = glob[i];
      src += c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${src}$`, nocase ? 'i' : '');
}

function globProblem(glob) {
  if (!glob) return 'empty';
  if (glob.length > LIMITS.glob) return `longer than ${LIMITS.glob} characters`;
  if (/[\x00-\x1f]/.test(glob)) return 'holds a control character';
  if (glob.includes('***')) return 'three stars in a row';
  if (!GLOB_START.test(glob)) return 'starts with ~, /, * or a drive letter like C:/';
  return null;
}

// The glob as stored: forward slashes, and the home folder written as ~ (projects are matched in that form).
function normalizeGlob(glob, home) {
  const g = String(glob).replace(/\\/g, '/');
  const h = String(home || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  return h && (g === h || g.startsWith(h + '/')) ? '~' + g.slice(h.length) : g;
}

function validate(input, { home = '' } = {}) {
  if (!isObject(input)) return { ok: false, errors: ['cost settings must be an object'] };
  const errors = [];
  const out = defaults();
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) errors.push(`unknown field: ${clip(k)}`);

  const centers = input.centers ?? [];
  if (!Array.isArray(centers)) errors.push('centers must be a list');
  else if (centers.length > LIMITS.centers) errors.push(`at most ${LIMITS.centers} cost centers`);
  else
    centers.forEach((c, i) => {
      const id = isObject(c) && typeof c.id === 'string' ? c.id : '';
      const name = isObject(c) && typeof c.name === 'string' ? c.name.trim() : '';
      if (!CENTER_ID.test(id)) errors.push(`centers[${i}].id: lower-case letters, digits and dashes, up to 40`);
      else if (id === UNASSIGNED) errors.push(`centers[${i}].id: "unassigned" is reserved`);
      else if (out.centers.some((x) => x.id === id)) errors.push(`centers[${i}].id: ${id} is used twice`);
      else if (!name || name.length > LIMITS.name) errors.push(`centers[${i}].name: 1 to ${LIMITS.name} characters`);
      else out.centers.push({ id, name });
    });
  const known = (id) => typeof id === 'string' && out.centers.some((c) => c.id === id);

  const kc = input.keyCenters ?? {};
  if (!isObject(kc)) errors.push('keyCenters must be an object');
  else if (Object.keys(kc).length > LIMITS.keyCenters) errors.push(`keyCenters: at most ${LIMITS.keyCenters} keys`);
  else
    for (const [key, center] of Object.entries(kc)) {
      if (!KEY_ID.test(key)) errors.push(`keyCenters: bad key id ${clip(key)}`);
      else if (!known(center)) errors.push(`keyCenters.${key}: unknown cost center`);
      else out.keyCenters[key] = center;
    }

  const rules = input.folderRules ?? [];
  if (!Array.isArray(rules)) errors.push('folderRules must be a list');
  else if (rules.length > LIMITS.folderRules) errors.push(`at most ${LIMITS.folderRules} folder rules`);
  else
    rules.forEach((r, i) => {
      const glob = normalizeGlob(isObject(r) && typeof r.glob === 'string' ? r.glob.trim() : '', home);
      const why = globProblem(glob);
      if (why) errors.push(`folderRules[${i}].glob: ${why}`);
      else if (!known(r.center)) errors.push(`folderRules[${i}].center: unknown cost center`);
      else out.folderRules.push({ glob, center: r.center });
    });

  const billing = input.billing ?? {};
  if (!isObject(billing)) errors.push('billing must be an object');
  else
    for (const [source, b] of Object.entries(billing)) {
      if (!SOURCES.includes(source)) errors.push(`billing: unknown source ${clip(source)}`);
      else if (isObject(b) && b.mode === 'metered' && Object.keys(b).length === 1) out.billing[source] = { mode: 'metered' };
      else if (isObject(b) && b.mode === 'plan') {
        const plan = typeof b.plan === 'string' ? b.plan.trim() : '';
        if (!plan || plan.length > LIMITS.plan) errors.push(`billing.${source}.plan: 1 to ${LIMITS.plan} characters`);
        else if (!isNum(b.feeUSD) || b.feeUSD < 0 || b.feeUSD > 1e6)
          errors.push(`billing.${source}.feeUSD: a number from 0 to 1,000,000`);
        else if (b.period !== 'month' && b.period !== 'year') errors.push(`billing.${source}.period: month or year`);
        else out.billing[source] = { mode: 'plan', plan, feeUSD: b.feeUSD, period: b.period };
      } else errors.push(`billing.${source}: { mode: 'metered' } or { mode: 'plan', plan, feeUSD, period }`);
    }

  const cur = input.currency ?? null;
  if (cur !== null) {
    if (!isObject(cur)) errors.push('currency must be an object or null');
    else if (typeof cur.code !== 'string' || !CURRENCY.test(cur.code))
      errors.push('currency.code: three capital letters, like IDR');
    else if (cur.code === 'USD') errors.push('currency.code: the ledger is kept in USD; leave currency empty for USD only');
    else if (!Array.isArray(cur.rates) || cur.rates.length > LIMITS.rates)
      errors.push(`currency.rates: a list of at most ${LIMITS.rates}`);
    else {
      const rates = [];
      cur.rates.forEach((r, i) => {
        if (!isObject(r) || !isDay(r.from)) errors.push(`currency.rates[${i}].from: a date YYYY-MM-DD`);
        else if (!isNum(r.perUSD) || r.perUSD <= 0 || r.perUSD > 1e9)
          errors.push(`currency.rates[${i}].perUSD: a number above 0`);
        else if (rates.some((x) => x.from === r.from)) errors.push(`currency.rates[${i}].from: ${r.from} is used twice`);
        else rates.push({ from: r.from, perUSD: r.perUSD });
      });
      out.currency = { code: cur.code, rates: rates.sort((a, b) => (a.from < b.from ? -1 : 1)) };
    }
  }
  return errors.length ? { ok: false, errors: errors.slice(0, 50) } : { ok: true, value: out };
}

// The settings in force. None saved means the defaults; a saved section that does not validate (a hand edit) also means
// the defaults, with `error` set so the status can say so.
function settingsOf(raw, { home = '' } = {}) {
  if (raw === undefined || raw === null) return { value: defaults(), error: null };
  const r = validate(raw, { home });
  return r.ok
    ? { value: r.value, error: null }
    : { value: defaults(), error: 'the saved cost settings are invalid, so the defaults apply' };
}

// Matchers for one settings object. Folders compare without case where the file system usually does (macOS, Windows).
function compile(settings, { nocase = process.platform === 'darwin' || process.platform === 'win32' } = {}) {
  const rules = settings.folderRules.map((r) => ({ re: globToRegExp(r.glob, { nocase }), center: r.center }));
  return {
    centerOf({ keyId, project }) {
      if (keyId && Object.hasOwn(settings.keyCenters, keyId)) return settings.keyCenters[keyId];
      if (project) for (const r of rules) if (r.re.test(project)) return r.center;
      return UNASSIGNED;
    },
    billingOf: (source) => settings.billing[source] || { mode: 'metered' },
  };
}

// A plan's fee for one day: the period's fee spread evenly over its days.
const planFee = (billing, day) =>
  billing.period === 'year' ? billing.feeUSD / daysInYear(day) : billing.feeUSD / daysInMonth(day);

// The latest rate whose `from` is on or before the day (rates are stored sorted), or null.
function rateFor(currency, day) {
  if (!currency || !Array.isArray(currency.rates)) return null;
  let hit = null;
  for (const r of currency.rates) if (r.from <= day) hit = r.perUSD;
  return hit;
}

module.exports = {
  SOURCES,
  UNASSIGNED,
  LIMITS,
  defaults,
  globToRegExp,
  globProblem,
  normalizeGlob,
  validate,
  settingsOf,
  compile,
  planFee,
  rateFor,
};
