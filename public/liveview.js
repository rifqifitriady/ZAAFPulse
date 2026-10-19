'use strict';
/* Live monitor page: a 3D isometric scene of the running AI apps, streaming telemetry, gauges and tables.
   The page is built once per visit; the 5-second refresh patches it in place so the canvases keep animating. */

const SAMPLES = 60; // 5 minutes at 5-second polling

const liveHist = { ts: [], cpu: [], mem: [], peak: { cpu: 0, ts: 0 } };
let liveScene = null;

// Called from loadLive with every snapshot, so history keeps building on other pages too.
function recordLive(live) {
  const cpu = live.apps.reduce((a, x) => a + x.cpu, 0);
  const mem = live.apps.reduce((a, x) => a + x.memMB, 0);
  liveHist.ts.push(live.ts);
  liveHist.cpu.push(cpu);
  liveHist.mem.push(mem);
  for (const k of ['ts', 'cpu', 'mem'])
    if (liveHist[k].length > SAMPLES) liveHist[k].splice(0, liveHist[k].length - SAMPLES);
  const i = liveHist.cpu.indexOf(Math.max(...liveHist.cpu));
  liveHist.peak = { cpu: liveHist.cpu[i] || 0, ts: liveHist.ts[i] || 0 };
}

const appMeta = (a) => APPS[a.id] || { icon: 'cpu', chip: 'blue', name: a.name, role: 'AI app' };
const gb = (mb) => `${(mb / 1024).toFixed(mb >= 10240 ? 1 : 2)} GB`;

/* ---------- derived metrics ---------- */
function liveStats() {
  const live = state.live;
  const sys = live.system || null;
  const cpu = live.apps.reduce((a, x) => a + x.cpu, 0);
  const mem = live.apps.reduce((a, x) => a + x.memMB, 0);
  const procs = live.apps.reduce((a, x) => a + x.processes, 0);
  const oldest = [...live.apps].sort((a, b) => b.uptimeSec - a.uptimeSec)[0];
  const d = state.data;
  const today = d && d.daily.length ? d.daily[d.daily.length - 1] : null;
  const todayCost = today ? SERIES.reduce((a, s) => a + (today[s.id]?.cost || 0), 0) : 0;
  const todayTokens = today ? SERIES.reduce((a, s) => a + (today[s.id]?.tokens || 0), 0) : 0;
  const recent = d ? d.sessions.filter((s) => Date.now() - s.end < 30 * 60000) : [];
  return {
    cpu,
    mem,
    procs,
    oldest,
    sys,
    today,
    todayCost,
    todayTokens,
    recent,
    cores: sys ? sys.cores : 0,
    cpuOfMachine: sys ? cpu / (sys.cores * 100) : 0,
    ramUsed: sys ? (sys.memTotalMB - sys.memFreeMB) / sys.memTotalMB : 0,
    aiRam: sys ? mem / sys.memTotalMB : 0,
    load: sys ? sys.load[0] / sys.cores : 0,
  };
}

