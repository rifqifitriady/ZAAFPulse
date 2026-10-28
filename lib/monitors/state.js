// The monitor state machine, the alerts store and their persistence. The engine evaluates a rule (rules.js) and
// hands the results to `apply()`, which keeps one state per rule instance and returns only the alerts that are due:
// a change of state, or a reminder for an instance that stays triggered. Nothing here reads the clock but the
// injected `now`, and no alert carries transcript text (only the rule, numbers and an already masked title).
//
// Files (both mode 0600): `file` holds states, snoozes and the owner's per-rule settings as JSON, written through a
// temp file + rename; `alertsFile` is JSONL, appended to and compacted to the newest `maxAlerts` rows.
//
// Settings defaults depend on the app config (the monthly budget), so `config` is an injected getter, read on every
// `settings()` call, and `settings(ruleId)` keeps the one-argument shape. The owner changes settings only through
// `setSettings()`, which the routes call after checking the dashboard sign-in.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ruleById, isBudgetState } = require('./rules');
const { openJsonl } = require('../evals/store');

const MIN = 60e3;
const REALERT_MS = 30 * MIN;
const RESOLVE_HOLD_MS = 5 * MIN; // an instance must stay ok this long before its resolution is sent
const PRUNE_MS = 24 * 60 * MIN;
const DEFAULT_LIMIT = 100;
const MAX_TITLE = 80;
const STATES = new Set(['ok', 'triggered', 'no_data']);
const PERIOD_NAMES = new Set(['day', 'week', 'month']);
// A budget's states are its threshold levels (rules.js isBudgetState); every other rule keeps ok/triggered/no_data.
const stateOk = (rule, s) => s === null || s === undefined || (rule === 'budget' ? isBudgetState(s) : STATES.has(s));

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const orNull = (v) => (isNum(v) ? v : null);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const keyOf = (rule, instance) => `${rule}|${instance}`;
const ruleOf = (id) => ruleById(id);
const newId = () => crypto.randomBytes(8).toString('hex');

// `budget: false` for the paths of the fixed rules (apply, pending, setSettings): a budget has its own.
function needRule(id, { budget = true } = {}) {
  const rule = ruleOf(id);
  if (!rule || (!budget && rule.kind === 'budget')) throw badRequest(`Unknown rule: ${id}`);
  return rule;
}

// Temp file + rename, mode 0600: a crash leaves the old file intact, and a looser file from an older build is
// replaced by a tight one.
function writeJson(file, value) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  rmQuiet(tmp); // writeFileSync keeps the mode of a file that already exists
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    rmQuiet(tmp);
    throw e;
  }
}

function rmQuiet(target) {
  try {
    fs.unlinkSync(target);
  } catch {
    /* nothing there */
  }
}

// A saved entry is trusted only in shape: anything else is dropped rather than repaired.
function cleanEntry(e) {
  if (!isObj(e) || typeof e.rule !== 'string' || !ruleOf(e.rule) || typeof e.instance !== 'string') return null;
  if (!stateOk(e.rule, e.state)) return null;
  const out = {
    rule: e.rule,
    instance: e.instance,
    sessionId: typeof e.sessionId === 'string' ? e.sessionId : null,
    state: e.state || null,
    value: orNull(e.value),
    threshold: orNull(e.threshold),
    title: typeof e.title === 'string' ? e.title.slice(0, MAX_TITLE) : null,
    since: isNum(e.since) ? e.since : 0,
    lastSeen: isNum(e.lastSeen) ? e.lastSeen : 0,
    lastAlertTs: isNum(e.lastAlertTs) ? e.lastAlertTs : 0,
    open: e.open === true,
    okSince: isNum(e.okSince) ? e.okSince : 0,
    snoozed: e.snoozed === true,
    // When the engine acted on this trigger episode (an automatic pause), or 0. Saved, so a restart or a reminder
    // never acts twice on one episode; cleared when the episode resolves or starts afresh.
    actedAt: isNum(e.actedAt) ? e.actedAt : 0,
  };
  // A budget also keeps its period key (a new period resets it), whether the projection was passing, and whether its
  // last evaluation had no data; then the state it last announced and whether its projection was announced this
  // period, so a snooze defers an alert instead of losing it and a flapping projection alerts once.
  if (e.rule === 'budget') {
    const known = (v) => isBudgetState(v) && v !== 'no_data';
    Object.assign(out, {
      period: typeof e.period === 'string' ? e.period.slice(0, 40) : null,
      projected: e.projected === true,
      noData: e.noData === true,
      alerted: known(e.alerted) ? e.alerted : known(e.state) ? e.state : null,
      projectedAlerted: e.projectedAlerted === true || (e.projectedAlerted === undefined && e.projected === true),
    });
  }
  return out;
}

