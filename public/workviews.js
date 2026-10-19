'use strict';
/* Sessions, Projects and Agents & skills as holographic decks: a 3D scene, a metric strip, then the
   tables and lists, all restyled by the deck's theme tokens. */

const WORK_NEON = { claude: '#6d7cff', codex: '#ff8a4c' };
const workH = {}; // eased tower heights per scene item, kept across re-renders (search, filters, refresh)
const ease = (key, target, still) => {
  const cur = workH[key] ?? 0.02;
  workH[key] = cur + (target - cur) * (still ? 1 : 0.08);
  return workH[key];
};
const workStage = (
  id,
  kicker,
  key,
  aria,
  legendHtml = '',
) => `<section class="holo stage work-stage"><canvas id="${id}" aria-label="${esc(aria)}"></canvas>
  <div class="stage-tl"><div class="holo-kicker">${kicker}</div><div class="stage-key">${key}</div></div>${legendHtml ? `<div class="stage-legend">${legendHtml}</div>` : ''}</section>`;
const toolLegend = () =>
  SERIES.map((s) => `<span><i style="background:${WORK_NEON[s.id]}"></i>${s.name}</span>`).join('');

// Hover helper shared by the three scenes: nearest point within reach shows its tooltip.
function hoverTip(g, points, stateBox) {
  const p = g.pointer;
  let hit = null;
  if (p)
    for (const t of points) {
      const d = Math.hypot(t.at[0] - p.x, t.at[1] - p.y);
      if (d < 16 && (!hit || d < hit.d)) hit = { ...t, d };
    }
  if (hit) {
    g.ctx.strokeStyle = '#fff';
    g.ctx.lineWidth = 1.5;
    g.ctx.beginPath();
    g.ctx.arc(hit.at[0], hit.at[1], 6, 0, 7);
    g.ctx.stroke();
    const key = `${hit.key}|${p.cx}|${p.cy}`;
    if (key !== stateBox.tip) showTip({ clientX: p.cx, clientY: p.cy }, hit.html());
    stateBox.tip = key;
  } else if (stateBox.tip) {
    hideTip();
    stateBox.tip = '';
  }
}

