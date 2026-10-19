// Provider analytics for the Quality & safety subpages, computed from the indexed request rows:
// utilization and capacity, prompt-cache efficiency, context compaction, and per-provider stats.
// Row layout: [ts, tool, sessionId, model, input, output, cacheRead, cacheWrite5m, cacheWrite1h, isSubagent].
const path = require('path');
const { makePricer } = require('./pricing');

const DAY = 86400000;
const HOUR = 3600000;
const MIN = 60000;
const PROVIDER = { claude: 'Anthropic', codex: 'OpenAI' };
const TOOLS = Object.keys(PROVIDER);

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const context = (e) => e[4] + e[6] + e[7] + e[8]; // tokens the model read on this request
const total = (e) => e[4] + e[5] + e[6] + e[7] + e[8];
const blankCache = () => ({
  requests: 0,
  input: 0,
  cacheRead: 0,
  cw5m: 0,
  cw1h: 0,
  warm: 0,
  cold: 0,
  uncached: 0,
  saved: 0,
  premium: 0,
});

// Least-squares slope of y over its index; used for the 7-day capacity forecast.
function trend(ys) {
  const n = ys.length;
  if (n < 2) return { slope: 0, next: ys[0] || 0 };
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  ys.forEach((y, i) => {
    num += (i - mx) * (y - my);
    den += (i - mx) ** 2;
  });
  const slope = den ? num / den : 0;
  return { slope, next: Math.max(0, my + slope * (n - mx)) };
}