/* ---------- page ---------- */
function viewLive() {
  if (!state.live) return '<div class="skeleton" style="height:520px"></div>';
  return `<div class="holo-deck">
    <div class="hero live-hero"><div><div class="eyebrow">LIVE MONITOR</div><h1>AI mission control</h1>
      <p>Every AI app running on ${esc(state.data?.config.host || 'this machine')}, sampled every 5 seconds.</p></div>
      <div class="hero-actions"><span class="pill live-pill"><i class="live-dot"></i><span id="lv-clock">LIVE</span></span>
        <span class="pill" id="lv-samples"></span></div></div>

    <section class="holo stage">
      <canvas id="lv-scene" aria-label="3D view of running AI apps: tower height is CPU, the spike field is memory, the back walls show the last five minutes"></canvas>
      <div class="stage-tl"><div class="holo-kicker">AI FLEET · ISOMETRIC</div>
        <div class="stage-key">Towers = CPU · spike field = memory · walls = last 5 min · drag to rotate</div></div>
      <div class="stage-readouts" id="lv-readouts"></div>
      <div class="stage-legend" id="lv-legend"></div>
    </section>

    <div class="live-metrics" id="lv-metrics"></div>

    <div class="live-grid">
      <section class="holo panel"><div class="panel-head"><h3>CPU telemetry</h3><span class="meta">per app · last 5 minutes</span><div class="legend holo-legend" id="lv-stream-legend"></div></div>
        <canvas id="lv-stream" class="stream" aria-label="CPU per app over the last five minutes"></canvas></section>
      <section class="holo panel"><div class="panel-head"><h3>Machine share</h3><span class="meta">AI apps vs this machine</span></div>
        <div class="gauges" id="lv-gauges"></div></section>
    </div>

    <section class="holo panel"><div class="panel-head"><h3>Process telemetry</h3><span class="meta" id="lv-proc-meta"></span></div>
      <div class="table-wrap" id="lv-procs"></div></section>

    <div class="live-grid even">
      <section class="holo panel"><div class="panel-head"><h3>Sessions in flight</h3><span class="meta">model calls in the last 2 hours</span></div>
        <div class="table-wrap" id="lv-sessions"></div></section>
      <section class="holo panel"><div class="panel-head"><h3>Load by hour</h3><span class="meta" id="lv-hours-meta"></span></div>
        <div id="lv-hours"></div></section>
    </div>

    <div class="live-grid even">
      <section class="holo panel"><div class="panel-head"><h3>Plan limits</h3></div><div id="lv-limits"></div></section>
      <section class="holo panel"><div class="panel-head"><h3>Log collector</h3></div><div id="lv-collector"></div></section>
    </div>
  </div>`;
}