/* ---------- Sessions ---------- */
function viewSessions() {
  const d = state.data;
  const k = d.kpis;
  const wSum = (f) => d.daily.map((r) => SERIES.reduce((x, t) => x + r[t.id][f], 0)); // daily series for card sparklines
  const rows = d.sessions.filter(
    (s) =>
      (state.toolFilter === 'all' || s.tool === state.toolFilter) &&
      matches(s.project, s.projectPath, s.model, s.id, s.branch, s.entrypoint),
  );
  const all = d.sessions;
  const durs = all.map((s) => (s.end - s.start) / 1000).sort((a, b) => a - b);
  const longest = [...all].sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  const today = new Date().toDateString();
  const byDay = {};
  for (const s of all) {
    const key = new Date(s.start).toDateString();
    byDay[key] = (byDay[key] || 0) + 1;
  }
  const busiest = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
  const n = Math.max(1, all.length);
  const filter = `<div class="segmented" role="group" aria-label="Tool">${[
    ['all', 'All tools'],
    ...SERIES.map((x) => [x.id, x.name]),
  ]
    .map(([v, l]) => `<button data-tool="${v}" aria-pressed="${state.toolFilter === v}">${l}</button>`)
    .join('')}</div>`;
  const note =
    d.totalSessions > d.sessions.length ? ` Showing the latest ${d.sessions.length} of ${d.totalSessions}.` : '';
  return `<div class="holo-deck">
    ${hero('SESSIONS', 'Session log', `Every AI session with recorded usage in the ${rangeText()}.${note}`)}
    ${workStage(
      'ss-scene',
      'SESSION CONSTELLATION · DAY × HOUR',
      'One block per session: across = day, depth = hour it started, height = tokens (log scale), width = duration · hover a block',
      '3D chart of sessions by day and start hour, height is tokens',
      toolLegend(),
    )}
    <div class="live-metrics">${[
      metricTile({
        spark: wSum('sessions'),
        label: 'Sessions',
        value: whole.format(k.sessions),
        sub: `${delta(k.sessions, k.prevSessions)} vs previous period`,
        color: HOLO.cyan,
        drill: 'sessions',
      }),
      metricTile({
        label: 'Median duration',
        value: dur(durs[Math.floor(durs.length / 2)] || 0),
        sub: `average ${dur(durs.reduce((a, b) => a + b, 0) / n)}`,
        color: HOLO.cyan,
      }),
      metricTile({
        label: 'Longest session',
        value: longest ? dur((longest.end - longest.start) / 1000) : '—',
        sub: longest ? esc(longest.project) : 'none',
        color: HOLO.violet,
      }),
      metricTile({
        label: 'Prompts / session',
        value: (k.prompts / Math.max(1, k.sessions)).toFixed(1),
        sub: `${whole.format(k.prompts)} prompts typed`,
        color: HOLO.blue,
      }),
      metricTile({
        spark: wSum('calls').map((c, i) => c / Math.max(1, wSum('sessions')[i])),
        label: 'Calls / session',
        value: fmtN(k.calls / Math.max(1, k.sessions)),
        sub: `${fmtN(k.calls)} model calls`,
        color: HOLO.blue,
      }),
      metricTile({
        spark: wSum('tokens').map((c, i) => c / Math.max(1, wSum('sessions')[i])),
        label: 'Tokens / session',
        value: fmtN(k.tokens / Math.max(1, k.sessions)),
        sub: `${fmtN(k.tokens)} in total`,
        color: HOLO.violet,
        drill: 'tokens',
      }),
      metricTile({
        spark: wSum('cost').map((c, i) => c / Math.max(1, wSum('sessions')[i])),
        label: 'Cost / session',
        value: fmtUSD(k.cost / Math.max(1, k.sessions)),
        sub: `${fmtUSD(k.cost)} in total`,
        color: HOLO.orange,
        drill: 'spend',
      }),
      metricTile({
        label: 'Priciest session',
        value: d.topCostSessions[0] ? fmtUSD(d.topCostSessions[0].cost) : '—',
        sub: d.topCostSessions[0] ? esc(d.topCostSessions[0].project) : 'none',
        color: HOLO.orange,
      }),
      metricTile({
        label: 'With subagents',
        value: pct(all.filter((s) => s.subCalls).length / n),
        sub: `${whole.format(all.filter((s) => s.subCalls).length)} sessions delegated work`,
        color: HOLO.pink,
        p: all.filter((s) => s.subCalls).length / n,
      }),
      metricTile({
        label: 'Multi-model',
        value: whole.format(all.filter((s) => s.models.length > 1).length),
        sub: 'sessions that switched models',
        color: HOLO.pink,
      }),
      metricTile({ label: 'Today', value: whole.format(byDay[today] || 0), sub: 'sessions started', color: HOLO.cyan }),
      metricTile({
        spark: wSum('sessions'),
        label: 'Busiest day',
        value: busiest ? whole.format(busiest[1]) : '—',
        sub: busiest
          ? new Date(busiest[0]).toLocaleDateString('en', { month: 'short', day: 'numeric', weekday: 'short' })
          : 'none',
        color: HOLO.blue,
      }),
    ].join('')}</div>
    <section class="holo panel"><div class="panel-head"><h3>All sessions</h3><span class="meta">${rows.length} shown</span><div class="right">${filter}</div></div>
      ${state.search ? `<p class="kpi-sub">Filtered by “${esc(state.search)}”</p>` : ''}
      ${
        rows.length
          ? `<div class="table-wrap"><table class="holo-table"><thead><tr><th>Session</th><th>Tool</th><th>Model</th><th>Started</th><th class="r">Duration</th><th class="r">Prompts</th><th class="r">Calls</th><th class="r">Tokens</th><th class="r">Est. cost</th></tr></thead><tbody>
      ${rows
        .map(
          (
            s,
          ) => `<tr><td><b class="clip" title="${esc(s.projectPath)}">${esc(s.project)}</b><small class="block muted clip">${esc(s.branch && s.branch !== 'HEAD' ? s.branch + ' · ' : '')}${esc((s.entrypoint || '').replace(/^claude-/, ''))} · ${esc(s.id.slice(0, 8))}</small></td>
        <td><span class="tool-dot" style="background:${WORK_NEON[s.tool]}"></span>${esc(SERIES.find((x) => x.id === s.tool)?.name)}</td>
        <td class="muted">${esc((s.model || '').replace(/^claude-/, ''))}${s.models.length > 1 ? ` +${s.models.length - 1}` : ''}</td>
        <td class="muted">${fmtDate(s.start)}</td><td class="r num">${dur((s.end - s.start) / 1000)}</td>
        <td class="r num">${s.prompts}</td><td class="r num">${fmtN(s.calls)}${s.subCalls ? `<small class="block muted">${fmtN(s.subCalls)} by subagents</small>` : ''}</td>
        <td class="r num">${fmtN(s.tokens)}</td><td class="r num"><b>${s.cost ? fmtUSD(s.cost) : '—'}</b></td></tr>`,
        )
        .join('')}
      </tbody></table></div>`
          : holoEmpty('No sessions match.')
      }</section>
  </div>`;
}

