'use strict';
/* Quality & safety subpages: Utilization, Cache, Compression and Provider stats. Local analytics come
   from /api/insights (the indexed request rows); the OmniRoute router adds its own view via /api/router. */

const PROV_COLOR = { claude: '#6d7cff', codex: '#ff8a4c' };
const PROV_NAME = { claude: 'Anthropic · Claude Code', codex: 'OpenAI · Codex' };
const provSeries = (get) => [
  { name: 'Anthropic', color: PROV_COLOR.claude, get: (r) => get(r, 'claude') },
  { name: 'OpenAI', color: PROV_COLOR.codex, get: (r) => get(r, 'codex') },
];
const hourLabel = (ts) => `${String(new Date(ts).getHours()).padStart(2, '0')}:00`;
const QUALITY_COPY = {
  utilization: ['Utilization', 'Provider utilization metrics and capacity planning'],
  cache: ['Cache', 'Monitor provider prompt cache efficiency and local semantic response reuse.'],
  compression: ['Compression', 'Context compression analytics and token savings'],
  providers: ['Provider stats', 'Requests, tokens, cost, latency and reliability per provider and model.'],
  models: ['Models', 'Every model on OpenRouter: live prices, which providers serve it and how reliably.'],
  rankings: ['Rankings', 'What the world runs on OpenRouter: most-used models and apps, and benchmark leaders.'],
};

function viewQualityPage() {
  if (!state.sub || !QUALITY_COPY[state.sub])
    return `<div class="holo-deck">${subTabs('quality')}${viewQuality()}</div>`;
  const [title, copy] = QUALITY_COPY[state.sub];
  return `<div class="holo-deck">${subTabs('quality')}
    ${subHero(`QUALITY &amp; SAFETY · ${title.toUpperCase()}`, title, copy, ['models', 'rankings'].includes(state.sub) ? '<span class="pill">Source: OpenRouter</span>' : rangeControl())}
    <div id="qp-body">${'<div class="skeleton" style="height:140px"></div>'.repeat(2)}</div></div>`;
}

async function mountQualityPage() {
  if (!state.sub || !QUALITY_COPY[state.sub]) {
    mountFailureCity();
    return;
  }
  if (state.sub === 'models' || state.sub === 'rankings') {
    mountOpenRouterPage(state.sub);
    return;
  }
  const sub = state.sub;
  const routerSection = {
    utilization: 'utilization',
    cache: 'cache',
    compression: 'compression',
    providers: 'providers',
  }[sub];
  const [ins, router, logs] = await Promise.all([
    api(`/api/insights?range=${state.range}`),
    api(`/api/router?section=${routerSection}`).catch(() => ({ configured: false })),
    sub === 'providers' ? api('/api/logs').catch(() => null) : null,
  ]);
  const el = $('#qp-body');
  if (!el || state.sub !== sub) return; // navigated away while loading
  el.innerHTML = {
    utilization: utilizationBody,
    cache: cacheBody,
    compression: compressionBody,
    providers: providersBody,
  }[sub](ins, router, logs);
  if (sub === 'utilization') mountLoadLandscape();
  if (sub === 'providers') {
    mountProviderSkyline(ins.providers);
    appendProviderDirectory();
  }
}

const routerNote = (router) =>
  router.configured
    ? router.data && router.data.error
      ? holoEmpty(`OmniRoute (${esc(router.id)}) did not answer: ${esc(router.data.error)}`)
      : ''
    : holoEmpty('No OmniRoute router is configured. Add one under Integrations to see router-side metrics here.');