function paintLive() {
  const live = state.live;
  const st = liveStats();
  const set = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };
  $('#lv-clock') && ($('#lv-clock').textContent = `LIVE · ${new Date(live.ts).toLocaleTimeString()}`);
  set('lv-samples', `${icon('wave', 14)}${liveHist.cpu.length}/${SAMPLES} samples`);

  // Stage readouts and legend
  const top = live.apps[0];
  set(
    'lv-readouts',
    readouts([
      {
        label: 'AI CPU',
        icon: 'cpu',
        value: `${st.cpu.toFixed(1)}%`,
        sub: st.cores ? `${fmtPct(st.cpuOfMachine)} of ${st.cores} cores` : 'of one core = 100%',
        color: HOLO.cyan,
        spark: liveHist.cpu,
      },
      {
        label: 'AI memory',
        icon: 'layers',
        value: gb(st.mem),
        sub: st.sys ? `${fmtPct(st.aiRam)} of ${gb(st.sys.memTotalMB)}` : 'resident',
        color: HOLO.violet,
        spark: liveHist.mem,
      },
      {
        label: 'Hottest app',
        icon: 'zap',
        value: top ? esc(top.name) : '—',
        sub: top ? `${top.cpu.toFixed(1)}% CPU · ${st.cpu ? fmtPct(top.cpu / st.cpu) : '—'} of AI` : 'nothing running',
        color: HOLO.pink,
        p: top && st.cpu ? top.cpu / st.cpu : null,
      },
      {
        label: 'Spend today',
        icon: 'dollar',
        value: state.data ? fmtUSD(st.todayCost) : '—',
        sub: state.data ? `${fmtN(st.todayTokens)} tokens` : 'loading',
        color: HOLO.orange,
        spark: state.data ? state.data.daily.slice(-14).map((r) => SERIES.reduce((a, s) => a + r[s.id].cost, 0)) : null,
      },
    ]),
  );
  set(
    'lv-legend',
    live.apps.map((a, i) => `<span><i style="background:${appColor(i)}"></i>${esc(a.name)}</span>`).join(''),
  );
  set(
    'lv-stream-legend',
    live.apps
      .slice(0, 5)
      .map((a, i) => `<span><i style="background:${appColor(i)}"></i>${esc(a.name)}</span>`)
      .join(''),
  );

  set('lv-metrics', liveMetrics(st));
  set(
    'lv-gauges',
    [
      ['AI CPU', st.cpuOfMachine, `${st.cpu.toFixed(0)}% / ${st.cores * 100}%`, HOLO.cyan, HOLO.blue],
      [
        'RAM in use',
        st.ramUsed,
        st.sys ? `${gb(st.sys.memTotalMB - st.sys.memFreeMB)} used` : '—',
        HOLO.violet,
        HOLO.pink,
      ],
      ['AI share of RAM', st.aiRam, gb(st.mem), HOLO.pink, HOLO.orange],
      [
        'Load / cores',
        Math.min(1, st.load),
        st.sys ? `${st.sys.load[0].toFixed(2)} on ${st.cores}` : '—',
        HOLO.orange,
        '#ffd25c',
      ],
    ]
      .map(([l, p, s, c1, c2]) => gauge(l, p, s, c1, c2))
      .join(''),
  );

  set(
    'lv-proc-meta',
    `${live.apps.length} running · ${live.installed.filter((id) => !live.apps.some((a) => a.id === id)).length} installed, idle`,
  );
  set('lv-procs', procTable(st));
  set('lv-sessions', sessionsTable());
  set('lv-hours', hourProfile());
  set('lv-limits', state.data ? limitsBlock() : '<div class="empty">Loading usage…</div>');
  const ix = live.index || {};
  set(
    'lv-collector',
    `<div class="limit"><div class="limit-top"><b>Status</b><span>${ix.indexing ? `Indexing ${ix.done}/${ix.total} files` : 'Up to date'}</span></div></div>
    <div class="limit"><div class="limit-top"><b>Last scan</b><span>${ix.lastScan ? `${ago(ix.lastScan)} · took ${(ix.lastDurationMs / 1000).toFixed(1)}s` : 'pending'}</span></div></div>
    <div class="limit"><div class="limit-top"><b>Machine uptime</b><span>${st.sys ? dur(st.sys.uptimeSec) : '—'}</span></div></div>
    <div class="limit"><div class="limit-top"><b>Sources</b><span>~/.claude/projects · ~/.codex/sessions</span></div></div>
    <div class="kpi-sub">Logs are rescanned every minute; only changed files are re-read. Message text is never stored.</div>`,
  );
}