function mountSessions() {
  const canvas = $('#ss-scene');
  if (!canvas || !state.data) return;
  const d = state.data;
  const sessions = d.sessions.filter(
    (s) =>
      (state.toolFilter === 'all' || s.tool === state.toolFilter) &&
      matches(s.project, s.projectPath, s.model, s.id, s.branch, s.entrypoint),
  );
  const day0 = new Date(d.range.start);
  day0.setHours(0, 0, 0, 0);
  const nDays = Math.max(1, Math.round((Date.now() - day0) / 86400000) + 1);
  const k = Math.ceil(nDays / 40);
  const cols = Math.ceil(nDays / k);
  const maxLog = Math.max(1, ...sessions.map((s) => Math.log10(1 + s.tokens)));
  const topCost = new Set(
    [...sessions]
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 2)
      .map((s) => s.id),
  );
  const perDay = Array(cols).fill(0);
  const costDay = Array(cols).fill(0);
  const col = (s) => Math.min(cols - 1, Math.floor(Math.floor((s.start - day0) / 86400000) / k));
  for (const s of sessions) {
    const c = col(s);
    if (c >= 0) {
      perDay[c]++;
      costDay[c] += s.cost;
    }
  }
  const hov = { tip: '' };
  isoStage(canvas, {
    fit: [13.4, 8.8],
    origin: [0.47, 0.63],
    draw(g) {
      const { P, ctx, still } = g;
      const X0 = -5.8;
      const X1 = 5.8;
      const Z0 = -2.4;
      const Z1 = 2.4;
      g.glow();
      g.platform(X0, X1, -3.3, 2.9);
      g.wall(-5.6, -2.8, -0.1, -3.1, {
        vals: perDay,
        color: HOLO.cyan,
        title: 'SESSIONS PER DAY',
        value: whole.format(sessions.length),
        hot: cols - 1,
        H: 2.6,
      });
      g.wall(0.1, -3.1, 5.6, -2.8, {
        vals: costDay,
        color: HOLO.orange,
        title: 'COST PER DAY',
        value: fmtUSD(costDay.reduce((a, b) => a + b, 0)),
        hot: cols - 1,
        H: 2.6,
      });
      const step = (X1 - X0) / cols;
      const items = [];
      const pts = [];
      for (const s of sessions) {
        const c = col(s);
        if (c < 0) continue;
        const hr = new Date(s.start).getHours() + new Date(s.start).getMinutes() / 60;
        const w = Math.min(step * 0.9, 0.12 + Math.min(1, (s.end - s.start) / (4 * 3600000)) * step * 0.8);
        const x = X0 + c * step + (step - w) / 2;
        const z = Z0 + (hr / 24) * (Z1 - Z0);
        const h = ease(`ss:${s.tool}:${s.id}`, 0.05 + 2.8 * (Math.log10(1 + s.tokens) / maxLog) ** 2, still);
        const color = WORK_NEON[s.tool];
        const hot = topCost.has(s.id);
        items.push({
          depth: P(x, 0, z)[2],
          draw: () => g.box(x, z, w, 0.16, h, hot ? '#ff5ca8' : color, { slices: 0, glow: hot ? 18 : 0 }),
        });
        pts.push({
          at: P(x + w / 2, h, z + 0.08),
          key: s.id,
          s,
          html: () =>
            `<b>${esc(s.project)}</b><div class="row"><span>Started</span><span>${fmtDate(s.start)}</span></div><div class="row"><span>Duration</span><span>${dur((s.end - s.start) / 1000)}</span></div><div class="row"><span>Model</span><span>${esc(s.model || '—')}</span></div><div class="row"><span>Prompts · calls</span><span class="num">${s.prompts} · ${fmtN(s.calls)}</span></div><div class="row"><span>Tokens</span><span class="num">${fmtN(s.tokens)}</span></div><div class="row"><span>Est. cost</span><span class="num">${s.cost ? fmtUSD(s.cost) : '—'}</span></div>`,
        });
      }
      items.sort((a, b) => a.depth - b.depth).forEach((it) => it.draw());
      ctx.fillStyle = HOLO.muted;
      ctx.font = '10.5px system-ui, sans-serif';
      for (const hr of [0, 6, 12, 18]) {
        const q = P(X1 + 0.1, 0, Z0 + (hr / 24) * (Z1 - Z0));
        ctx.fillText(`${String(hr).padStart(2, '0')}:00`, q[0] + 6, q[1] + 4);
      }
      const every = Math.ceil(cols / 7);
      for (let c = 0; c < cols; c += every) {
        const q = P(X0 + (c + 0.5) * step, 0, 3.15);
        const t = new Date(day0.getTime() + c * k * 86400000).toLocaleDateString('en', {
          month: 'short',
          day: 'numeric',
        });
        ctx.fillText(t, q[0] - ctx.measureText(t).width / 2, q[1] + 12);
      }
      g.particles();
      g.labels(
        pts
          .filter((p) => topCost.has(p.s.id))
          .map((p) => ({ at: p.at, text: `${p.s.project} · ${fmtUSD(p.s.cost)}`, color: HOLO.pink })),
      );
      hoverTip(g, pts, hov);
    },
  });
}