/* ---------- Utilization ---------- */
function utilizationBody(ins, router) {
  const u = ins.utilization;
  const P = u.peaks;
  const c = P.claude;
  const x = P.codex;
  const lim = state.data && state.data.codexLimits;
  const dTok = u.daily.map((d) => d.claude.tokens + d.codex.tokens);
  const hod = u.hourOfDay.map((h) => h.claude + h.codex);
  const tiles = [
    metricTile({
      spark: u.hourly.map((h) => h.claude.calls),
      label: 'Peak RPM · Anthropic',
      value: whole.format(c.rpm),
      sub: c.rpmAt ? `requests/min · ${fmtDate(c.rpmAt)}` : 'no requests',
      color: PROV_COLOR.claude,
    }),
    metricTile({
      spark: u.hourly.map((h) => h.codex.calls),
      label: 'Peak RPM · OpenAI',
      value: whole.format(x.rpm),
      sub: x.rpmAt ? `requests/min · ${fmtDate(x.rpmAt)}` : 'no requests',
      color: PROV_COLOR.codex,
    }),
    metricTile({
      spark: u.hourly.map((h) => h.claude.tokens + h.codex.tokens),
      label: 'Peak TPM',
      value: fmtN(Math.max(c.tpm, x.tpm)),
      sub: 'tokens in one minute',
      color: HOLO.violet,
    }),
    metricTile({
      spark: dTok,
      label: 'Busiest 5h window',
      value: fmtN(c.max5h + x.max5h),
      sub: c.max5hAt ? `from ${fmtDate(c.max5hAt)}` : '—',
      color: HOLO.pink,
    }),
    metricTile({
      spark: dTok.slice(-7),
      label: 'Current 5h window',
      value: fmtN(c.cur5h + x.cur5h),
      sub: `${pct((c.cur5h + x.cur5h) / Math.max(1, c.max5h + x.max5h))} of the busiest`,
      color: HOLO.pink,
      p: (c.cur5h + x.cur5h) / Math.max(1, c.max5h + x.max5h),
    }),
    metricTile({
      spark: dTok.slice(-7),
      label: 'Last 7 days',
      value: fmtN(c.cur7d + x.cur7d),
      sub: 'tokens',
      color: HOLO.cyan,
    }),
    metricTile({
      spark: dTok,
      label: 'Forecast · next 7d',
      value: fmtN(c.next7d + x.next7d),
      sub: `${c.slopePerDay + x.slopePerDay >= 0 ? '↑' : '↓'} ${fmtN(Math.abs(c.slopePerDay + x.slopePerDay))} tokens/day trend`,
      color: HOLO.cyan,
    }),
    metricTile({
      label: 'Peak concurrency',
      value: String(u.concurrency.peak),
      sub: 'sessions in one 10-min slot',
      color: HOLO.orange,
    }),
    metricTile({
      label: 'Avg concurrency',
      value: u.concurrency.avg.toFixed(1),
      sub: 'when anything is active',
      color: HOLO.orange,
    }),
    metricTile({
      spark: hod,
      label: 'Active hours',
      value: whole.format(u.activeHours),
      sub: rangeText(),
      color: HOLO.blue,
    }),
    metricTile({
      spark: hod,
      label: 'Calls / active hour',
      value: u.callsPerActiveHour.toFixed(0),
      sub: 'model requests',
      color: HOLO.blue,
    }),
    metricTile({
      spark: hod,
      label: 'Busiest hour',
      value: `${String(u.busiestHour).padStart(2, '0')}:00`,
      sub: 'most requests by hour of day',
      color: HOLO.violet,
    }),
  ];
  const daily = u.daily.map((d) => ({ ...d }));
  const fc = (t) => Math.max(0, P[t].forecastDaily);
  const ghost = daily.length;
  const last = daily.length ? Date.parse(daily[daily.length - 1].date + 'T00:00:00') : Date.now();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(last + i * 86400000);
    daily.push({
      date: d.toISOString().slice(0, 10),
      claude: { tokens: fc('claude') + P.claude.slopePerDay * i },
      codex: { tokens: fc('codex') + P.codex.slopePerDay * i },
    });
  }
  const headroom = meters([
    {
      label: 'Anthropic · current 5h vs busiest',
      value: c.cur5h,
      max: c.max5h,
      color: PROV_COLOR.claude,
      right: `${fmtN(c.cur5h)} / ${fmtN(c.max5h)}`,
    },
    {
      label: 'OpenAI · current 5h vs busiest',
      value: x.cur5h,
      max: x.max5h,
      color: PROV_COLOR.codex,
      right: `${fmtN(x.cur5h)} / ${fmtN(x.max5h)}`,
    },
    ...(lim
      ? [lim.primary, lim.secondary].filter(Boolean).map((w) => ({
          label: `Codex plan · ${w.window_minutes >= 1440 ? `${Math.round(w.window_minutes / 1440)}-day` : `${Math.round(w.window_minutes / 60)}-hour`} window`,
          value: w.used_percent,
          max: 100,
          color: w.used_percent > 80 ? '#ff4f6d' : HOLO.orange,
          right: `${w.used_percent.toFixed(0)}% used`,
        }))
      : []),
  ]);
  let routerQuota = routerNote(router);
  if (router.configured && router.data && !router.data.error) {
    const byProv = {};
    for (const p of router.data.data || []) (byProv[p.provider] ||= []).push(p);
    routerQuota = Object.keys(byProv).length
      ? Object.entries(byProv)
          .map(([p, pts]) => {
            const lastPt = pts[pts.length - 1];
            return `<div class="hmeter"><div class="hmeter-top"><span>${esc(p)} · quota remaining${lastPt.isExhausted ? ' · <b style="color:#ff4f6d">exhausted</b>' : ''}</span><b class="num">${lastPt.remainingPct}%</b></div>
        ${holoLine(pts, { series: [{ name: 'remaining', color: lastPt.remainingPct < 20 ? '#ff4f6d' : HOLO.cyan, get: (r) => r.remainingPct }], label: (r) => r.timestamp.slice(11, 16), fmt: (v) => `${Math.round(v)}%`, max: 100, height: 120 })}</div>`;
          })
          .join('')
      : holoEmpty('OmniRoute has no quota readings in the last 24 hours.');
  }
  const plan = `<table class="holo-table"><thead><tr><th>Provider</th><th class="r">Peak RPM</th><th class="r">Peak TPM</th><th class="r">Busiest 5h</th><th class="r">Current 5h</th><th class="r">Last 7d</th><th class="r">Next 7d</th><th class="r">Trend / day</th></tr></thead><tbody>
    ${['claude', 'codex']
      .map(
        (
          t,
        ) => `<tr><td><span class="tool-dot" style="background:${PROV_COLOR[t]}"></span><b>${PROV_NAME[t]}</b></td><td class="r num">${P[t].rpm}</td><td class="r num">${fmtN(P[t].tpm)}</td>
      <td class="r num">${fmtN(P[t].max5h)}</td><td class="r num">${fmtN(P[t].cur5h)}</td><td class="r num">${fmtN(P[t].cur7d)}</td><td class="r num">${fmtN(P[t].next7d)}</td>
      <td class="r num" style="color:${P[t].slopePerDay >= 0 ? '#5cf0a8' : '#ff8aa3'}">${P[t].slopePerDay >= 0 ? '+' : '−'}${fmtN(Math.abs(P[t].slopePerDay))}</td></tr>`,
      )
      .join('')}</tbody></table>`;
  return `<section class="holo stage landscape-stage"><canvas id="qp-landscape" aria-label="3D landscape of model calls by weekday and hour"></canvas>
      <div class="stage-tl"><div class="holo-kicker">LOAD LANDSCAPE · WEEKDAY × HOUR</div><div class="stage-key">Each column is one hour of one weekday; height = model calls in the ${rangeText()} · hover a column</div></div></section>
    <div class="live-metrics">${tiles.join('')}</div>
    <div class="live-grid even">
      ${panel('Last 24 hours', 'model requests per hour', holoBars(u.hourly, { series: provSeries((r, t) => r[t].calls), label: (r) => hourLabel(r.hour), every: 3 }))}
      ${panel('Daily tokens + 7-day forecast', 'dashed = linear trend', holoBars(daily, { series: provSeries((r, t) => r[t].tokens), label: (r) => dayLabel(r.date), ghostFrom: ghost }))}
    </div>
    <div class="live-grid even">
      ${panel('Capacity headroom', 'rolling windows and plan limits', headroom)}
      ${panel('OmniRoute quota', router.configured ? esc(router.id) : 'router', routerQuota)}
    </div>
    ${panel('Capacity planning', rangeText(), `<div class="table-wrap">${plan}</div>`)}`;
}