function liveMetrics(st) {
  const live = state.live;
  const d = state.data;
  const hist = liveHist.cpu;
  const tile = (label, value, sub, color, drill, p, spark) => metricTile({ label, value, sub, color, drill, p, spark });
  const spark = (vals, c) => `<div class="metric-spark">${sparkline(vals, c)}</div>`;
  const items = [
    tile(
      'Active AI apps',
      String(live.apps.length).padStart(2, '0'),
      `${live.installed.length} installed`,
      HOLO.cyan,
      'apps',
      live.installed.length ? live.apps.length / live.installed.length : 0,
    ),
    tile(
      'AI CPU now',
      `${st.cpu.toFixed(1)}%`,
      st.cores ? `${pct(st.cpuOfMachine)} of ${st.cores} cores` : 'last 5 minutes',
      HOLO.cyan,
      'apps',
      st.cpuOfMachine,
      hist,
    ),
    tile(
      'AI memory',
      gb(st.mem),
      st.sys ? `${pct(st.aiRam)} of RAM` : 'last 5 minutes',
      HOLO.violet,
      'apps',
      st.aiRam,
      liveHist.mem,
    ),
    tile('Processes', whole.format(st.procs), 'including helpers', HOLO.blue, 'apps'),
    tile(
      'Peak CPU · 5m',
      `${liveHist.peak.cpu.toFixed(1)}%`,
      liveHist.peak.ts ? `reached ${ago(liveHist.peak.ts)}` : '—',
      HOLO.pink,
      '',
      st.cores ? liveHist.peak.cpu / (st.cores * 100) : null,
      hist,
    ),
    tile(
      'Avg CPU · 5m',
      `${avg(hist).toFixed(1)}%`,
      `σ ${Math.sqrt(avg(hist.map((v) => (v - avg(hist)) ** 2))).toFixed(1)} pts`,
      HOLO.pink,
      '',
      null,
      hist,
    ),
    tile(
      'Longest uptime',
      st.oldest ? dur(st.oldest.uptimeSec) : '—',
      st.oldest ? esc(st.oldest.name) : 'nothing running',
      HOLO.violet,
    ),
    tile(
      'System RAM',
      st.sys ? fmtPct(st.ramUsed) : '—',
      st.sys ? `${gb(st.sys.memTotalMB - st.sys.memFreeMB)} of ${gb(st.sys.memTotalMB)}` : 'unavailable',
      HOLO.orange,
      '',
      st.sys ? st.ramUsed : null,
    ),
    tile(
      'Load average',
      st.sys ? st.sys.load[0].toFixed(2) : '—',
      st.sys ? `5m ${st.sys.load[1]} · 15m ${st.sys.load[2]} · ${st.cores} cores` : 'unavailable',
      HOLO.orange,
      '',
      st.sys ? st.load : null,
    ),
    tile(
      'Spend today',
      d ? fmtUSD(st.todayCost) : '—',
      d ? `${fmtN(st.todayTokens)} tokens · API list price` : 'loading',
      HOLO.orange,
      d ? 'spend' : '',
    ),
    tile(
      'Sessions · 30m',
      d ? String(st.recent.length) : '—',
      d ? `${fmtN(st.recent.reduce((a, s) => a + s.tokens, 0))} tokens in flight` : 'loading',
      HOLO.cyan,
      d ? 'sessions' : '',
    ),
    tile(
      'Month projection',
      d ? fmtUSD(d.month.projected) : '—',
      d ? `cache hit ${fmtPct(d.kpis.cacheHitRate)}` : 'loading',
      HOLO.blue,
      d ? 'spend' : '',
      d && d.config.monthlyBudgetUSD ? d.month.projected / d.config.monthlyBudgetUSD : null,
    ),
  ];
  return items.join('');
}

function procTable(st) {
  const live = state.live;
  const maxCpu = Math.max(1, ...live.apps.map((a) => a.cpu));
  const maxMem = Math.max(1, ...live.apps.map((a) => a.memMB));
  const rows = live.apps.map((a, i) => {
    const m = appMeta(a);
    const h = state.history[a.id] || [];
    const c = appColor(i);
    return `<tr><td class="num muted">${String(i + 1).padStart(2, '0')}</td>
      <td><div class="app-cell"><span class="agent-icon chip ${m.chip}">${icon(m.icon, 15)}</span><div><b>${esc(a.name)}</b><small>${esc(m.role || '')}</small></div></div></td>
      <td><span class="status running"><i></i>Running</span></td>
      <td class="r num">${a.processes}</td>
      <td class="r"><div class="cell-bar"><span class="num">${a.cpu.toFixed(1)}%</span><i style="width:${(a.cpu / maxCpu) * 100}%;background:${c}"></i></div></td>
      <td class="spark-cell">${sparkline(h, c)}</td>
      <td class="r num">${Math.max(0, ...h).toFixed(1)}%</td>
      <td class="r"><div class="cell-bar"><span class="num">${whole.format(a.memMB)} MB</span><i style="width:${(a.memMB / maxMem) * 100}%;background:${HOLO.violet}"></i></div></td>
      <td class="r num">${st.mem ? fmtPct(a.memMB / st.mem) : '—'}</td>
      <td class="r num">${dur(a.uptimeSec)}</td></tr>`;
  });
  const idle = live.installed
    .filter((id) => !live.apps.some((a) => a.id === id))
    .map((id) => {
      const m = APPS[id] || { icon: 'cpu', chip: 'blue', name: id };
      return `<tr class="idle-row"><td class="num muted">—</td><td><div class="app-cell"><span class="agent-icon chip ${m.chip}">${icon(m.icon, 15)}</span><div><b>${esc(m.name)}</b><small>${esc(m.role || '')}</small></div></div></td>
      <td><span class="status idle"><i></i>Idle</span></td><td colspan="7" class="muted">Installed, not running</td></tr>`;
    });
  if (!rows.length && !idle.length) return '<div class="empty">No AI apps are running.</div>';
  return `<table class="holo-table"><thead><tr><th>#</th><th>App</th><th>Status</th><th class="r">Proc</th><th class="r">CPU</th><th>Trend · 5m</th><th class="r">Peak</th><th class="r">Memory</th><th class="r">Mem share</th><th class="r">Uptime</th></tr></thead>
    <tbody>${rows.join('')}${idle.join('')}</tbody></table>`;
}