/* ---------- Projects ---------- */
function viewProjects() {
  const d = state.data;
  const all = d.projects;
  const rows = all.filter((p) => matches(p.name, p.path));
  const tok = all.reduce((a, p) => a + p.tokens, 0) || 1;
  const cost = all.reduce((a, p) => a + p.cost, 0);
  const byTok = [...all].sort((a, b) => b.tokens - a.tokens);
  const byCost = [...all].sort((a, b) => b.cost - a.cost);
  const bySess = [...all].sort((a, b) => b.sessions - a.sessions);
  const active7 = all.filter((p) => Date.now() - p.last < 7 * 86400000).length;
  const last = [...all].sort((a, b) => b.last - a.last)[0];
  const n = Math.max(1, all.length);
  return `<div class="holo-deck">
    ${hero('PROJECTS', 'Where AI time goes', `Usage grouped by working folder for the ${rangeText()}.`)}
    ${workStage('pj-scene', 'PROJECT SKYLINE', 'One tower per project: height = tokens, footprint = sessions, glow = cost · hover a tower', '3D skyline of projects by tokens', toolLegend() + '<span><i style="background:#ff5ca8"></i>Top cost</span>')}
    <div class="live-metrics">${[
      metricTile({ label: 'Projects', value: whole.format(all.length), sub: rangeText(), color: HOLO.cyan }),
      metricTile({
        label: 'Active this week',
        value: whole.format(active7),
        sub: `${pct(active7 / n)} of projects`,
        color: HOLO.cyan,
        p: active7 / n,
      }),
      metricTile({
        label: 'Top project',
        value: byTok[0] ? esc(byTok[0].name) : '—',
        sub: byTok[0] ? `${pct(byTok[0].tokens / tok)} of all tokens` : 'none',
        color: HOLO.violet,
        p: byTok[0] ? byTok[0].tokens / tok : null,
      }),
      metricTile({
        label: 'Top 3 share',
        value: pct(byTok.slice(0, 3).reduce((a, p) => a + p.tokens, 0) / tok),
        sub: 'of tokens',
        color: HOLO.violet,
      }),
      metricTile({
        label: 'Priciest project',
        value: byCost[0] ? fmtUSD(byCost[0].cost) : '—',
        sub: byCost[0] ? esc(byCost[0].name) : 'none',
        color: HOLO.orange,
      }),
      metricTile({
        label: 'Cost / project',
        value: fmtUSD(cost / n),
        sub: `${fmtUSD(cost)} in total`,
        color: HOLO.orange,
        drill: 'spend',
      }),
      metricTile({
        label: 'Most sessions',
        value: bySess[0] ? whole.format(bySess[0].sessions) : '—',
        sub: bySess[0] ? esc(bySess[0].name) : 'none',
        color: HOLO.blue,
      }),
      metricTile({
        label: 'Sessions / project',
        value: (all.reduce((a, p) => a + p.sessions, 0) / n).toFixed(1),
        sub: 'average',
        color: HOLO.blue,
      }),
      metricTile({
        label: 'Tokens / project',
        value: fmtN(tok / n),
        sub: `median ${fmtN((byTok[Math.floor(byTok.length / 2)] || { tokens: 0 }).tokens)}`,
        color: HOLO.pink,
      }),
      metricTile({
        label: 'Both tools',
        value: whole.format(all.filter((p) => Object.keys(p.tools).length > 1).length),
        sub: 'used Claude Code and Codex',
        color: HOLO.pink,
      }),
      metricTile({
        label: 'Output tokens',
        value: fmtN(all.reduce((a, p) => a + p.output, 0)),
        sub: 'written by the models',
        color: HOLO.violet,
      }),
      metricTile({
        label: 'Last active',
        value: last ? esc(last.name) : '—',
        sub: last ? ago(last.last) : 'none',
        color: HOLO.cyan,
      }),
    ].join('')}</div>
    <div class="live-grid even">
      ${panel('Tokens by project', 'top 10', barList(byTok.slice(0, 10), { value: (p) => p.tokens, label: (p) => esc(p.name), color: (p) => WORK_NEON[Object.keys(p.tools)[0]] || HOLO.cyan }))}
      ${panel(
        'Cost by project',
        'top 10 · API list price',
        barList(
          byCost.slice(0, 10).filter((p) => p.cost > 0),
          {
            value: (p) => p.cost,
            label: (p) => esc(p.name),
            color: () => HOLO.orange,
            fmt: fmtUSD,
            empty: 'No priced usage.',
          },
        ),
      )}
    </div>
    <section class="holo panel"><div class="panel-head"><h3>All projects</h3><span class="meta">${rows.length} shown${state.search ? ` · filtered by “${esc(state.search)}”` : ''}</span></div>${projectsTable(rows, false).replace('<table class="', '<table class="holo-table ')}</section>
  </div>`;
}