function insights(results, { rangeDays, pricing, now = Date.now() }) {
  const pricer = makePricer(pricing);
  const price = (model) => {
    const k = Object.keys(pricing)
      .sort((a, b) => b.length - a.length)
      .find((p) => model.startsWith(p));
    return k ? pricing[k] : null;
  };
  const all = rangeDays === 'all';
  const rows = [];
  const projectOf = {};
  const compactEvents = [];
  const signalDays = []; // [tool, days] per log file, summed once the range start is known
  for (const r of results) {
    for (const e of r.events) rows.push(e);
    const tool = (r.events[0] && r.events[0][1]) || (Object.values(r.sessions || {})[0] || {}).tool;
    for (const [sid, s] of Object.entries(r.sessions || {}))
      projectOf[`${s.tool}:${sid}`] = path.basename(s.project || '') || 'unknown';
    if (!r.signals) continue;
    for (const ev of r.signals.events) if (ev.kind === 'compaction') compactEvents.push(ev);
    if (PROVIDER[tool]) signalDays.push([tool, r.signals.days]);
  }
  const start = all
    ? startOfDay(rows.reduce((m, e) => Math.min(m, e[0]), now))
    : startOfDay(now - (rangeDays - 1) * DAY);
  const inRange = rows.filter((e) => Number.isFinite(e[0]) && e[0] >= start && e[0] <= now).sort((a, b) => a[0] - b[0]);
  const signalsByTool = Object.fromEntries(TOOLS.map((t) => [t, { apiErrors: 0, refusals: 0, compactions: 0 }]));
  for (const [tool, daysOf] of signalDays) {
    for (const [day, d] of Object.entries(daysOf)) {
      if (Date.parse(day + 'T00:00:00') < start) continue;
      for (const k of ['apiErrors', 'refusals', 'compactions']) signalsByTool[tool][k] += d[k] || 0;
    }
  }

  /* ---------- utilization & capacity ---------- */
  const perMin = {};
  const hourly = Array.from({ length: 24 }, (_, i) => ({
    hour: now - (23 - i) * HOUR,
    claude: { calls: 0, tokens: 0 },
    codex: { calls: 0, tokens: 0 },
  }));
  const days = {};
  const hourOfDay = Array.from({ length: 24 }, () => ({ claude: 0, codex: 0 }));
  const conc = {};
  const activeHours = new Set();
  const byTool = Object.fromEntries(TOOLS.map((t) => [t, { calls: 0, tokens: 0 }]));
  for (const e of inRange) {
    const [ts, tool] = e;
    if (!byTool[tool]) continue;
    const tk = total(e);
    byTool[tool].calls++;
    byTool[tool].tokens += tk;
    const m = Math.floor(ts / MIN);
    const pm = (perMin[m] ||= { claude: { c: 0, t: 0 }, codex: { c: 0, t: 0 } });
    pm[tool].c++;
    pm[tool].t += tk;
    const hi = 23 - Math.floor((now - ts) / HOUR);
    if (hi >= 0 && hi < 24) {
      hourly[hi][tool].calls++;
      hourly[hi][tool].tokens += tk;
    }
    const dk = dayKey(ts);
    const d = (days[dk] ||= { claude: { calls: 0, tokens: 0 }, codex: { calls: 0, tokens: 0 } });
    d[tool].calls++;
    d[tool].tokens += tk;
    hourOfDay[new Date(ts).getHours()][tool]++;
    const b = Math.floor(ts / (10 * MIN));
    (conc[b] ||= new Set()).add(`${tool}:${e[2]}`);
    activeHours.add(Math.floor(ts / HOUR));
  }
  const daily = [];
  for (let t = start; t <= now; t += DAY) {
    const k = dayKey(t);
    daily.push({ date: k, ...(days[k] || { claude: { calls: 0, tokens: 0 }, codex: { calls: 0, tokens: 0 } }) });
  }
  const peaks = Object.fromEntries(
    TOOLS.map((t) => {
      let rpm = 0;
      let tpm = 0;
      let rpmAt = 0;
      for (const [m, v] of Object.entries(perMin)) {
        if (v[t].c > rpm) {
          rpm = v[t].c;
          rpmAt = m * MIN;
        }
        tpm = Math.max(tpm, v[t].t);
      }
      // Busiest rolling 5-hour window (plan limits reset on 5-hour windows) and the current one.
      const ev = inRange.filter((e) => e[1] === t);
      let lo = 0;
      let sum = 0;
      let max5h = 0;
      let max5hAt = 0;
      for (let hi = 0; hi < ev.length; hi++) {
        sum += total(ev[hi]);
        while (ev[hi][0] - ev[lo][0] > 5 * HOUR) sum -= total(ev[lo++]);
        if (sum > max5h) {
          max5h = sum;
          max5hAt = ev[lo][0];
        }
      }
      const cur5h = ev.filter((e) => now - e[0] <= 5 * HOUR).reduce((a, e) => a + total(e), 0);
      const cur7d = ev.filter((e) => now - e[0] <= 7 * DAY).reduce((a, e) => a + total(e), 0);
      const f = trend(daily.map((d) => d[t].tokens));
      return [
        t,
        {
          rpm,
          rpmAt,
          tpm,
          max5h,
          max5hAt,
          cur5h,
          cur7d,
          forecastDaily: f.next,
          slopePerDay: f.slope,
          next7d: Math.max(0, f.next * 7 + f.slope * 21),
        },
      ];
    }),
  );
  const concVals = Object.values(conc).map((s) => s.size);
  const concurrency = {
    peak: Math.max(0, ...concVals),
    avg: concVals.length ? concVals.reduce((a, b) => a + b, 0) / concVals.length : 0,
  };
  const utilization = {
    byTool,
    peaks,
    hourly,
    daily,
    hourOfDay,
    concurrency,
    activeHours: activeHours.size,
    callsPerActiveHour: activeHours.size ? inRange.length / activeHours.size : 0,
    busiestHour: hourOfDay.map((h, i) => [i, h.claude + h.codex]).sort((a, b) => b[1] - a[1])[0][0],
  };

  /* ---------- prompt cache ---------- */
  const cacheBy = { tool: {}, model: {} };
  const cacheDaily = {};
  const sessCache = {};
  for (const e of inRange) {
    const [ts, tool, sid, model] = e;
    const p = price(model);
    const saved = p ? (e[6] * (p.input - (p.cacheRead || 0))) / 1e6 : 0;
    const premium = p ? (e[7] * ((p.cacheWrite5m || 0) - p.input) + e[8] * ((p.cacheWrite1h || 0) - p.input)) / 1e6 : 0;
    const kind = e[6] > 0 ? 'warm' : e[7] + e[8] > 0 ? 'cold' : 'uncached';
    for (const [bucket, key] of [
      [cacheBy.tool, tool],
      [cacheBy.model, `${tool}|${model}`],
      [cacheDaily, dayKey(ts)],
      [sessCache, `${tool}:${sid}`],
    ]) {
      const c = (bucket[key] ||= blankCache());
      c.requests++;
      c.input += e[4];
      c.cacheRead += e[6];
      c.cw5m += e[7];
      c.cw1h += e[8];
      c[kind]++;
      c.saved += saved;
      c.premium += premium;
    }
  }
  const hit = (c) =>
    c.input + c.cacheRead + c.cw5m + c.cw1h ? c.cacheRead / (c.input + c.cacheRead + c.cw5m + c.cw1h) : 0;
  const withRate = (c, extra) => ({ ...c, ...extra, hitRate: hit(c), net: c.saved - c.premium });
  const sessions = Object.entries(sessCache)
    .filter(([, c]) => c.requests >= 10)
    .map(([k, c]) => withRate(c, { session: k, project: projectOf[k] || 'unknown', tool: k.split(':')[0] }));
  const cache = {
    totals: withRate(
      Object.values(cacheBy.tool).reduce((a, c) => {
        for (const k of Object.keys(a)) a[k] += c[k];
        return a;
      }, blankCache()),
    ),
    byTool: Object.fromEntries(Object.entries(cacheBy.tool).map(([k, c]) => [k, withRate(c)])),
    byModel: Object.entries(cacheBy.model)
      .map(([k, c]) => withRate(c, { tool: k.split('|')[0], model: k.split('|')[1] }))
      .sort((a, b) => b.cacheRead - a.cacheRead)
      .slice(0, 12),
    daily: daily.map((d) => ({
      date: d.date,
      ...(cacheDaily[d.date] ? withRate(cacheDaily[d.date]) : { ...blankCache(), hitRate: 0, net: 0 }),
    })),
    bestSessions: [...sessions].sort((a, b) => b.net - a.net).slice(0, 6),
    worstSessions: [...sessions].sort((a, b) => a.hitRate - b.hitRate).slice(0, 6),
  };

  /* ---------- context compaction ---------- */
  const bySession = {};
  for (const e of inRange) if (!e[9]) (bySession[`${e[1]}:${e[2]}`] ||= []).push(e);
  const compactions = [];
  for (const ev of compactEvents) {
    if (ev.ts < start || ev.ts > now) continue;
    const key = `${ev.tool || 'claude'}:${ev.sid}`;
    const list = bySession[key];
    if (!list) continue;
    const i = list.findIndex((e) => e[0] > ev.ts);
    const before = i === -1 ? list[list.length - 1] : list[Math.max(0, i - 1)];
    const after = i === -1 ? null : list[i];
    if (!before || !after) continue;
    const pre = context(before);
    const post = context(after);
    const saved = Math.max(0, pre - post);
    const nextCompaction = compactEvents
      .filter((x) => x.sid === ev.sid && x.ts > ev.ts)
      .reduce((m, x) => Math.min(m, x.ts), Infinity);
    const carried = list.slice(i).filter((e) => e[0] < nextCompaction).length;
    const p = price(after[3]);
    compactions.push({
      ts: ev.ts,
      tool: ev.tool || 'claude',
      project: projectOf[key] || 'unknown',
      model: after[3],
      pre,
      post,
      saved,
      carried,
      tokensAvoided: saved * carried,
      usdAvoided: p ? (saved * carried * (p.cacheRead || p.input)) / 1e6 : 0,
    });
  }
  compactions.sort((a, b) => b.ts - a.ts);
  const ctxBuckets = [
    [0, 50e3],
    [50e3, 100e3],
    [100e3, 200e3],
    [200e3, 400e3],
    [400e3, 700e3],
    [700e3, Infinity],
  ].map(([lo, hi]) => ({ lo, hi, requests: 0 }));
  let ctxMax = 0;
  let ctxSum = 0;
  for (const e of inRange) {
    const c = context(e);
    ctxMax = Math.max(ctxMax, c);
    ctxSum += c;
    const b = ctxBuckets.find((x) => c >= x.lo && c < x.hi);
    if (b) b.requests++;
  }
  const compDaily = daily.map((d) => ({
    date: d.date,
    count: compactions.filter((c) => dayKey(c.ts) === d.date).length,
    saved: compactions.filter((c) => dayKey(c.ts) === d.date).reduce((a, c) => a + c.saved, 0),
  }));
  const compression = {
    count: compactions.length,
    saved: compactions.reduce((a, c) => a + c.saved, 0),
    tokensAvoided: compactions.reduce((a, c) => a + c.tokensAvoided, 0),
    usdAvoided: compactions.reduce((a, c) => a + c.usdAvoided, 0),
    avgPre: compactions.length ? compactions.reduce((a, c) => a + c.pre, 0) / compactions.length : 0,
    avgRatio: compactions.length
      ? compactions.reduce((a, c) => a + (c.pre ? c.post / c.pre : 0), 0) / compactions.length
      : 0,
    recent: compactions.slice(0, 20),
    daily: compDaily,
    contextBuckets: ctxBuckets,
    contextMax: ctxMax,
    contextAvg: inRange.length ? ctxSum / inRange.length : 0,
  };

  /* ---------- provider stats ---------- */
  const prov = {};
  const models = {};
  for (const e of inRange) {
    const [ts, tool, sid, model] = e;
    const parts = pricer.parts(model, e[4], e[5], e[6], e[7], e[8]);
    const cost = parts.reduce((a, b) => a + b, 0);
    const p = (prov[tool] ||= {
      tool,
      provider: PROVIDER[tool] || tool,
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      sub: 0,
      sessions: new Set(),
      models: new Set(),
      days: new Set(),
      first: ts,
      last: ts,
    });
    p.requests++;
    p.input += e[4];
    p.output += e[5];
    p.cacheRead += e[6];
    p.cacheWrite += e[7] + e[8];
    p.cost += cost;
    if (e[9]) p.sub++;
    p.sessions.add(sid);
    p.models.add(model);
    p.days.add(dayKey(ts));
    p.first = Math.min(p.first, ts);
    p.last = Math.max(p.last, ts);
    const m = (models[`${tool}|${model}`] ||= {
      tool,
      provider: PROVIDER[tool] || tool,
      model,
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      priced: pricer.priced(model),
    });
    m.requests++;
    m.input += e[4];
    m.output += e[5];
    m.cacheRead += e[6];
    m.cacheWrite += e[7] + e[8];
    m.cost += cost;
  }
  const providers = {
    list: Object.values(prov).map((p) => ({
      ...p,
      sessions: p.sessions.size,
      models: p.models.size,
      days: p.days.size,
      ...signalsByTool[p.tool],
    })),
    models: Object.values(models).sort((a, b) => b.requests - a.requests),
  };

  return { generatedAt: now, range: { days: rangeDays, start, end: now }, utilization, cache, compression, providers };
}

module.exports = { insights, trend };