function sessionsTable() {
  const d = state.data;
  if (!d) return '<div class="empty">Loading usage…</div>';
  const rows = d.sessions.filter((s) => Date.now() - s.end < 2 * 3600000).slice(0, 8);
  if (!rows.length) return '<div class="empty">No model calls in the last 2 hours.</div>';
  return `<table class="holo-table"><thead><tr><th>Project</th><th>Tool · model</th><th class="r">Tokens</th><th class="r">Cost</th><th class="r">Last call</th></tr></thead><tbody>
    ${rows
      .map((s) => {
        const hot = Date.now() - s.end < 5 * 60000;
        return `<tr><td class="clip"><b title="${esc(s.project)}">${esc(s.project)}</b><small class="block muted">${whole.format(s.calls)} calls${s.branch && s.branch !== 'HEAD' ? ` · ${esc(s.branch)}` : ''}</small></td>
        <td><span class="tool-dot" style="background:${seriesColor(s.tool)}"></span>${esc(toolName(s.tool))}<small class="block muted">${esc((s.model || '—').replace(/^claude-/, ''))}</small></td>
        <td class="r num">${fmtN(s.tokens)}</td><td class="r num">${fmtUSD(s.cost)}</td>
        <td class="r">${hot ? '<span class="hot"><i></i>active</span>' : `<span class="muted">${ago(s.end)}</span>`}</td></tr>`;
      })
      .join('')}</tbody></table>`;
}