function mountProjects() {
  const canvas = $('#pj-scene');
  if (!canvas || !state.data) return;
  const list = [...state.data.projects]
    .filter((p) => matches(p.name, p.path))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 14);
  const maxT = Math.max(1, ...list.map((p) => p.tokens));
  const maxS = Math.max(1, ...list.map((p) => p.sessions));
  const topCost = new Set(
    [...list]
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 3)
      .filter((p) => p.cost > 0)
      .map((p) => p.path),
  );
  const hov = { tip: '' };
  isoStage(canvas, {
    fit: [13, 8.6],
    origin: [0.47, 0.64],
    draw(g) {
      const { P, still } = g;
      g.glow();
      g.platform(-5.8, 5.8, -3.2, 2.8);
      g.wall(-5.6, -2.7, -0.1, -3.0, {
        vals: list.map((p) => p.cost),
        color: HOLO.orange,
        title: 'COST BY PROJECT',
        value: fmtUSD(list.reduce((a, p) => a + p.cost, 0)),
        H: 2.6,
      });
      g.wall(0.1, -3.0, 5.6, -2.7, {
        vals: list.map((p) => p.sessions),
        color: HOLO.cyan,
        title: 'SESSIONS BY PROJECT',
        value: whole.format(list.reduce((a, p) => a + p.sessions, 0)),
        H: 2.6,
      });
      const items = [];
      const pts = [];
      const cols = Math.max(1, Math.ceil(list.length / 2));
      const gap = 10.6 / cols; // spread across the floor
      list.forEach((p, i) => {
        const row = i % 2;
        const colI = Math.floor(i / 2);
        const fp = Math.min(gap * 0.8, 0.45 + 0.5 * Math.sqrt(p.sessions / maxS));
        const x = -5.4 + gap * 0.2 + colI * gap + row * gap * 0.4;
        const z = -1.6 + row * 1.9;
        const h = ease(`pj:${p.path}`, 0.15 + 3.6 * Math.sqrt(p.tokens / maxT), still);
        const tool = Object.entries(p.tools).sort((a, b) => b[1] - a[1])[0];
        const hot = topCost.has(p.path);
        const color = hot ? '#ff5ca8' : WORK_NEON[tool ? tool[0] : 'claude'];
        items.push({ depth: P(x, 0, z)[2], draw: () => g.box(x, z, fp, fp, h, color, { glow: hot ? 20 : 8 }) });
        pts.push({
          at: P(x + fp / 2, h, z + fp / 2),
          key: p.path,
          p,
          html: () =>
            `<b>${esc(p.name)}</b><div class="row"><span>Sessions</span><span class="num">${p.sessions}</span></div><div class="row"><span>Model calls</span><span class="num">${fmtN(p.calls)}</span></div><div class="row"><span>Tokens</span><span class="num">${fmtN(p.tokens)}</span></div><div class="row"><span>Est. cost</span><span class="num">${p.cost ? fmtUSD(p.cost) : '—'}</span></div><div class="row"><span>Last active</span><span>${ago(p.last)}</span></div>`,
        });
      });
      items.sort((a, b) => a.depth - b.depth).forEach((it) => it.draw());
      g.particles();
      g.labels(
        pts.slice(0, 8).map((t) => ({
          at: t.at,
          text: `${t.p.name} · ${fmtN(t.p.tokens)}`,
          color: topCost.has(t.p.path) ? HOLO.pink : HOLO.cyan,
        })),
      );
      hoverTip(g, pts, hov);
    },
  });
}