function cleanParams(rule, params) {
  const out = {};
  if (!isObj(params)) return out;
  for (const [k, v] of Object.entries(params)) if (hasOwn(rule.params, k) && isNum(v) && v >= 0) out[k] = v;
  return out;
}

function cleanSettings(rule, s) {
  const out = {};
  if (!isObj(s)) return out;
  if (typeof s.enabled === 'boolean') out.enabled = s.enabled;
  if (isObj(s.params)) out.params = cleanParams(rule, s.params);
  if (typeof s.autoPause === 'boolean') out.autoPause = s.autoPause;
  return out;
}

const numMap = (m) => {
  const out = {};
  if (isObj(m)) for (const [k, v] of Object.entries(m)) if (isNum(v)) out[k] = v;
  return out;
};

function createMonitorState({ file, alertsFile, now = Date.now, maxAlerts = 2000, config = () => ({}) }) {
  const io = openJsonl(alertsFile);
  let loaded = false;
  const entries = new Map(); // ruleId|instance -> entry
  const snoozes = { rules: {}, instances: {} }; // until (ms epoch)
  const stored = {}; // ruleId -> { enabled?, params?, autoPause? } the owner chose
  let alertRows = null; // oldest first
  let warned = false;
  let corrupt = false; // the state file could not be used; move it aside before the first write

  const warn = (what, e) => {
    if (warned) return;
    warned = true;
    console.warn(`monitors: could not ${what}: ${e.message}`);
  };

  function load() {
    if (loaded) return;
    loaded = true;
    let j = null;
    try {
      j = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // A missing file is the normal first start. Anything else is worth a warning, and the file is kept aside
      // before the first write so the owner's settings are not wiped silently.
      if (e && e.code !== 'ENOENT') {
        corrupt = true;
        console.warn(`monitors: could not read ${file}, starting empty: ${e.message}`);
      }
      return;
    }
    if (!isObj(j)) {
      corrupt = true;
      console.warn(`monitors: ${file} is not a monitor state file, starting empty`);
      return;
    }
    if (Array.isArray(j.states)) {
      for (const raw of j.states) {
        const e = cleanEntry(raw);
        if (e) entries.set(keyOf(e.rule, e.instance), e);
      }
    }
    if (isObj(j.snoozes)) {
      snoozes.rules = numMap(j.snoozes.rules);
      snoozes.instances = numMap(j.snoozes.instances);
    }
    if (isObj(j.settings)) {
      for (const [id, s] of Object.entries(j.settings)) {
        const rule = ruleOf(id);
        if (rule) stored[id] = cleanSettings(rule, s);
      }
    }
  }

  const snapshot = () => ({
    version: 1,
    states: [...entries.values()],
    snoozes,
    settings: stored,
  });

  function save() {
    if (corrupt) {
      corrupt = false;
      try {
        fs.renameSync(file, `${file}.corrupt-${now()}`);
      } catch {
        /* best effort: the write below replaces it */
      }
    }
    writeJson(file, snapshot());
  }

  // A change the owner made must reach the disk or fail loudly; `undo` puts the memory back.
  function saveStrict(undo) {
    try {
      save();
    } catch (e) {
      undo();
      throw e;
    }
  }

  function loadAlerts() {
    if (alertRows) return alertRows;
    alertRows = io.read().rows;
    if (alertRows.length > maxAlerts) {
      // Keep the newest rows, and bring the file down to match (best effort).
      alertRows.splice(0, alertRows.length - maxAlerts);
      try {
        io.rewrite(alertRows);
      } catch (e) {
        warn(`compact ${alertsFile}`, e);
      }
    }
    return alertRows;
  }

  // The active snooze end for an instance, or 0.
  function snoozeEnd(rule, instance, t) {
    const a = snoozes.rules[rule];
    const b = snoozes.instances[keyOf(rule, instance)];
    return Math.max(isNum(a) && a > t ? a : 0, isNum(b) && b > t ? b : 0);
  }

  function dropExpiredSnoozes(t) {
    for (const [k, until] of Object.entries(snoozes.rules)) if (until <= t) delete snoozes.rules[k];
    for (const [k, until] of Object.entries(snoozes.instances)) if (until <= t) delete snoozes.instances[k];
  }

  const fresh = (e) => {
    e.state = null;
    e.open = false;
    e.okSince = 0;
    e.lastAlertTs = 0;
    e.snoozed = false;
    // actedAt is kept: an instance still triggered when the snooze ends continues the same episode, so an agent the
    // owner resumed meanwhile is not paused again. Only a resolution (held, as below) ends the episode.
  };

  // The auto-pause mark of an instance whose alert is not open (snoozed, or after a snooze ended): it ends once the
  // instance has stayed ok for the resolution hold, the same as a sent resolution would end it.
  function settleMark(e, state, t) {
    if (!e.actedAt) return false;
    if (state !== 'ok') {
      if (!e.okSince) return false;
      e.okSince = 0;
      return true;
    }
    if (!e.okSince) e.okSince = t;
    if (t - e.okSince >= RESOLVE_HOLD_MS) {
      e.actedAt = 0;
      e.okSince = 0;
    }
    return true;
  }

  function apply(ruleId, results) {
    const def = needRule(ruleId, { budget: false });
    load();
    const t = now();
    if (!isNum(t) || !Array.isArray(results)) return [];
    // A live rule that could not list its sessions answers with one 'all' no_data. That says nothing about the
    // sessions it had before, so it must not resolve, prune or touch any of them.
    const [first] = results;
    const onlyAll = results.length === 1 && isObj(first) && first.instance === 'all' && first.state === 'no_data';
    const noInfo = results.length === 0 || onlyAll;
    if (def.kind === 'live' && noInfo) return [];

    const out = [];
    let dirty = false;
    // A cost anomaly that read its figures again leaves the 'all' no_data of an earlier failed read: the days speak.
    if (ruleId === 'cost_anomaly' && results.some((r) => isObj(r) && r.instance !== 'all'))
      if (entries.delete(keyOf(ruleId, 'all'))) dirty = true;
    for (const r of results) {
      if (!isObj(r) || typeof r.instance !== 'string' || !STATES.has(r.state)) continue;
      const key = keyOf(ruleId, r.instance);
      let e = entries.get(key);
      if (!e) {
        e = cleanEntry({ rule: ruleId, instance: r.instance, state: null });
        entries.set(key, e);
        dirty = true;
      }
      e.sessionId = typeof r.sessionId === 'string' ? r.sessionId : null;
      e.value = orNull(r.value);
      e.threshold = orNull(r.threshold);
      e.title = typeof r.title === 'string' && r.title ? r.title.slice(0, MAX_TITLE) : null;
      e.lastSeen = t;

      const snoozed = snoozeEnd(ruleId, r.instance, t) > 0;
      if (snoozed) {
        // Track quietly; the state is reported as snoozed and the instance starts afresh when the snooze ends.
        if (e.state !== r.state || !e.snoozed) dirty = true;
        e.state = r.state;
        e.snoozed = true;
        if (settleMark(e, r.state, t)) dirty = true;
        continue;
      }
      if (e.snoozed) {
        // A rule without reminders keeps an alert it sent before the snooze, and sends one it held back (once).
        if (def.remind === false) {
          e.snoozed = false;
          e.okSince = 0; // an ok seen before or inside the snooze does not count toward the resolution hold
          if (!e.open) e.state = null;
        } else fresh(e);
        dirty = true;
      }

      const prev = e.state;
      const next = r.state;
      // A rule without reminders (cost_anomaly: one alert per day of spend) alerts on a change of state only.
      const spaced = t - e.lastAlertTs >= REALERT_MS && def.remind !== false;
      let raise = false;
      let previous = prev;
      const okSince = e.okSince;
      if (next === 'triggered') {
        e.okSince = 0;
        if (prev === 'triggered') raise = spaced;
        // Back before the resolution was sent: the original alert is still open, so only its reminder applies.
        else if (e.open && prev === 'ok') {
          raise = spaced;
          previous = 'triggered';
        }
        // A source that flaps between triggered and no_data must not alert on each return.
        else raise = !(prev === 'no_data' && e.open && !spaced);
      } else if (next === 'ok') {
        // The resolution waits until the instance has stayed ok for a while, so a value hovering at its threshold
        // does not produce a trigger and a resolution on every evaluation.
        if (e.open) {
          if (!e.okSince) e.okSince = t;
          raise = t - e.okSince >= RESOLVE_HOLD_MS;
          previous = 'triggered';
        } else if (settleMark(e, next, t)) dirty = true;
      } else {
        e.okSince = 0;
      }
      if (e.okSince !== okSince) dirty = true;
      if (prev !== next) {
        e.state = next;
        e.since = t;
        dirty = true;
      }
      if (!raise) continue;
      e.open = next === 'triggered';
      // The episode ends with its resolution. A trigger that reopens the alert keeps a mark that no resolution ended
      // (the instance stayed triggered through a snooze); a reminder keeps it too.
      if (!e.open) e.actedAt = 0;
      e.okSince = 0;
      e.lastAlertTs = t;
      dirty = true;
      const alert = {
        id: newId(),
        ts: t,
        rule: ruleId,
        instance: r.instance,
        sessionId: e.sessionId,
        state: next,
        previous,
        value: e.value,
        threshold: e.threshold,
      };
      if (e.title) alert.title = e.title;
      if (isNum(r.usual)) alert.usual = r.usual; // a cost anomaly's usual amount, for the bell's line
      out.push(alert);
    }

    // Sessions that went away are forgotten a day after they were last seen, not resolved on the spot.
    for (const [k, e] of entries) {
      // A budget leaves with its budget (applyBudgets), never by age.
      if (e.rule !== 'budget' && t - e.lastSeen > PRUNE_MS) {
        // An unexpired snooze outlives the entry, so the session is still snoozed if it comes back.
        entries.delete(k);
        dirty = true;
      }
    }
    dropExpiredSnoozes(t);

    // Alerts first, state second: a crash in between repeats an alert rather than losing one. A disk problem never
    // stops an alert from being returned for sending.
    if (out.length) record(out);
    if (dirty) {
      try {
        save();
      } catch (e) {
        warn(`save ${file}`, e);
      }
    }
    return out;
  }

  function record(alerts) {
    const rows = loadAlerts();
    for (const a of alerts) {
      rows.push(a);
      try {
        io.append(a);
      } catch (e) {
        warn(`write ${alertsFile}`, e);
      }
    }
    if (rows.length > maxAlerts) {
      rows.splice(0, rows.length - maxAlerts);
      try {
        io.rewrite(rows);
      } catch (e) {
        warn(`compact ${alertsFile}`, e);
      }
    }
  }

  // A row the engine adds next to the alerts for what it did about one, such as an automatic pause. It has no state
  // or previous (it is not a change of state), only `action`, `ok`, a short fixed reason and a `code` for it; never
  // text from a log.
  function note({ rule, instance, sessionId, value, threshold, title, action, ok, code, reason } = {}) {
    needRule(rule);
    load();
    const t = now();
    if (!isNum(t) || typeof instance !== 'string' || typeof action !== 'string') return null;
    const row = {
      id: newId(),
      ts: t,
      rule,
      instance,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      value: orNull(value),
      threshold: orNull(threshold),
      action,
      ok: ok === true,
      code: typeof code === 'string' ? code.slice(0, 32) : null,
      reason: typeof reason === 'string' ? reason.slice(0, 200) : null,
    };
    if (typeof title === 'string' && title) row.title = title.slice(0, MAX_TITLE);
    record([row]);
    return { ...row };
  }

  // Instances of a rule whose trigger episode is open and not yet acted on: triggered, its alert sent, not snoozed.
  function pending(ruleId) {
    needRule(ruleId, { budget: false });
    load();
    const t = now();
    if (!isNum(t)) return [];
    const out = [];
    for (const e of entries.values()) {
      if (e.rule !== ruleId || e.state !== 'triggered' || !e.open || e.actedAt || e.snoozed) continue;
      if (snoozeEnd(e.rule, e.instance, t) > 0) continue;
      out.push({
        instance: e.instance,
        sessionId: e.sessionId,
        value: e.value,
        threshold: e.threshold,
        title: e.title,
        since: e.since,
      });
    }
    return out;
  }

  // Budgets (rule `budget`, one instance per budget id) have no reminder and no resolution hold. An alert goes out
  // when the threshold state differs from the one last announced (ok, warn_<n>, exceeded; either way), and the first
  // time in a period the projection passes the amount. A snooze only defers: the state is tracked quietly, and the
  // first pass after it ends announces the current state once if it differs from the last one announced. A new period
  // starts at ok without an alert and ends the pause mark, so a budget pauses at most once per period. no_data keeps
  // the last known state and alerts neither way: a file that fails to read for a minute is not news. With `retire`
  // (the saved list read in full) a budget no longer listed loses its state and its snooze.
  function applyBudgets(results, { retire = true } = {}) {
    load();
    const t = now();
    if (!isNum(t) || !Array.isArray(results)) return [];
    const out = [];
    const seen = new Set();
    let dirty = false;
    for (const r of results) {
      if (!isObj(r) || typeof r.instance !== 'string' || !r.instance) continue;
      seen.add(r.instance); // listed, even when this result is not usable: retire keeps it
      if (!isBudgetState(r.state) || typeof r.periodKey !== 'string' || !r.periodKey) continue;
      const key = keyOf('budget', r.instance);
      let e = entries.get(key);
      if (!e) {
        e = cleanEntry({ rule: 'budget', instance: r.instance, state: null });
        entries.set(key, e);
        dirty = true;
      }
      e.value = orNull(r.value);
      e.threshold = orNull(r.threshold);
      e.title = typeof r.title === 'string' && r.title ? r.title.slice(0, MAX_TITLE) : null;
      e.lastSeen = t;
      // Snoozed: tracked quietly, as for every rule. The flag follows the snooze, so an ended one never blocks a pause.
      const snoozed = snoozeEnd('budget', r.instance, t) > 0;
      if (e.snoozed !== snoozed) {
        e.snoozed = snoozed;
        dirty = true;
      }
      if (e.period !== r.periodKey) {
        e.period = r.periodKey;
        e.state = 'ok';
        e.alerted = 'ok';
        e.projected = false;
        e.projectedAlerted = false;
        e.actedAt = 0;
        e.since = t;
        dirty = true;
      }
      if (r.state === 'no_data') {
        if (!e.noData) dirty = true;
        e.noData = true;
        continue;
      }
      if (e.noData) dirty = true;
      e.noData = false;
      const prev = e.alerted || 'ok';
      const projected = r.projected === true && r.state !== 'exceeded';
      if (e.state !== r.state) {
        e.state = r.state;
        e.since = t;
        dirty = true;
      }
      if (e.projected !== projected) {
        e.projected = projected; // the live value; the alert below goes once per period
        dirty = true;
      }
      if (snoozed || !(prev !== r.state || (projected && !e.projectedAlerted))) continue;
      e.alerted = r.state;
      if (projected) e.projectedAlerted = true;
      e.lastAlertTs = t;
      const alert = {
        id: newId(),
        ts: t,
        rule: 'budget',
        instance: r.instance,
        sessionId: null,
        state: r.state,
        previous: prev,
        value: e.value,
        threshold: e.threshold,
        period: PERIOD_NAMES.has(r.period) ? r.period : null,
        projected,
      };
      if (e.title) alert.title = e.title;
      out.push(alert);
    }
    if (retire)
      for (const [k, e] of entries)
        if (e.rule === 'budget' && !seen.has(e.instance)) {
          entries.delete(k);
          delete snoozes.instances[k];
          dirty = true;
        }
    dropExpiredSnoozes(t);
    // Alerts first, state second, as in apply().
    if (out.length) record(out);
    if (dirty) {
      try {
        save();
      } catch (err) {
        warn(`save ${file}`, err);
      }
    }
    return out;
  }

  // Exceeded budgets with data, not acted on this period and not snoozed: what the engine may pause for.
  function pendingBudgets() {
    load();
    const t = now();
    if (!isNum(t)) return [];
    const out = [];
    for (const e of entries.values()) {
      if (e.rule !== 'budget' || e.state !== 'exceeded' || e.noData || e.actedAt || e.snoozed) continue;
      if (snoozeEnd('budget', e.instance, t) > 0) continue;
      out.push({
        instance: e.instance,
        sessionId: null,
        value: e.value,
        threshold: e.threshold,
        title: e.title,
        since: e.since,
      });
    }
    return out;
  }

  // Mark the open episode as acted on, before the action starts. False when there is nothing to mark or it was
  // marked already, so two passes never act on one episode. The mark is saved with the states (0600, temp + rename).
  // `expect.period`: a budget's period key when its pause was chosen; a different stored period is not acted on.
  function markActed(ruleId, instance, expect = {}) {
    needRule(ruleId);
    load();
    const t = now();
    const e = entries.get(keyOf(ruleId, instance));
    const due = !!e && (e.rule === 'budget' ? e.state === 'exceeded' && !e.noData : e.state === 'triggered' && e.open);
    if (!isNum(t) || !due || e.actedAt) return false;
    if (e.rule === 'budget' && expect && typeof expect.period === 'string' && e.period !== expect.period) return false;
    e.actedAt = t;
    try {
      save();
    } catch (err) {
      warn(`save ${file}`, err);
    }
    return true;
  }

  function snooze(ruleId, instance, ms) {
    needRule(ruleId);
    if (instance !== null && instance !== undefined && typeof instance !== 'string') {
      throw badRequest('instance must be text or null');
    }
    if (!isNum(ms) || ms < 0) throw badRequest('ms must be a number of milliseconds, or 0 to clear the snooze');
    load();
    const t = now();
    const map = instance === null || instance === undefined ? snoozes.rules : snoozes.instances;
    const k = instance === null || instance === undefined ? ruleId : keyOf(ruleId, instance);
    const had = hasOwn(map, k) ? map[k] : undefined;
    const flags = [...entries.values()].map((e) => [e, e.snoozed]);
    if (ms === 0) delete map[k];
    else {
      map[k] = t + ms;
      // Remember that these were snoozed, so they start afresh when it ends even if nothing was applied meanwhile.
      for (const e of entries.values()) {
        if (e.rule === ruleId && (k === ruleId || e.instance === instance)) e.snoozed = true;
      }
    }
    saveStrict(() => {
      if (had === undefined) delete map[k];
      else map[k] = had;
      for (const [e, flag] of flags) e.snoozed = flag;
    });
  }

  function states() {
    load();
    const t = now();
    return [...entries.values()]
      .map((e) => {
        const until = snoozeEnd(e.rule, e.instance, t);
        return {
          rule: e.rule,
          instance: e.instance,
          sessionId: e.sessionId,
          state: until ? 'snoozed' : e.state,
          value: e.value,
          threshold: e.threshold,
          title: e.title,
          since: e.since,
          lastSeen: e.lastSeen,
          lastAlertTs: e.lastAlertTs,
          snoozeUntil: until || null,
        };
      })
      .sort((a, b) => cmp(a.rule, b.rule) || cmp(a.instance, b.instance));
  }

  // When a snooze of the whole rule ends (ms epoch), or null: an instance's own snooze shows in states().
  function ruleSnooze(ruleId) {
    needRule(ruleId);
    load();
    const until = snoozes.rules[ruleId];
    return isNum(until) && until > now() ? until : null;
  }

  // Newest first. `since` keeps alerts strictly newer than that time.
  function alerts({ since, limit } = {}) {
    const rows = loadAlerts();
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, maxAlerts) : DEFAULT_LIMIT;
    const out = [];
    for (let i = rows.length - 1; i >= 0 && out.length < n; i--) {
      if (isNum(since) && !(rows[i].ts > since)) continue;
      out.push({ ...rows[i] });
    }
    return out;
  }

  function settings(ruleId) {
    const def = needRule(ruleId);
    load();
    const s = stored[ruleId] || {};
    let enabled = s.enabled;
    if (typeof enabled !== 'boolean') {
      try {
        enabled = !!def.defaultOn(config() || {});
      } catch {
        enabled = false;
      }
    }
    return { enabled, params: { ...(s.params || {}) }, autoPause: def.mayAutoPause && s.autoPause === true };
  }

  function setSettings(ruleId, input) {
    const def = needRule(ruleId, { budget: false });
    if (!isObj(input)) throw badRequest('settings must be an object');
    load();
    const next = { ...(stored[ruleId] || {}) };
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw badRequest('enabled must be true or false');
      next.enabled = input.enabled;
    }
    if (input.params !== undefined) {
      if (!isObj(input.params)) throw badRequest('params must be an object');
      const params = {};
      for (const [k, v] of Object.entries(input.params)) {
        if (!hasOwn(def.params, k)) throw badRequest(`Unknown parameter: ${k}`);
        if (v === null) continue; // back to the rule's default
        if (!isNum(v) || v < 0) throw badRequest(`${k} must be a number of zero or more`);
        params[k] = v;
      }
      next.params = params;
    }
    if (input.autoPause !== undefined) {
      if (typeof input.autoPause !== 'boolean') throw badRequest('autoPause must be true or false');
      if (input.autoPause && !def.mayAutoPause) throw badRequest(`${ruleId} cannot pause an agent`);
      next.autoPause = input.autoPause;
    }
    const old = stored[ruleId];
    stored[ruleId] = next;
    saveStrict(() => {
      if (old === undefined) delete stored[ruleId];
      else stored[ruleId] = old;
    });
    return settings(ruleId);
  }

  return {
    apply,
    note,
    pending,
    applyBudgets,
    pendingBudgets,
    markActed,
    snooze,
    ruleSnooze,
    states,
    alerts,
    settings,
    setSettings,
  };
}

module.exports = { createMonitorState };