// Weekday × hour columns from the summary heatmap, as an isometric landscape.
function mountLoadLandscape() {
  const canvas = $('#qp-landscape');
  if (!canvas || !state.data) return;
  const h = state.data.heatmap;
  const max = Math.max(1, ...h.flat());
  const days = [
    [1, 'Mon'],
    [2, 'Tue'],
    [3, 'Wed'],
    [4, 'Thu'],
    [5, 'Fri'],
    [6, 'Sat'],
    [0, 'Sun'],
  ];
  const heights = {};
  let tip = '';
  isoStage(canvas, {
    fit: [13, 8],
    origin: [0.5, 0.6],
    draw(g) {
      const { P, ctx, still } = g;
      g.glow();
      g.platform(-6, 6, -2.4, 2.4);
      const items = [];
      const tops = [];
      days.forEach(([di, label], row) => {
        for (let hr = 0; hr < 24; hr++) {
          const v = h[di][hr];
          const x = -5.8 + hr * 0.485;
          const z = -2.2 + row * 0.63;
          const key = `${di}:${hr}`;
          const target = v ? 0.05 + 3 * (v / max) : 0.02;
          heights[key] = (heights[key] ?? 0.02) + (target - (heights[key] ?? 0.02)) * (still ? 1 : 0.08);
          const ratio = v / max;
          const color = ratio > 0.66 ? '#ff5ca8' : ratio > 0.33 ? '#9d5cff' : ratio > 0 ? '#5b8cff' : '#2a2f78';
          items.push({
            depth: P(x, 0, z)[2],
            draw: () =>
              g.box(x, z, 0.36, 0.42, heights[key], color, {
                slices: 0,
                glow: ratio > 0.66 ? 14 : 0,
                alpha: v ? 1 : 0.5,
              }),
          });
          tops.push({
            at: P(x + 0.18, heights[key], z + 0.21),
            text: `${label} ${String(hr).padStart(2, '0')}:00 · ${whole.format(v)} calls`,
          });
        }
        const q = P(-6.3, 0, -2.2 + row * 0.63 + 0.2);
        ctx.fillStyle = HOLO.muted;
        ctx.font = '10.5px system-ui, sans-serif';
        ctx.fillText(label, q[0] - 26, q[1] + 4);
      });
      items.sort((a, b) => a.depth - b.depth).forEach((it) => it.draw());
      for (const hr of [0, 6, 12, 18]) {
        const q = P(-5.8 + hr * 0.485 + 0.18, 0, 2.55);
        ctx.fillStyle = HOLO.muted;
        ctx.fillText(`${String(hr).padStart(2, '0')}:00`, q[0] - 14, q[1] + 12);
      }
      g.particles();
      const p = g.pointer;
      let hit = null;
      if (p)
        for (const t of tops) {
          const d = Math.hypot(t.at[0] - p.x, t.at[1] - p.y);
          if (d < 10 && (!hit || d < hit.d)) hit = { ...t, d };
        }
      if (hit) {
        const key = `${hit.text}|${p.cx}|${p.cy}`;
        if (key !== tip) showTip({ clientX: p.cx, clientY: p.cy }, esc(hit.text));
        tip = key;
      } else if (tip) {
        hideTip();
        tip = '';
      }
    },
  });
}

