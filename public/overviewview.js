'use strict';
/* Overview page as a holographic deck: a 3D "usage city" of daily activity, a metric strip, gauges,
   and the existing overview cards restyled by the deck's theme tokens. */

const TOOL_NEON = { claude: '#6d7cff', codex: '#ff8a4c' };
const metricFmt = (m) => (m === 'cost' ? fmtUSD : fmtN); // lazy: the formatters live in app.js, loaded later
const cityH = {}; // eased tower heights by "date:tool", kept across the one-minute refresh

// Daily rows grouped so the city never has more than ~40 blocks per row.
function usageBuckets() {
  const daily = state.data.daily;
  const k = Math.max(1, Math.ceil(daily.length / 40));
  const out = [];
  for (let i = 0; i < daily.length; i += k) {
    const chunk = daily.slice(i, i + k);
    const sum = (tool, f) => chunk.reduce((a, d) => a + (d[tool]?.[f] || 0), 0);
    const b = { date: chunk[0].date, last: chunk[chunk.length - 1].date, days: chunk.length, sessions: 0 };
    for (const s of SERIES) {
      b[s.id] = { cost: sum(s.id, 'cost'), tokens: sum(s.id, 'tokens'), calls: sum(s.id, 'calls') };
      b.sessions += sum(s.id, 'sessions');
    }
    out.push(b);
  }
  return out;
}
const bucketLabel = (b) => (b.days > 1 ? `${dayLabel(b.date)} – ${dayLabel(b.last)}` : dayLabel(b.date));

// The slim note above the Overview when there is nothing to show: the first index still running, or no log
// folder holding any logs. Plain text only (the page escapes it); '' means no note.
function emptyLogsNote(logRoots, index, sessions) {
  if (sessions > 0 || !Array.isArray(logRoots) || !index) return '';
  if (index.indexing)
    return index.total > 0 ? `Indexing your logs… ${index.done}/${index.total} files` : 'Indexing your logs…';
  if (index.lastScan == null) return ''; // the first scan has not started yet
  if (logRoots.some((r) => r.files > 0)) return ''; // logs exist, this range is only quiet
  const looked = logRoots
    .map((r) => `${r.path} (${r.ignored ? `ignored: ${r.ignored}` : r.exists ? 'empty' : 'missing'})`)
    .join(' · ');
  return (
    `No Claude Code or Codex logs found. ZAAFPulse looked in: ${looked}. ` +
    'Using another folder? Set CLAUDE_CONFIG_DIR or CODEX_HOME before starting ZAAFPulse. ' +
    'Claude Desktop, ChatGPT and other chat apps keep no readable logs; they show as apps only.'
  );
}

const overviewNote = (d) =>
  emptyLogsNote((state.live || {}).logRoots, (state.live || {}).index || d.index, d.kpis.sessions);