/* ---------- Agents & skills ---------- */
function viewAgents() {
  const d = state.data;
  const k = d.kpis;
  const sum = (rows) => rows.reduce((a, r) => a + r.count, 0);
  const tools = d.toolUse;
  const totalTools = sum(tools) || 1;
  const mcp = tools.filter((t) => /^mcp__/.test(t.name)).reduce((a, t) => a + t.count, 0);
  const shell = tools.filter((t) => /^(Bash|exec|shell|exec_command)$/.test(t.name)).reduce((a, t) => a + t.count, 0);
  const card = (title, meta, rows, empty, color) =>
    panel(title, meta, barList(rows, { value: (r) => r.count, label: (r) => esc(r.name), color: () => color, empty }));
  return `<div class="holo-deck">
    ${hero('AGENTS & SKILLS', 'What your AI reaches for', `Subagents, skills and tool calls from sessions active in the ${rangeText()}.`)}
    ${workStage(
      'ag-scene',
      'TOOLBELT CITY',
      'Front row = subagents · middle = skills · back = tools; height = how often each was used · hover a tower',
      '3D chart of subagents, skills and tools by use',
      '<span><i style="background:#a99cff"></i>Subagents</span><span><i style="background:#ff5ca8"></i>Skills</span><span><i style="background:#4de8ff"></i>Tools</span>',
    )}
    <div class="live-metrics">${[
      metricTile({
        label: 'Subagent launches',
        value: whole.format(sum(d.subagents)),
        sub: `${d.subagents.length} types`,
        color: '#a99cff',
      }),
      metricTile({
        label: 'Subagent calls',
        value: fmtN(k.subagentCalls),
        sub: `${pct(k.subagentCalls / Math.max(1, k.calls))} of model calls`,
        color: '#a99cff',
        p: k.subagentCalls / Math.max(1, k.calls),
      }),
      metricTile({
        label: 'Top subagent',
        value: d.subagents[0] ? esc(d.subagents[0].name) : '—',
        sub: d.subagents[0] ? `${whole.format(d.subagents[0].count)} launches` : 'none',
        color: '#a99cff',
      }),
      metricTile({
        label: 'Skills invoked',
        value: whole.format(sum(d.skills)),
        sub: `${d.skills.length} distinct skills`,
        color: '#ff5ca8',
      }),
      metricTile({
        label: 'Top skill',
        value: d.skills[0] ? esc(d.skills[0].name) : '—',
        sub: d.skills[0] ? `${whole.format(d.skills[0].count)} uses` : 'none',
        color: '#ff5ca8',
      }),
      metricTile({
        label: 'Skill / session',
        value: (sum(d.skills) / Math.max(1, k.sessions)).toFixed(1),
        sub: 'average',
        color: '#ff5ca8',
      }),
      metricTile({
        label: 'Tool calls',
        value: fmtN(sum(tools)),
        sub: `top ${tools.length} tools shown`,
        color: HOLO.cyan,
      }),
      metricTile({
        label: 'Top tool',
        value: tools[0] ? esc(tools[0].name.replace(/^mcp__/, '')) : '—',
        sub: tools[0] ? `${pct(tools[0].count / totalTools)} of tool calls` : 'none',
        color: HOLO.cyan,
        p: tools[0] ? tools[0].count / totalTools : null,
      }),
      metricTile({
        label: 'Shell share',
        value: pct(shell / totalTools),
        sub: `${fmtN(shell)} shell commands`,
        color: HOLO.cyan,
        p: shell / totalTools,
      }),
      metricTile({
        label: 'MCP calls',
        value: fmtN(mcp),
        sub: `${pct(mcp / totalTools)} of tool calls`,
        color: HOLO.orange,
      }),
      metricTile({
        label: 'Tool calls / session',
        value: fmtN(sum(tools) / Math.max(1, k.sessions)),
        sub: 'average',
        color: HOLO.blue,
      }),
      metricTile({
        label: 'Model calls',
        value: fmtN(k.calls),
        sub: d.tools.map((t) => `${t.name} ${fmtN(t.calls)}`).join(' · '),
        color: HOLO.blue,
      }),
    ].join('')}</div>
    <div class="live-grid even">${card('Subagents launched', `${fmtN(k.subagentCalls)} model calls made by subagents`, d.subagents, 'No subagents launched.', '#a99cff')}
      ${card('Skills invoked', 'Claude Code skills', d.skills, 'No skills invoked.', '#ff5ca8')}</div>
    <div class="live-grid even">${card('Tool calls', 'across Claude Code and Codex', tools, 'No tool calls.', HOLO.cyan)}
      ${panel('Model calls by tool', '', barList(d.tools, { value: (t) => t.calls, label: (t) => esc(t.name), color: (t) => WORK_NEON[t.id] }))}</div>
  </div>`;
}