/* ---------- Cache ---------- */
function cacheBody(ins, router) {
  const c = ins.cache;
  const t = c.totals;
  const bt = c.byTool;
  const writes = t.cw5m + t.cw1h;
  const loops = state.data ? state.data.quality.reliability.loops : 0;
  const rd = router.configured && router.data && !router.data.error ? router.data : null;
  const memo = rd && rd.memo;
  const tiles = [
    metricTile({
      spark: c.daily.map((d) => d.hitRate),
      label: 'Cache hit rate',
      value: pct(t.hitRate),
      sub: 'cache reads ÷ all input',
      color: HOLO.cyan,
      p: t.hitRate,
    }),
    metricTile({
      spark: c.daily.map((d) => d.cacheRead),
      label: 'Tokens from cache',
      value: fmtN(t.cacheRead),
      sub: `${fmtN(t.input)} uncached input`,
      color: HOLO.cyan,
    }),
    metricTile({
      spark: c.daily.map((d) => d.saved),
      label: 'Saved by cache',
      value: fmtUSD(t.saved),
      sub: 'vs. paying full input price',
      color: '#5cf0a8',
    }),
    metricTile({
      spark: c.daily.map((d) => d.premium),
      label: 'Write premium',
      value: fmtUSD(t.premium),
      sub: 'extra paid to create cache',
      color: HOLO.orange,
    }),
    metricTile({
      spark: c.daily.map((d) => d.net),
      label: 'Net savings',
      value: fmtUSD(t.net),
      sub: `${t.premium ? (t.saved / t.premium).toFixed(0) : '∞'}× return on writes`,
      color: '#5cf0a8',
    }),
    metricTile({
      spark: c.daily.map((d) => (d.requests ? d.warm / d.requests : 0)),
      label: 'Warm requests',
      value: pct(t.requests ? t.warm / t.requests : 0),
      sub: `${whole.format(t.warm)} read from cache`,
      color: HOLO.violet,
      p: t.requests ? t.warm / t.requests : 0,
    }),
    metricTile({
      spark: c.daily.map((d) => d.cold),
      label: 'Cold starts',
      value: whole.format(t.cold),
      sub: 'wrote cache, read none',
      color: HOLO.pink,
    }),
    metricTile({
      spark: c.daily.map((d) => d.cw1h),
      label: '1-hour writes',
      value: pct(writes ? t.cw1h / writes : 0),
      sub: `${fmtN(t.cw1h)} of ${fmtN(writes)} written`,
      color: HOLO.blue,
      p: writes ? t.cw1h / writes : 0,
    }),
    metricTile({
      label: 'Write : read',
      value: `1 : ${writes ? (t.cacheRead / writes).toFixed(0) : '—'}`,
      sub: 'tokens read per token written',
      color: HOLO.blue,
    }),
    metricTile({
      label: 'Router cache saved',
      value: rd ? fmtN(rd.metrics.tokensSaved || 0) : '—',
      sub: rd
        ? `${fmtUSD(rd.metrics.estimatedCostSaved || 0)} · ${whole.format(rd.metrics.requestsWithCacheControl || 0)} cache-control requests`
        : 'no router',
      color: HOLO.orange,
    }),
    metricTile({
      label: 'Semantic memo hits',
      value: memo ? pct(memo.hitRate || 0) : '—',
      sub: memo
        ? `${whole.format(memo.hits)} hits · ${whole.format(memo.size)}/${whole.format(memo.capacity)} entries`
        : 'router memo cache',
      color: HOLO.pink,
      p: memo ? memo.hitRate : null,
    }),
    metricTile({
      label: 'Reuse opportunities',
      value: whole.format(loops),
      sub: 'identical calls repeated 3+ times',
      color: HOLO.violet,
    }),
  ];
  const gauges = `<div class="gauges">${[
    gauge('All providers', t.hitRate, `${fmtN(t.cacheRead)} cached`, HOLO.cyan, HOLO.blue),
    gauge(
      'Anthropic',
      bt.claude ? bt.claude.hitRate : 0,
      bt.claude ? `${fmtUSD(bt.claude.net)} net` : 'no data',
      PROV_COLOR.claude,
      HOLO.violet,
    ),
    gauge(
      'OpenAI',
      bt.codex ? bt.codex.hitRate : 0,
      bt.codex ? `${fmtN(bt.codex.cacheRead)} cached` : 'no data',
      PROV_COLOR.codex,
      HOLO.pink,
    ),
    gauge('Warm share', t.requests ? t.warm / t.requests : 0, `${whole.format(t.cold)} cold`, HOLO.violet, HOLO.pink),
  ].join('')}</div>`;
  const models = `<table class="holo-table"><thead><tr><th>Model</th><th class="r">Requests</th><th>Hit rate</th><th class="r">Cache read</th><th class="r">Writes</th><th class="r">Saved</th><th class="r">Premium</th><th class="r">Net</th></tr></thead><tbody>
    ${c.byModel
      .map(
        (
          m,
        ) => `<tr><td><span class="tool-dot" style="background:${PROV_COLOR[m.tool]}"></span><b>${esc(m.model)}</b></td><td class="r num">${whole.format(m.requests)}</td>
      <td><div class="cell-bar left"><span class="num">${pct(m.hitRate)}</span><i style="width:${(m.hitRate * 100).toFixed(1)}%;background:${HOLO.cyan}"></i></div></td>
      <td class="r num">${fmtN(m.cacheRead)}</td><td class="r num">${fmtN(m.cw5m + m.cw1h)}</td><td class="r num">${fmtUSD(m.saved)}</td><td class="r num">${fmtUSD(m.premium)}</td><td class="r num"><b>${fmtUSD(m.net)}</b></td></tr>`,
      )
      .join('')}</tbody></table>`;
  const sessRows = (list, right) =>
    list.length
      ? list
          .map(
            (s) =>
              `<div class="feed-row two"><span class="feed-dot" style="background:${PROV_COLOR[s.tool]}"></span><b>${esc(s.project)}</b><span class="muted">${whole.format(s.requests)} requests · ${pct(s.hitRate)} hit</span><span class="num">${right(s)}</span></div>`,
          )
          .join('')
      : holoEmpty('No session with 10+ requests.');
  const health = rd && rd.health;
  const reuse = rd
    ? `${meters([
        {
          label: 'Router prompt-cache requests',
          value: rd.metrics.requestsWithCacheControl || 0,
          max: Math.max(1, rd.metrics.totalRequests || 0),
          color: HOLO.orange,
          right: `${whole.format(rd.metrics.requestsWithCacheControl || 0)} / ${whole.format(rd.metrics.totalRequests || 0)}`,
        },
        ...(memo
          ? [
              {
                label: 'Semantic memo cache fill',
                value: memo.size,
                max: memo.capacity,
                color: HOLO.pink,
                right: `${whole.format(memo.size)} / ${whole.format(memo.capacity)}`,
              },
            ]
          : []),
        ...(health
          ? [
              {
                label: `Cache health · ${health.verdict}`,
                value: health.warmCalls,
                max: Math.max(1, health.totalCalls),
                color: HOLO.cyan,
                right: `${whole.format(health.warmCalls)} warm of ${whole.format(health.totalCalls)}`,
              },
            ]
          : []),
      ])}<p class="kpi-sub">The router can answer repeated prompts from its own memo cache without calling a provider. Locally, ${whole.format(loops)} identical tool calls were repeated 3+ times in a row: answers that could have been reused.</p>`
    : routerNote(router);
  return `<div class="live-metrics">${tiles.join('')}</div>
    <div class="live-grid">
      ${panel('Hit rate over time', rangeText(), holoLine(c.daily, { series: [{ name: 'hit rate', color: HOLO.cyan, get: (d) => d.hitRate }], label: (d) => dayLabel(d.date), fmt: (v) => `${Math.round(v * 100)}%`, max: 1 }))}
      ${panel('Efficiency', 'share of input served from cache', gauges)}
    </div>
    <div class="live-grid even">
      ${panel(
        'Savings per day',
        'saved by cache vs. write premium',
        holoBars(c.daily, {
          series: [
            { name: 'saved', color: '#5cf0a8', get: (d) => d.saved },
            { name: 'premium', color: HOLO.orange, get: (d) => d.premium },
          ],
          label: (d) => dayLabel(d.date),
          fmt: fmtUSD,
        }),
      )}
      ${panel('Local semantic response reuse', router.configured ? `OmniRoute · ${esc(router.id)}` : 'router', reuse)}
    </div>
    ${panel('Cache by model', 'top 12 by tokens read from cache', `<div class="table-wrap">${models}</div>`)}
    <div class="live-grid even">
      ${panel('Best cached sessions', 'by net savings', `<div class="feed">${sessRows(c.bestSessions, (s) => fmtUSD(s.net))}</div>`)}
      ${panel('Coldest sessions', 'lowest hit rate', `<div class="feed">${sessRows(c.worstSessions, (s) => `${whole.format(s.cold)} cold`)}</div>`)}
    </div>`;
}