function viewOverview() {
  const d = state.data;
  const k = d.kpis;
  const live = state.live || { apps: [], installed: [] };
  const today = new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' });
  const budget = d.config.monthlyBudgetUSD;
  const budgetPct = budget ? k.monthCost / budget : 0;
  const unpriced = d.unpriced.length
    ? ` ${d.unpriced.length} model${d.unpriced.length > 1 ? 's have' : ' has'} no price set (${d.unpriced.slice(0, 3).map(esc).join(', ')}${d.unpriced.length > 3 ? '…' : ''}), so their cost shows as $0.`
    : '';
  const estimated = (d.estimated || []).length
    ? ` ${d.estimated.slice(0, 3).map(esc).join(', ')} ${d.estimated.length > 1 ? 'are' : 'is'} priced as an estimate (the logs name no model).`
    : '';
  const squad = squadCards(6);
  const dSum = (f) => d.daily.map((r) => SERIES.reduce((a, s) => a + r[s.id][f], 0)); // daily series for the card sparklines
  let mtdRun = 0;
  const mtd = d.month.daily.map((r) => (mtdRun += r.cost));
  const totals = SERIES.map((s) => ({ ...s, cost: d.daily.reduce((a, r) => a + r[s.id].cost, 0) }));
  const claudeShare = k.cost ? totals[0].cost / k.cost : 0;
  const busiest = [...d.daily].sort(
    (a, b) => SERIES.reduce((x, s) => x + b[s.id].cost, 0) - SERIES.reduce((x, s) => x + a[s.id].cost, 0),
  )[0];
  const busiestCost = busiest ? SERIES.reduce((x, s) => x + busiest[s.id].cost, 0) : 0;
  const metricSeg = `<div class="segmented" role="group" aria-label="Metric">${[
    ['cost', 'Cost'],
    ['tokens', 'Tokens'],
    ['calls', 'Calls'],
  ]
    .map(([v, l]) => `<button data-metric="${v}" aria-pressed="${state.metric === v}">${l}</button>`)
    .join('')}</div>`;

  const logNote = overviewNote(d);
  state.logNote = logNote; // the live poll re-renders when this changes (indexing progress, first logs found)
  return `<div class="holo-deck">
  ${hero(
    'AI USAGE OVERVIEW',
    `${greeting()}, ${esc(d.config.userName)}.`,
    `Here's how AI has been working on this machine over the ${rangeText()}.`,
    `<span class="pill">${icon('calendar', 14)}${today}</span>`,
  )}
  ${logNote ? `<div class="notice info" role="status">${icon('alert')}<div>${esc(logNote)}</div></div>` : ''}
  <div class="notice">${icon('alert')}<div><b>Cost is an API-equivalent estimate</b> at list price per token. On a Claude Max or ChatGPT plan you are not billed per token.${unpriced}${estimated}</div><a href="#settings">Edit prices ${icon('external', 12)}</a></div>

  <section class="holo stage">
    <canvas id="ov-scene" aria-label="3D city of daily AI usage: one tower per day, front row Claude Code, back row Codex; the back walls show month-to-date spend and calls by hour"></canvas>
    <div class="stage-tl"><div class="holo-kicker">USAGE CITY · ISOMETRIC</div>
      <div class="stage-key">One tower per day · height = selected metric · front row Claude Code, back row Codex · hover a tower · drag to rotate</div>
      <div class="stage-ctl">${metricSeg}</div></div>
    <div class="stage-readouts">${readouts([
      {
        label: 'Est. spend',
        icon: 'dollar',
        value: fmtUSD(k.cost),
        delta: delta(k.cost, k.prevCost),
        sub: `${rangeText()} · API list price`,
        color: HOLO.orange,
        spark: dSum('cost'),
      },
      {
        label: 'Tokens',
        icon: 'layers',
        value: fmtN(k.tokens),
        delta: delta(k.tokens, k.prevTokens),
        sub: `${fmtPct(k.cacheHitRate)} from cache`,
        color: HOLO.violet,
        spark: dSum('tokens'),
      },
      {
        label: 'Sessions',
        icon: 'zap',
        value: whole.format(k.sessions),
        delta: delta(k.sessions, k.prevSessions),
        sub: `${whole.format(k.prompts)} prompts typed`,
        color: HOLO.cyan,
        spark: dSum('sessions'),
      },
      {
        label: 'This month',
        icon: 'calendar',
        value: fmtUSD(k.monthCost),
        sub: `of ${fmtUSD(d.month.projected)} projected`,
        color: HOLO.pink,
        p: d.month.projected ? k.monthCost / d.month.projected : 0,
      },
    ])}</div>
    <div class="stage-legend">${SERIES.map((s) => `<span><i style="background:${TOOL_NEON[s.id]}"></i>${s.name}</span>`).join('')}
      <span><i style="background:${HOLO.cyan}"></i>Month-to-date spend</span><span><i style="background:${HOLO.pink}"></i>Projection · now</span></div>
  </section>

  <div class="live-metrics">${[
    metricTile({
      label: 'Active AI apps',
      value: String(live.apps.length).padStart(2, '0'),
      sub: `${squad.total} detected · ${live.installed.length} installed`,
      color: HOLO.cyan,
      drill: 'apps',
      p: squad.total ? live.apps.length / squad.total : 0,
    }),
    metricTile({
      spark: dSum('sessions'),
      label: 'Sessions',
      value: whole.format(k.sessions),
      sub: `${delta(k.sessions, k.prevSessions)} ${(k.sessions / Math.max(1, d.daily.length)).toFixed(1)} per day`,
      color: HOLO.cyan,
      drill: 'sessions',
    }),
    metricTile({
      label: 'Prompts typed',
      value: whole.format(k.prompts),
      sub: `${(k.prompts / Math.max(1, k.sessions)).toFixed(1)} per session`,
      color: HOLO.blue,
      drill: 'sessions',
    }),
    metricTile({
      spark: dSum('calls'),
      label: 'Model calls',
      value: fmtN(k.calls),
      sub: `${delta(k.calls, k.prevCalls)} ${fmtN(k.subagentCalls)} by subagents`,
      color: HOLO.blue,
      drill: 'sessions',
      p: k.calls ? k.subagentCalls / k.calls : 0,
    }),
    metricTile({
      spark: dSum('tokens'),
      label: 'Tokens processed',
      value: fmtN(k.tokens),
      sub: `${delta(k.tokens, k.prevTokens)} ${fmtN(k.tokens / Math.max(1, k.sessions))} per session`,
      color: HOLO.violet,
      drill: 'tokens',
    }),
    metricTile({
      label: 'Output tokens',
      value: fmtN(k.output),
      sub: `${k.tokens ? ((k.output / k.tokens) * 100).toFixed(2) : 0}% of all tokens`,
      color: HOLO.violet,
      drill: 'tokens',
    }),
    metricTile({
      spark: dSum('cost'),
      label: 'Est. spend',
      value: fmtUSD(k.cost),
      sub: `${delta(k.cost, k.prevCost)} ${fmtUSD(k.cost / Math.max(1, d.daily.length))} per day`,
      color: HOLO.orange,
      drill: 'spend',
    }),
    metricTile({
      spark: mtd,
      label: 'Month to date',
      value: fmtUSD(k.monthCost),
      sub: budget ? `${Math.round(budgetPct * 100)}% of ${fmtUSD(budget)} budget` : 'no budget set',
      color: HOLO.orange,
      drill: 'spend',
      p: budget ? budgetPct : d.month.daysElapsed / d.month.daysInMonth,
    }),
    metricTile({
      spark: mtd,
      label: 'Month projection',
      value: fmtUSD(d.month.projected),
      sub: `day ${Math.ceil(d.month.daysElapsed)} of ${d.month.daysInMonth}`,
      color: HOLO.pink,
      drill: 'spend',
      p: budget ? d.month.projected / budget : null,
    }),
    metricTile({
      label: 'Cache hit rate',
      value: fmtPct(k.cacheHitRate),
      sub: `${fmtN(k.composition.cacheRead)} tokens read from cache`,
      color: HOLO.cyan,
      drill: 'tokens',
      p: k.cacheHitRate,
    }),
    metricTile({
      spark: dSum('cost').map((c, i) => c / Math.max(1, dSum('sessions')[i])),
      label: 'Cost per session',
      value: fmtUSD(k.cost / Math.max(1, k.sessions)),
      sub: `${fmtUSD(k.cost / Math.max(1, k.calls))} per model call`,
      color: HOLO.pink,
      drill: 'spend',
    }),
    metricTile({
      spark: dSum('cost'),
      label: 'Busiest day',
      value: busiest ? fmtUSD(busiestCost) : '—',
      sub: busiest ? dayLabel(busiest.date) : 'no activity',
      color: HOLO.orange,
      drill: 'spend',
    }),
  ].join('')}</div>

  <div class="live-grid">
    <div class="card"><div class="card-head"><h3>Daily activity</h3><span class="meta">${rangeText()} · by tool</span>
      <div class="right">${legend()}${metricSeg}</div></div>
      <div class="chart" id="daily-chart"></div></div>
    <div class="card"><div class="card-head"><h3>Efficiency</h3><span class="meta">${rangeText()}</span></div>
      <div class="gauges">${[
        gauge('Cache hit', k.cacheHitRate, `${fmtN(k.composition.cacheRead)} cached`, HOLO.cyan, HOLO.blue),
        budget
          ? gauge('Budget used', budgetPct, `${fmtUSD(k.monthCost)} of ${fmtUSD(budget)}`, HOLO.orange, HOLO.pink)
          : gauge(
              'Month elapsed',
              d.month.daysElapsed / d.month.daysInMonth,
              `${fmtUSD(k.monthCost)} so far`,
              HOLO.orange,
              HOLO.pink,
            ),
        gauge(
          'Subagent share',
          k.calls ? k.subagentCalls / k.calls : 0,
          `${fmtN(k.subagentCalls)} calls`,
          HOLO.violet,
          HOLO.pink,
        ),
        gauge('Claude share', claudeShare, `${fmtUSD(totals[0].cost)} of spend`, TOOL_NEON.claude, TOOL_NEON.codex),
      ].join('')}</div></div>
  </div>

  <div class="section-head"><h2>AI quality & safety</h2><span class="meta">— signals from your local logs · click a card for details</span><a class="link" href="#quality">Quality & safety ↗</a></div>
  ${qualityKpis()}

  <div class="section-head"><h2>AI Office</h2><span class="meta">— ${squad.total} detected · ${squad.running} running now</span><a class="link" href="#squad">View all ↗</a></div>
  <div class="grid squad">${squad.html}</div>

  <div class="grid two">
    <div class="card"><div class="card-head"><h3>Model mix</h3><span class="meta">tokens by model</span><div class="right">${legend()}</div></div>
      ${barList(d.models.slice(0, 8), { value: (m) => m.tokens, label: (m) => `${esc(m.model)}<small>${fmtN(m.calls)} calls${m.priced ? ' · ' + fmtUSD(m.cost) : ''}</small>`, color: (m) => seriesColor(m.tool) })}</div>
    <div class="card"><div class="card-head"><h3>When you use AI</h3><span class="meta">model calls by weekday and hour</span></div>${heatmap(d.heatmap)}</div>
  </div>

  <div class="grid two">
    <div class="card"><div class="card-head"><h3>Top projects</h3><span class="meta">by tokens</span><div class="right"><a class="link" href="#projects">All projects ↗</a></div></div>
      ${projectsTable(d.projects.slice(0, 6), true)}</div>
    <div class="card"><div class="card-head"><h3>Plan limits</h3><span class="meta">latest reading</span></div>${limitsBlock()}
      <div class="card-head" style="margin-top:18px"><h3>Most-used subagents</h3></div>
      ${barList(d.subagents.slice(0, 5), { value: (a) => a.count, label: (a) => esc(a.name), color: () => 'var(--accent)', empty: 'No subagents launched in this range.' })}</div>
  </div>
  </div>`;
}

/* ---------- usage city ---------- */
let cityTip = ''; // key of the tooltip on screen, so it is rebuilt only when it changes
function drawCity(g) {
  const { P, still, ctx } = g;
  const d = state.data;
  if (!d) return;
  const metric = state.metric;
  const fmt = metricFmt(metric);
  const buckets = usageBuckets();
  const n = buckets.length;
  g.glow();
  const X0 = -5.6;
  const X1 = 5.6;
  const Z0 = -3.3;
  const Z1 = 3;
  g.platform(X0, X1, Z0, Z1);

  // Back walls: month-to-date cumulative spend with projection (and budget), and calls by hour of day
  const m = d.month;
  let run = 0;
  const cum = m.daily.map((r) => (run += r.cost));
  const budget = d.config.monthlyBudgetUSD;
  g.wall(-5.4, -2.7, -0.1, -3.2, {
    vals: cum,
    n: m.daysInMonth,
    color: HOLO.cyan,
    title: 'MONTH TO DATE · SPEND',
    value: fmtUSD(d.kpis.monthCost),
    trend: cum.length ? [cum.length - 1, cum[cum.length - 1], m.daysInMonth - 1, m.projected] : null,
    guide: budget || null,
    guideLabel: budget ? `Budget ${fmtUSD(budget)}` : '',
  });
  const hours = Array.from({ length: 24 }, (_, h) => d.heatmap.reduce((a, row) => a + row[h], 0));
  const peakH = hours.indexOf(Math.max(...hours));
  g.wall(0.1, -3.2, 5.4, -2.7, {
    vals: hours,
    color: HOLO.blue,
    title: 'CALLS BY HOUR · PINK = NOW',
    value: `peak ${String(peakH).padStart(2, '0')}:00`,
    hot: new Date().getHours(),
  });

  // Day towers: front row Claude Code, back row Codex
  const max = Math.max(1e-9, ...buckets.flatMap((b) => SERIES.map((s) => b[s.id][metric])));
  const step = (X1 - X0 - 0.8) / n;
  const w = Math.min(0.6, step * 0.7);
  const rows = { claude: 0.7, codex: -0.7 };
  const items = [];
  const tops = [];
  buckets.forEach((b, i) => {
    const x = X0 + 0.4 + i * step + (step - w) / 2;
    const isToday = i === n - 1;
    for (const s of SERIES) {
      const v = b[s.id][metric];
      const key = `${b.date}:${s.id}`;
      const target = v > 0 ? 0.08 + 3.6 * (v / max) : 0.03;
      const cur = cityH[key] ?? 0.03;
      cityH[key] = cur + (target - cur) * (still ? 1 : 0.07);
      const z = rows[s.id];
      const h = cityH[key];
      const color = TOOL_NEON[s.id];
      items.push({
        depth: P(x, 0, z)[2],
        draw: () =>
          g.box(x, z, w, 0.62, h, color, {
            slices: step > 0.4 ? 0.35 : 0,
            glow: isToday ? 30 : 0,
            alpha: v > 0 ? 1 : 0.35,
          }),
      });
      tops.push({ at: P(x + w / 2, h, z + 0.31), b, s, v });
    }
  });
  items.sort((p, q) => p.depth - q.depth).forEach((it) => it.draw());
  g.particles();

  // Date ticks along the front edge
  ctx.fillStyle = HOLO.muted;
  ctx.font = '10.5px system-ui, sans-serif';
  const every = Math.ceil(n / 7);
  buckets.forEach((b, i) => {
    if ((n - 1 - i) % every) return;
    const q = P(X0 + 0.4 + i * step + step / 2, 0, Z1 + 0.35);
    const t = dayLabel(b.date);
    ctx.fillText(t, q[0] - ctx.measureText(t).width / 2, q[1] + 12);
  });

  // Callouts: today and the peak day for the selected metric
  const sumOf = (b) => SERIES.reduce((a, s) => a + b[s.id][metric], 0);
  const peak = buckets.reduce((a, b) => (sumOf(b) > sumOf(a) ? b : a), buckets[0]);
  const call = (b, label) => {
    const t = tops.filter((x) => x.b === b).sort((p, q) => q.v - p.v)[0]; // the taller of the day's two towers
    return t && { at: t.at, text: `${label} · ${fmt(sumOf(b))}`, color: label === 'Today' ? HOLO.pink : HOLO.cyan };
  };
  g.labels(
    [call(buckets[n - 1], 'Today'), peak !== buckets[n - 1] ? call(peak, `Peak ${bucketLabel(peak)}`) : null].filter(
      Boolean,
    ),
  );

  // Hover: nearest tower top within reach
  const p = g.pointer;
  let hit = null;
  if (p)
    for (const t of tops) {
      const dd = Math.hypot(t.at[0] - p.x, t.at[1] - p.y);
      if (dd < 16 && (!hit || dd < hit.dd)) hit = { ...t, dd };
    }
  if (hit) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(hit.at[0], hit.at[1], 6, 0, 7);
    ctx.stroke();
    const rowsHtml = SERIES.map(
      (s) =>
        `<div class="row"><span><i style="background:${TOOL_NEON[s.id]}"></i>${s.name}</span><span class="num">${fmt(hit.b[s.id][metric])}</span></div>`,
    ).join('');
    const key = `${hit.b.date}|${metric}|${p.cx}|${p.cy}`;
    if (key !== cityTip)
      showTip(
        { clientX: p.cx, clientY: p.cy },
        `<b>${bucketLabel(hit.b)}</b>${rowsHtml}<div class="row"><span>Sessions</span><span class="num">${hit.b.sessions}</span></div>`,
      );
    cityTip = key;
  } else if (cityTip) {
    hideTip();
    cityTip = '';
  }
}

function mountOverview() {
  const canvas = $('#ov-scene');
  if (canvas && state.data) isoStage(canvas, { draw: drawCity, fit: [13.4, 8.9], origin: [0.46, 0.62] });
}

if (typeof module !== 'undefined') module.exports = { emptyLogsNote };