// Model calls by hour for today's weekday, from the range heatmap; the current hour glows.
function hourProfile() {
  const d = state.data;
  if (!d) return '<div class="empty">Loading usage…</div>';
  const now = new Date();
  const row = d.heatmap[now.getDay()];
  const hr = now.getHours();
  const meta = document.getElementById('lv-hours-meta');
  if (meta) meta.textContent = `${now.toLocaleDateString('en', { weekday: 'long' })}s · ${rangeText()}`;
  const max = Math.max(1, ...row);
  const W = 480;
  const H = 170;
  const bw = W / 24;
  const bars = row
    .map((v, i) => {
      const h = Math.max(2, (v / max) * (H - 30));
      const x = i * bw + 2;
      const y = H - 18 - h;
      const cur = i === hr;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="url(#${cur ? 'lvh-hot' : 'lvh'})" ${cur ? `style="filter:drop-shadow(0 0 6px ${HOLO.pink})"` : ''}
      data-tip="${String(i).padStart(2, '0')}:00 · ${whole.format(v)} calls"/>${i % 3 === 0 ? `<text x="${(x + bw / 2 - 2).toFixed(1)}" y="${H - 4}" text-anchor="middle">${i}</text>` : ''}`;
    })
    .join('');
  return `<svg class="hours" viewBox="0 0 ${W} ${H}" role="img" aria-label="Model calls by hour of day">
    <defs><linearGradient id="lvh" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${HOLO.blue}" stop-opacity=".35"/><stop offset="1" stop-color="${HOLO.cyan}"/></linearGradient>
    <linearGradient id="lvh-hot" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${HOLO.orange}"/><stop offset="1" stop-color="${HOLO.pink}"/></linearGradient></defs>${bars}</svg>
    <div class="kpi-sub">Now: ${String(hr).padStart(2, '0')}:00 · ${whole.format(row[hr])} calls at this hour in the range · busiest ${String(row.indexOf(max)).padStart(2, '0')}:00</div>`;
}

/* ---------- 3D isometric scene ---------- */
const towerH = {}; // eased tower heights, kept across remounts so towers do not regrow
function drawLiveScene(g) {
  const { P, still } = g;
  g.glow();
  g.platform(-5.4, 5.4, -3.3, 3);
  // Back walls: rolling 5-minute history of AI CPU (left) and AI memory (right), pink = running mean
  const mean = (v) => (v.length > 1 ? [-0.5, avg(v), SAMPLES - 0.5, avg(v)] : null);
  const pad = (v) =>
    Array(SAMPLES - v.length)
      .fill(0)
      .concat(v);
  g.wall(-5.2, -2.7, -0.1, -3.2, {
    vals: pad(liveHist.cpu),
    n: SAMPLES,
    color: HOLO.cyan,
    title: 'AI CPU · 5 MIN',
    value: `${(liveHist.cpu.at(-1) || 0).toFixed(1)}%`,
    trend: mean(liveHist.cpu),
  });
  g.wall(0.1, -3.2, 5.2, -2.7, {
    vals: pad(liveHist.mem),
    n: SAMPLES,
    color: HOLO.blue,
    title: 'AI MEMORY · 5 MIN',
    value: gb(liveHist.mem.at(-1) || 0),
    trend: mean(liveHist.mem),
  });

  // Objects on the platform, painted far to near
  const apps = state.live ? state.live.apps.slice(0, 8) : [];
  const items = [];
  const maxCpu = Math.max(20, ...apps.map((a) => a.cpu)) * 1.08;
  const spot = (i) => [-4.6 + i * 0.92, -1.4 + i * 0.5];
  apps.forEach((a, i) => {
    const cur = towerH[a.id] ?? 0.2;
    towerH[a.id] = cur + (0.3 + 4.1 * (a.cpu / maxCpu) - cur) * (still ? 1 : 0.06);
    const [x, z] = spot(i);
    items.push({ depth: P(x, 0, z)[2], draw: () => g.box(x, z, 0.8, 0.8, towerH[a.id], appColor(i)) });
  });
  // Memory field: one row band per app (rows ∝ memory), spike height ∝ that app's memory
  const memTotal = apps.reduce((acc, a) => acc + a.memMB, 0) || 1;
  const maxMem = Math.max(1, ...apps.map((a) => a.memMB));
  const R = 9;
  const C = 22;
  const FX0 = 0.9;
  const FX1 = 5;
  const FZ0 = -2.4;
  const FZ1 = 1.2;
  let row = 0;
  apps.forEach((a, ai) => {
    const rows = ai === apps.length - 1 ? R - row : Math.max(1, Math.round((a.memMB / memTotal) * R));
    for (let r = row; r < Math.min(R, row + rows); r++) {
      for (let c = 0; c < C; c++) {
        const x = FX0 + ((c + 0.5) / C) * (FX1 - FX0);
        const z = FZ0 + ((r + 0.5) / R) * (FZ1 - FZ0);
        const n =
          0.55 +
          0.45 *
            Math.sin(c * 1.7 + r * 2.3 + (still ? 0 : g.t * 1.6)) *
            Math.cos(c * 0.6 - r * 0.9 + (still ? 0 : g.t * 0.7));
        const h = 0.12 + 1.5 * (a.memMB / maxMem) * n;
        items.push({ depth: P(x, 0, z)[2], draw: () => g.spike(x, z, h, appColor(ai)) });
      }
    }
    row += rows;
  });
  items.sort((p, q) => p.depth - q.depth).forEach((it) => it.draw());
  g.particles();
  g.labels(
    apps.map((a, i) => {
      const [x, z] = spot(i);
      return {
        at: P(x + 0.4, (towerH[a.id] || 0) + 0.05, z + 0.4),
        text: `${a.name}  ${a.cpu.toFixed(1)}%`,
        color: appColor(i),
      };
    }),
  );
  drawStream(g.t, still);
}

// Streaming CPU chart: per-app glowing lines over spiky total-CPU bars. Drawn inside the scene's frame loop.
function drawStream(t, still) {
  const cv = document.getElementById('lv-stream');
  if (!cv || !state.live) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = W * dpr;
    cv.height = H * dpr;
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const m = { l: 40, r: 10, t: 10, b: 22 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const apps = state.live.apps.slice(0, 5);
  const series = apps.map((a) => state.history[a.id] || []);
  const max = niceMax(Math.max(10, ...liveHist.cpu, ...series.flat()));
  const x = (i, len) => m.l + ((i + SAMPLES - len) / (SAMPLES - 1)) * iw;
  const y = (v) => m.t + ih - (v / max) * ih;
  ctx.font = '10.5px system-ui, sans-serif';
  ctx.fillStyle = HOLO.muted;
  ctx.strokeStyle = HOLO.line;
  ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const yy = m.t + (ih * k) / 4;
    ctx.beginPath();
    ctx.moveTo(m.l, yy);
    ctx.lineTo(W - m.r, yy);
    ctx.stroke();
    ctx.fillText(`${Math.round(max * (1 - k / 4))}%`, 4, yy + 4);
  }
  ['−5m', '−4m', '−3m', '−2m', '−1m', 'now'].forEach((l, k) =>
    ctx.fillText(l, m.l + (iw * k) / 5 - (k === 5 ? 18 : 8), H - 6),
  );
  // Spiky bars of total AI CPU
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const tot = liveHist.cpu;
  const bw = Math.max(1.5, iw / SAMPLES - 3);
  tot.forEach((v, i) => {
    const xx = x(i, tot.length);
    const hh = (v / max) * ih;
    const gr = ctx.createLinearGradient(0, m.t + ih - hh, 0, m.t + ih);
    gr.addColorStop(0, 'rgba(77, 232, 255, .55)');
    gr.addColorStop(1, 'rgba(77, 232, 255, .04)');
    ctx.fillStyle = gr;
    ctx.fillRect(xx - bw / 2, m.t + ih - hh, bw, hh);
  });
  // Per-app lines
  series.forEach((vals, si) => {
    if (vals.length < 2) return;
    const c = appColor(si);
    ctx.beginPath();
    vals.forEach((v, i) => (i ? ctx.lineTo(x(i, vals.length), y(v)) : ctx.moveTo(x(i, vals.length), y(v))));
    ctx.strokeStyle = c;
    ctx.lineWidth = 2;
    ctx.shadowColor = c;
    ctx.shadowBlur = 10;
    ctx.stroke();
    const lx = x(vals.length - 1, vals.length);
    const ly = y(vals[vals.length - 1]);
    const pulse = still ? 3.5 : 3 + 1.8 * (0.5 + 0.5 * Math.sin(t * 4 + si));
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(lx, ly, pulse, 0, 7);
    ctx.fill();
  });
  ctx.restore();
}

/* ---------- lifecycle ---------- */
function mountLive() {
  const canvas = $('#lv-scene');
  if (!canvas || !state.live) return;
  paintLive();
  liveScene = isoStage(canvas, { draw: drawLiveScene });
}
// Refresh in place; false when the page is not mounted (the caller then does a full render).
function updateLive() {
  if (!liveScene || !isoStages.has(liveScene) || !document.contains(liveScene.canvas)) return false;
  paintLive();
  return true;
}