/* ---------- Compression ---------- */
function compressionBody(ins, router) {
  const c = ins.compression;
  const rd = router.configured && router.data && !router.data.error ? router.data : null;
  const tiles = [
    metricTile({
      spark: c.daily.map((d) => d.count),
      label: 'Compactions',
      value: whole.format(c.count),
      sub: 'context window summarised',
      color: HOLO.cyan,
    }),
    metricTile({
      spark: c.daily.map((d) => d.saved),
      label: 'Tokens removed',
      value: fmtN(c.saved),
      sub: 'context before − after',
      color: '#5cf0a8',
    }),
    metricTile({
      label: 'Tokens avoided',
      value: fmtN(c.tokensAvoided),
      sub: 'not re-sent on later requests',
      color: '#5cf0a8',
    }),
    metricTile({ label: 'Cost avoided', value: fmtUSD(c.usdAvoided), sub: 'at cache-read price', color: HOLO.orange }),
    metricTile({
      label: 'Compression ratio',
      value: c.count ? `${(c.avgRatio * 100).toFixed(0)}%` : '—',
      sub: 'context kept after compaction',
      color: HOLO.violet,
      p: c.count ? c.avgRatio : null,
    }),
    metricTile({
      label: 'Avg context at compaction',
      value: fmtN(c.avgPre),
      sub: 'tokens when it triggered',
      color: HOLO.pink,
    }),
    metricTile({ label: 'Largest context', value: fmtN(c.contextMax), sub: 'one request', color: HOLO.pink }),
    metricTile({
      spark: c.contextBuckets.map((b) => b.requests),
      label: 'Avg context / request',
      value: fmtN(c.contextAvg),
      sub: 'input + cache tokens',
      color: HOLO.blue,
    }),
    metricTile({
      label: 'Router compressed',
      value: rd ? whole.format(rd.totalRequests || 0) : '—',
      sub: rd ? `${whole.format(rd.totalSkipped || 0)} skipped` : 'no router',
      color: HOLO.orange,
    }),
    metricTile({
      label: 'Router tokens saved',
      value: rd ? fmtN(rd.totalTokensSaved || 0) : '—',
      sub: rd ? `${(rd.avgSavingsPct || 0).toFixed(1)}% average saving` : 'no router',
      color: HOLO.orange,
    }),
    metricTile({
      label: 'Router USD saved',
      value: rd ? fmtUSD((rd.realUsage || {}).estimatedUsdSaved || 0) : '—',
      sub: rd ? `${msFmt(rd.avgDurationMs)} per compression` : 'no router',
      color: HOLO.orange,
    }),
    metricTile({
      label: 'MCP schema savings',
      value: rd ? fmtN((rd.mcpDescriptionCompression || {}).estimatedTokensSaved || 0) : '—',
      sub: 'tool descriptions shortened',
      color: HOLO.violet,
    }),
  ];
  const buckets = c.contextBuckets.map((b) => ({
    ...b,
    label: `${fmtN(b.lo)}${b.hi === null || b.hi === Infinity || b.hi > 1e12 ? '+' : `–${fmtN(b.hi)}`}`,
  }));
  const recent = c.recent.length
    ? `<table class="holo-table"><thead><tr><th>When</th><th>Project</th><th>Before → after</th><th class="r">Removed</th><th class="r">Later requests</th><th class="r">Avoided</th></tr></thead><tbody>
    ${c.recent
      .map(
        (
          x,
        ) => `<tr><td class="muted">${fmtDate(x.ts)}</td><td><b>${esc(x.project)}</b><small class="block muted">${esc(x.model.replace(/^claude-/, ''))}</small></td>
      <td><div class="squeeze"><i style="width:100%"></i><i class="after" style="width:${(x.pre ? (x.post / x.pre) * 100 : 0).toFixed(1)}%"></i></div><small class="muted num">${fmtN(x.pre)} → ${fmtN(x.post)}</small></td>
      <td class="r num">${fmtN(x.saved)}</td><td class="r num">${whole.format(x.carried)}</td><td class="r num">${fmtUSD(x.usdAvoided)}</td></tr>`,
      )
      .join('')}</tbody></table>`
    : holoEmpty(`No context compactions in the ${rangeText()}.`);
  const engines = rd ? Object.entries({ ...(rd.byEngine || {}), ...(rd.byMode || {}) }) : [];
  const routerPanel = rd
    ? `${(rd.last24h || []).some((h) => h.count) ? holoBars(rd.last24h, { series: [{ name: 'compressed', color: HOLO.orange, get: (h) => h.count }], label: (h) => (h.hour || '').slice(11, 16), every: 4, height: 150 }) : ''}
    ${engines.length ? meters(engines.map(([k, v]) => ({ label: esc(k), value: typeof v === 'object' ? v.count || v.requests || 0 : v, max: Math.max(1, rd.totalRequests || 1), color: HOLO.orange, right: whole.format(typeof v === 'object' ? v.count || v.requests || 0 : v) }))) : '<p class="kpi-sub">No compression engine has run through the router yet.</p>'}`
    : routerNote(router);
  return `<div class="live-metrics">${tiles.join('')}</div>
    <div class="live-grid even">
      ${panel('Context pressure', 'requests by context size', holoBars(buckets, { series: [{ name: 'requests', color: HOLO.violet, get: (b) => b.requests }], label: (b) => b.label, every: 1 }))}
      ${panel('Compactions per day', 'and tokens removed', holoBars(c.daily, { series: [{ name: 'tokens removed', color: '#5cf0a8', get: (d) => d.saved }], label: (d) => dayLabel(d.date) }))}
    </div>
    ${panel('Recent compactions', 'context before and after each summary', `<div class="table-wrap">${recent}</div>`)}
    ${panel('Router compression', router.configured ? `OmniRoute · ${esc(router.id)} · last 24 hours` : 'router', routerPanel)}`;
}