function mountAgents() {
  const canvas = $('#ag-scene');
  if (!canvas || !state.data) return;
  const d = state.data;
  const rows = [
    ['Subagents', d.subagents.slice(0, 12), '#a99cff', 1.7],
    ['Skills', d.skills.slice(0, 12), '#ff5ca8', -0.1],
    ['Tools', d.toolUse.slice(0, 12), '#4de8ff', -1.9],
  ];
  const hov = { tip: '' };
  isoStage(canvas, {
    fit: [13, 8.4],
    origin: [0.47, 0.62],
    draw(g) {
      const { P, ctx, still } = g;
      g.glow();
      g.platform(-5.8, 5.8, -3.0, 2.8);
      const items = [];
      const pts = [];
      const labels = [];
      // Each row scales to its own maximum.
      for (const [name, list, color, z] of rows) {
        const max = Math.max(1, ...list.map((r) => r.count));
        list.forEach((r, i) => {
          const x = -5.4 + i * 0.92;
          const h = ease(`ag:${name}:${r.name}`, 0.1 + 3.2 * (r.count / max), still);
          items.push({
            depth: P(x, 0, z)[2],
            draw: () => g.box(x, z, 0.6, 0.7, h, color, { glow: i === 0 ? 18 : 0, slices: 0.4 }),
          });
          const pt = {
            at: P(x + 0.3, h, z + 0.35),
            key: `${name}:${r.name}`,
            html: () =>
              `<b>${esc(r.name.replace(/^mcp__/, ''))}</b><div class="row"><span>${name.slice(0, -1)}</span><span class="num">${whole.format(r.count)} ${name === 'Tools' ? 'calls' : name === 'Skills' ? 'uses' : 'launches'}</span></div>`,
          };
          pts.push(pt);
          if (i < 2) labels.push({ at: pt.at, text: `${r.name.replace(/^mcp__/, '')} · ${fmtN(r.count)}`, color });
        });
        const q = P(-5.75, 0, z + 0.35);
        ctx.save();
        ctx.fillStyle = color;
        ctx.font = '700 11px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(name.toUpperCase(), q[0] - 8, q[1] + 4);
        ctx.restore();
      }
      items.sort((a, b) => a.depth - b.depth).forEach((it) => it.draw());
      g.particles();
      g.labels(labels);
      hoverTip(g, pts, hov);
    },
  });
}