/* ---------- Provider stats ---------- */
function providersBody(ins, router, logs) {
  const pv = ins.providers;
  const rd = router.configured && router.data && !router.data.error ? router.data : null;
  const lat = (source) => {
    const rs = (logs ? logs.requests : []).filter((r) => r.source === source);
    return {
      n: rs.length,
      ttft: quantile(
        rs.map((r) => r.ttftMs),
        0.5,
      ),
      p95: quantile(
        rs.map((r) => r.ttftMs),
        0.95,
      ),
      dur: quantile(
        rs.map((r) => r.durationMs),
        0.5,
      ),
    };
  };
  const totalReq = pv.list.reduce((a, p) => a + p.requests, 0) || 1;
  const cards = pv.list
    .map((p) => {
      const l = lat(p.tool);
      const rows = [
        ['Requests', whole.format(p.requests)],
        ['Share', pct(p.requests / totalReq)],
        ['Sessions', whole.format(p.sessions)],
        ['Models', whole.format(p.models)],
        ['Input / output', `${fmtN(p.input + p.cacheRead + p.cacheWrite)} / ${fmtN(p.output)}`],
        ['Avg output', `${fmtN(p.output / Math.max(1, p.requests))} per request`],
        ['Est. cost', fmtUSD(p.cost)],
        ['Subagent share', pct(p.sub / Math.max(1, p.requests))],
        ['Active days', whole.format(p.days)],
        [
          'API errors',
          `${whole.format(p.apiErrors)} · ${(p.requests ? (p.apiErrors / p.requests) * 1000 : 0).toFixed(1)} per 1K`,
        ],
        ['Refusals', whole.format(p.refusals)],
        ['TTFT p50 / p95', l.n ? `${msFmt(l.ttft)} / ${msFmt(l.p95)}` : '— (no recent requests)'],
        ['Turn duration p50', l.n ? msFmt(l.dur) : '—'],
      ];
      return `<section class="holo panel prov-card" style="--c:${PROV_COLOR[p.tool]}"><div class="panel-head"><h3>${esc(p.provider)}</h3><span class="meta">${esc(toolName(p.tool))} · last seen ${ago(p.last)}</span></div>
      <div class="kv">${rows.map(([k, v]) => `<span>${k}</span><b class="num">${v}</b>`).join('')}</div></section>`;
    })
    .join('');
  const maxReq = Math.max(1, ...pv.models.map((m) => m.requests));
  const models = `<table class="holo-table"><thead><tr><th>Model</th><th>Provider</th><th>Requests</th><th class="r">Input</th><th class="r">Output</th><th class="r">Avg out</th><th class="r">Cost</th><th class="r">$ / 1K req</th></tr></thead><tbody>
    ${pv.models
      .map(
        (
          m,
        ) => `<tr><td><b>${esc(m.model)}</b>${m.priced ? '' : ' <small class="muted">(no price)</small>'}</td><td><span class="tool-dot" style="background:${PROV_COLOR[m.tool]}"></span>${esc(m.provider)}</td>
      <td><div class="cell-bar left"><span class="num">${whole.format(m.requests)}</span><i style="width:${((m.requests / maxReq) * 100).toFixed(1)}%;background:${PROV_COLOR[m.tool]}"></i></div></td>
      <td class="r num">${fmtN(m.input + m.cacheRead + m.cacheWrite)}</td><td class="r num">${fmtN(m.output)}</td><td class="r num">${fmtN(m.output / Math.max(1, m.requests))}</td>
      <td class="r num">${fmtUSD(m.cost)}</td><td class="r num">${fmtUSD((m.cost / Math.max(1, m.requests)) * 1000)}</td></tr>`,
      )
      .join('')}</tbody></table>`;
  let routerPanel = routerNote(router);
  if (rd) {
    const t = rd.telemetry || {};
    routerPanel = `<div class="live-metrics three">${[
      metricTile({
        label: 'Router requests',
        value: whole.format((rd.providers || []).reduce((a, p) => a + (p.totalRequests || 0), 0)),
        sub: `${(rd.providers || []).length} providers`,
        color: HOLO.orange,
      }),
      metricTile({
        label: 'Latency p50 / p95',
        value: t.count ? `${msFmt(t.p50)} / ${msFmt(t.p95)}` : '—',
        sub: t.count ? `p99 ${msFmt(t.p99)} · ${whole.format(t.count)} samples` : 'no telemetry yet',
        color: HOLO.cyan,
      }),
      metricTile({
        label: 'Success rate',
        value: pct(
          (rd.providers || []).reduce((a, p) => a + (p.successfulRequests || 0), 0) /
            Math.max(
              1,
              (rd.providers || []).reduce((a, p) => a + (p.totalRequests || 0), 0),
            ),
        ),
        sub: 'served without error',
        color: '#5cf0a8',
      }),
    ].join('')}</div>
    <div class="table-wrap"><table class="holo-table"><thead><tr><th>Provider</th><th class="r">Requests</th><th class="r">Success</th><th class="r">Avg latency</th><th class="r">Tokens in / out</th></tr></thead><tbody>
      ${(rd.providers || []).map((p) => `<tr><td><b>${esc(p.provider)}</b>${p.nodeName ? ` <small class="muted">${esc(p.nodeName)}</small>` : ''}</td><td class="r num">${whole.format(p.totalRequests)}</td><td class="r num">${pct((p.successfulRequests || 0) / Math.max(1, p.totalRequests))}</td><td class="r num">${msFmt(p.avgLatencyMs)}</td><td class="r num">${fmtN(p.totalTokensIn || 0)} / ${fmtN(p.totalTokensOut || 0)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="table-wrap"><table class="holo-table"><thead><tr><th>Router model</th><th>Provider</th><th class="r">Requests</th><th class="r">Success</th><th class="r">Avg latency</th></tr></thead><tbody>
      ${(rd.models || []).map((m) => `<tr><td><b>${esc(m.model)}</b></td><td class="muted">${esc(m.provider)}</td><td class="r num">${whole.format(m.requests)}</td><td class="r num">${pct((m.successfulRequests || 0) / Math.max(1, m.requests))}</td><td class="r num">${msFmt(m.avgLatencyMs)}</td></tr>`).join('')}
    </tbody></table></div>`;
  }
  // Header like Utilization: a 3D skyline of models, a metric strip, then per-model charts.
  const all = pv.list;
  const reqs = all.reduce((a, p) => a + p.requests, 0);
  const cost = all.reduce((a, p) => a + p.cost, 0);
  const inTok = all.reduce((a, p) => a + p.input + p.cacheRead + p.cacheWrite, 0);
  const cacheTok = all.reduce((a, p) => a + p.cacheRead, 0);
  const out = all.reduce((a, p) => a + p.output, 0);
  const errs = all.reduce((a, p) => a + p.apiErrors, 0);
  const ref = all.reduce((a, p) => a + p.refusals, 0);
  const claude = all.find((p) => p.tool === 'claude') || { requests: 0 };
  const lc = lat('claude');
  const daily = ins.utilization.daily;
  const top = pv.models[0];
  const tiles = [
    metricTile({
      label: 'Providers',
      value: whole.format(all.length),
      sub: `${pv.models.length} models in use`,
      color: HOLO.cyan,
    }),
    metricTile({
      label: 'Requests',
      value: fmtN(reqs),
      sub: rangeText(),
      color: HOLO.cyan,
      spark: daily.map((d) => d.claude.calls + d.codex.calls),
    }),
    metricTile({
      label: 'Anthropic share',
      value: pct(claude.requests / Math.max(1, reqs)),
      sub: `${fmtN(claude.requests)} requests`,
      color: PROV_COLOR.claude,
      spark: daily.map((d) => d.claude.calls),
    }),
    metricTile({
      label: 'OpenAI share',
      value: pct((reqs - claude.requests) / Math.max(1, reqs)),
      sub: `${fmtN(reqs - claude.requests)} requests`,
      color: PROV_COLOR.codex,
      spark: daily.map((d) => d.codex.calls),
    }),
    metricTile({ label: 'Est. cost', value: fmtUSD(cost), sub: 'API list price', color: HOLO.orange }),
    metricTile({
      label: 'Cost / 1K requests',
      value: fmtUSD((cost / Math.max(1, reqs)) * 1000),
      sub: 'all providers',
      color: HOLO.orange,
    }),
    metricTile({
      label: 'Avg output',
      value: fmtN(out / Math.max(1, reqs)),
      sub: 'tokens per request',
      color: HOLO.violet,
    }),
    metricTile({
      label: 'Input from cache',
      value: pct(cacheTok / Math.max(1, inTok)),
      sub: `${fmtN(cacheTok)} cached tokens`,
      color: HOLO.violet,
      p: cacheTok / Math.max(1, inTok),
    }),
    metricTile({
      label: 'API errors',
      value: `${((errs / Math.max(1, reqs)) * 1000).toFixed(1)} / 1K`,
      sub: `${whole.format(errs)} errors · ${whole.format(ref)} refusals`,
      color: '#ff4f6d',
    }),
    metricTile({
      label: 'TTFT p50',
      value: msFmt(lc.ttft),
      sub: lc.n ? `Anthropic · last 3 h · ${lc.n} requests` : 'no recent requests',
      color: HOLO.blue,
    }),
    metricTile({
      label: 'TTFT p95',
      value: msFmt(lc.p95),
      sub: lc.n ? `turn p50 ${msFmt(lc.dur)}` : '—',
      color: HOLO.blue,
    }),
    metricTile({
      label: 'Top model',
      value: top ? esc(top.model.replace(/^claude-/, '')) : '—',
      sub: top ? `${pct(top.requests / Math.max(1, reqs))} of requests` : 'none',
      color: HOLO.pink,
      p: top ? top.requests / Math.max(1, reqs) : null,
    }),
  ];
  const topModels = pv.models.slice(0, 12);
  const header = `<section class="holo stage landscape-stage"><canvas id="qp-providers" aria-label="3D skyline of models by requests, grouped by provider"></canvas>
      <div class="stage-tl"><div class="holo-kicker">MODEL SKYLINE · BY PROVIDER</div><div class="stage-key">One tower per model: front row Anthropic, back row OpenAI · height = requests · glow = cost · walls: cost and output by model · hover a tower</div></div>
      <div class="stage-legend"><span><i style="background:${PROV_COLOR.claude}"></i>Anthropic</span><span><i style="background:${PROV_COLOR.codex}"></i>OpenAI</span><span><i style="background:#ff5ca8"></i>Top cost</span></div></section>
    <div class="live-metrics">${tiles.join('')}</div>
    <div class="live-grid even">
      ${panel('Requests by model', 'top 12', holoBars(topModels, { series: [{ name: 'requests', color: HOLO.cyan, get: (m) => m.requests }], label: (m) => m.model.replace(/^claude-/, '').slice(0, 12), every: 1 }))}
      ${panel(
        'Cost per 1K requests',
        'by model · API list price',
        holoBars(
          topModels.filter((m) => m.priced),
          {
            series: [{ name: '$ / 1K', color: HOLO.orange, get: (m) => (m.cost / Math.max(1, m.requests)) * 1000 }],
            label: (m) => m.model.replace(/^claude-/, '').slice(0, 12),
            fmt: fmtUSD,
            every: 1,
          },
        ),
      )}
    </div>`;
  return `${header}<div class="prov-grid">${cards || holoEmpty(`No provider traffic in the ${rangeText()}.`)}</div>
    ${panel('Models', `${rangeText()} · local transcripts`, `<div class="table-wrap">${models}</div>`)}
    ${panel('Through the router', router.configured ? `OmniRoute · ${esc(router.id)}` : 'router', routerPanel)}`;
}

/* ---------- Overview: failures per day in 3D ---------- */
// Stacked towers per day by failure cause; the back walls carry daily accuracy and tool-call volume.
function mountFailureCity() {
  const canvas = $('#quality-scene');
  if (!canvas || !state.data) return;
  const daily = state.data.quality.daily;
  const k = Math.max(1, Math.ceil(daily.length / 40)); // keep at most ~40 towers
  const days = [];
  for (let i = 0; i < daily.length; i += k) {
    const chunk = daily.slice(i, i + k);
    const cats = {};
    let results = 0;
    let modelFailures = 0;
    for (const d of chunk) {
      for (const [c, n] of Object.entries(d.cats || {})) cats[c] = (cats[c] || 0) + n;
      results += d.results || 0;
      modelFailures += d.modelFailures || 0;
    }
    days.push({
      date: chunk[0].date,
      last: chunk[chunk.length - 1].date,
      cats,
      results,
      accuracy: results ? 1 - modelFailures / results : null,
    });
  }
  const total = (d) => FAIL_CATS.reduce((a, c) => a + (d.cats[c.id] || 0), 0);
  const label = (d) => (d.date === d.last ? dayLabel(d.date) : `${dayLabel(d.date)} – ${dayLabel(d.last)}`);
  const max = Math.max(1, ...days.map(total));
  const heights = {};
  let tip = '';
  const accVals = days.map((d) => (d.accuracy == null ? 0 : d.accuracy));
  const accMean = accVals.filter((v, i) => days[i].accuracy != null);
  const floor = Math.max(0, Math.floor(((accMean.length ? Math.min(...accMean) : 0.9) - 0.02) * 100) / 100);
  isoStage(canvas, {
    fit: [13.2, 8.6],
    origin: [0.47, 0.64],
    draw(g) {
      const { P, ctx, still } = g;
      const n = days.length;
      const X0 = -5.8;
      const X1 = 5.8;
      g.glow();
      g.platform(X0, X1, -3.2, 2.6);
      // Accuracy sits in a narrow band near 100%, so the wall starts just below the worst day.
      const accTop = state.data.quality.accuracy == null ? '—' : pct(state.data.quality.accuracy);
      g.wall(-5.6, -2.7, -0.1, -3.0, {
        vals: accVals.map((v, i) => (days[i].accuracy == null ? 0 : v - floor)),
        color: '#5cf0a8',
        title: `ACCURACY PER DAY · FROM ${Math.round(floor * 100)}%`,
        value: accTop,
        max: (1 - floor) * 1.3,
        H: 2.8,
        guide: accMean.length ? accMean.reduce((a, b) => a + b, 0) / accMean.length - floor : null,
        guideLabel: 'average',
      });
      g.wall(0.1, -3.0, 5.6, -2.7, {
        vals: days.map((d) => d.results),
        color: HOLO.cyan,
        title: 'TOOL CALLS PER DAY',
        value: fmtN(state.data.quality.results),
        hot: n - 1,
        H: 2.8,
      });
      const step = (X1 - X0 - 0.6) / n;
      const w = Math.min(0.5, step * 0.72);
      const z = -0.6;
      const d0 = 0.9;
      const items = [];
      const tops = [];
      days.forEach((d, i) => {
        const x = X0 + 0.3 + i * step + (step - w) / 2;
        let y = 0;
        for (const c of FAIL_CATS) {
          const v = d.cats[c.id] || 0;
          if (!v) continue;
          const key = `${d.date}:${c.id}`;
          const target = (v / max) * 3.6;
          heights[key] = (heights[key] ?? 0) + (target - (heights[key] ?? 0)) * (still ? 1 : 0.08);
          const y0 = y;
          const h = heights[key];
          items.push({
            depth: P(x, 0, z)[2] + y0 * 0.001,
            draw: () =>
              g.box(x, z, w, d0, h, FAIL_NEON[c.id], { y0, slices: 0, glow: c.id === 'hallucination' ? 12 : 0 }),
          });
          y += h;
        }
        if (!total(d))
          items.push({
            depth: P(x, 0, z)[2],
            draw: () => g.box(x, z, w, d0, 0.02, '#2a2f78', { slices: 0, glow: 0, alpha: 0.6 }),
          });
        tops.push({ at: P(x + w / 2, y, z + d0 / 2), d, x });
      });
      items.sort((a, b) => a.depth - b.depth).forEach((it) => it.draw());
      ctx.fillStyle = HOLO.muted;
      ctx.font = '10.5px system-ui, sans-serif';
      const every = Math.ceil(n / 8);
      days.forEach((d, i) => {
        if ((n - 1 - i) % every) return;
        const q = P(tops[i].x + w / 2, 0, 2.95);
        const t = dayLabel(d.date);
        ctx.fillText(t, q[0] - ctx.measureText(t).width / 2, q[1] + 12);
      });
      g.particles();
      const peak = days.reduce((a, b) => (total(b) > total(a) ? b : a), days[0]);
      const callouts = [];
      if (peak && total(peak))
        callouts.push({
          at: tops[days.indexOf(peak)].at,
          text: `Peak ${label(peak)} · ${total(peak)} failures`,
          color: HOLO.pink,
        });
      const today = days[n - 1];
      if (today && today !== peak)
        callouts.push({
          at: tops[n - 1].at,
          text: `${label(today)} · ${total(today)} failures${today.accuracy != null ? ` · ${pct(today.accuracy)} accurate` : ''}`,
          color: HOLO.cyan,
        });
      g.labels(callouts);
      const p = g.pointer;
      let hit = null;
      if (p)
        for (const t of tops) {
          const dd = Math.hypot(t.at[0] - p.x, t.at[1] - p.y);
          if (dd < 18 && (!hit || dd < hit.dd)) hit = { ...t, dd };
        }
      if (hit) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(hit.at[0], hit.at[1], 6, 0, 7);
        ctx.stroke();
        const key = `${hit.d.date}|${p.cx}|${p.cy}`;
        if (key !== tip) {
          showTip(
            { clientX: p.cx, clientY: p.cy },
            `<b>${label(hit.d)}</b>${FAIL_CATS.map((c) => `<div class="row"><span><i style="background:${FAIL_NEON[c.id]}"></i>${c.name}</span><span class="num">${hit.d.cats[c.id] || 0}</span></div>`).join('')}
            <div class="row"><span>Tool calls</span><span class="num">${fmtN(hit.d.results)}</span></div><div class="row"><span>Accuracy</span><span class="num">${hit.d.accuracy == null ? '—' : fmtPct(hit.d.accuracy)}</span></div>`,
          );
        }
        tip = key;
      } else if (tip) {
        hideTip();
        tip = '';
      }
    },
  });
}

// Models as towers in two rows by provider; height = requests (sqrt), the three priciest glow pink.
function mountProviderSkyline(pv) {
  const canvas = $('#qp-providers');
  if (!canvas) return;
  const rows = {
    claude: pv.models.filter((m) => m.tool === 'claude').slice(0, 10),
    codex: pv.models.filter((m) => m.tool === 'codex').slice(0, 10),
  };
  const list = [...rows.claude, ...rows.codex];
  if (!list.length) return;
  const maxR = Math.max(1, ...list.map((m) => m.requests));
  const hot = new Set(
    [...list]
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 3)
      .filter((m) => m.cost > 0)
      .map((m) => m.model),
  );
  const heights = {};
  const hov = { tip: '' };
  isoStage(canvas, {
    fit: [13, 8.2],
    origin: [0.5, 0.6],
    draw(g) {
      const { P, still } = g;
      g.glow();
      g.platform(-6, 6, -3.1, 2.6);
      g.wall(-5.8, -2.6, -0.1, -2.9, {
        vals: list.map((m) => m.cost),
        color: HOLO.orange,
        title: 'COST BY MODEL',
        value: fmtUSD(list.reduce((a, m) => a + m.cost, 0)),
        H: 2.4,
      });
      g.wall(0.1, -2.9, 5.8, -2.6, {
        vals: list.map((m) => m.output),
        color: HOLO.violet,
        title: 'OUTPUT TOKENS BY MODEL',
        value: fmtN(list.reduce((a, m) => a + m.output, 0)),
        H: 2.4,
      });
      const items = [];
      const pts = [];
      for (const [tool, z] of [
        ['claude', 0.9],
        ['codex', -1.1],
      ]) {
        rows[tool].forEach((m, i) => {
          const x = -5.5 + i * 1.1;
          const key = `${tool}:${m.model}`;
          const target = 0.12 + 3.4 * Math.sqrt(m.requests / maxR);
          heights[key] = (heights[key] ?? 0.05) + (target - (heights[key] ?? 0.05)) * (still ? 1 : 0.08);
          const h = heights[key];
          const color = hot.has(m.model) ? '#ff5ca8' : PROV_COLOR[tool];
          items.push({
            depth: P(x, 0, z)[2],
            draw: () => g.box(x, z, 0.7, 0.7, h, color, { glow: hot.has(m.model) ? 18 : 6, slices: 0.4 }),
          });
          pts.push({
            at: P(x + 0.35, h, z + 0.35),
            key,
            m,
            html: () =>
              `<b>${esc(m.model)}</b><div class="row"><span>Provider</span><span>${esc(m.provider)}</span></div><div class="row"><span>Requests</span><span class="num">${whole.format(m.requests)}</span></div><div class="row"><span>Output</span><span class="num">${fmtN(m.output)}</span></div><div class="row"><span>Est. cost</span><span class="num">${m.priced ? fmtUSD(m.cost) : 'no price'}</span></div>`,
          });
        });
      }
      items.sort((a, b) => a.depth - b.depth).forEach((it) => it.draw());
      g.particles();
      g.labels(
        pts
          .slice()
          .sort((a, b) => b.m.requests - a.m.requests)
          .slice(0, 6)
          .map((p) => ({
            at: p.at,
            text: `${p.m.model.replace(/^claude-/, '')} · ${fmtN(p.m.requests)}`,
            color: hot.has(p.m.model) ? HOLO.pink : PROV_COLOR[p.m.tool],
          })),
      );
      hoverTip(g, pts, hov);
    },
  });
}
