'use strict';
/* AI Squad subpages: Logs (requests, error traces, stream inspector), Proxy logs (router upstream
   attempts and MCP hub calls) and Time (a timeline of every agent and subagent). */

const ZONE_COLOR = { code: '#6d7cff', read: '#3ee6b0', terminal: '#4de8ff', web: '#ffb547', meeting: '#c45cf2', tools: '#ff5ca8' };
const ZONE_NAME = { code: 'Editing', read: 'Reading', terminal: 'Shell', web: 'Web', meeting: 'Planning', tools: 'MCP' };
const SQUAD_COPY = {
  logs: ['Logs', 'Real-time request logs, error traces, and streaming event inspector'],
  proxy: ['Proxy logs', 'Upstream proxy request logs and traffic inspection'],
  time: ['Time', 'Timeline of the AI squad: who worked on what, when, and in parallel'],
};
const sq = { filter: 'all', status: 'all', q: '', selected: null, paused: false, logs: null, router: null, proxy: null, mcp: null, timeline: null, hours: null, seen: new Set() }; // hours is read lazily: store lives in app.js, loaded later
const statusColor = (s) => (s === 'ok' ? '#5cf0a8' : s === 'tool error' ? '#ffb547' : '#ff4f6d');
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function viewSquadPage() {
  if (sq.hours === null) sq.hours = store.get('timelineHours', '6');
  if (!state.sub || !SQUAD_COPY[state.sub]) return viewSquad();
  const [title, copy] = SQUAD_COPY[state.sub];
  const extra = state.sub === 'logs' ? `<span class="pill live-pill"><i class="live-dot"></i><span id="sq-clock">CONNECTING</span></span><button class="btn ghost" id="sq-pause" aria-pressed="${sq.paused}">${sq.paused ? 'Resume' : 'Pause'}</button>`
    : state.sub === 'time' ? `<div class="segmented" role="group" aria-label="Time window">${['1', '6', '24'].map((h) => `<button data-hours="${h}" aria-pressed="${sq.hours === h}">${h}h</button>`).join('')}</div>`
      : '<span class="pill live-pill"><i class="live-dot"></i><span id="sq-clock">CONNECTING</span></span>';
  return `<div class="holo-deck">${subTabs('squad')}${subHero(`AI SQUAD · ${title.toUpperCase()}`, title, copy, extra)}<div id="sq-body">${'<div class="skeleton" style="height:140px"></div>'.repeat(2)}</div></div>`;
}

function mountSquadPage() {
  if (!state.sub) { mountSquad(); return; }
  const sub = state.sub; if (!SQUAD_COPY[sub]) return;
  const load = { logs: loadLogs, proxy: loadProxy, time: loadTimeline }[sub];
  load();
  const timer = setInterval(() => { if (state.route === 'squad' && state.sub === sub && !(sub === 'logs' && sq.paused)) load(); }, sub === 'time' ? 10000 : 3000);
  onUnmount(() => clearInterval(timer));
}

/* ---------- Logs ---------- */
async function loadLogs() {
  const [logs, router] = await Promise.all([api('/api/logs'), api('/api/router?section=calls').catch(() => ({ configured: false }))]);
  if (state.sub !== 'logs') return;
  sq.logs = logs; sq.router = router;
  paintLogs();
}
function allRequests() {
  const local = sq.logs ? sq.logs.requests : [];
  const routed = sq.router && sq.router.configured && Array.isArray(sq.router.data) ? sq.router.data.map((l) => ({
    id: `router:${l.id}`, ts: l.ts, source: 'router', agent: l.provider || 'router', kind: 'router', model: l.model || '—', input: l.tokens.in || 0, output: l.tokens.out || 0,
    cacheRead: l.tokens.cacheRead || 0, cacheWrite: l.tokens.cacheWrite || 0, ttftMs: l.ttftMs, durationMs: l.durationMs, stop: `HTTP ${l.status}`,
    status: l.status >= 400 ? 'error' : 'ok', inputs: [], blocks: [{ type: 'http', method: l.method, path: l.path, provider: l.provider, account: l.account, combo: l.combo, formats: `${l.sourceFormat || '?'} → ${l.targetFormat || '?'}` }], toolErrors: 0,
  })) : [];
  return [...local, ...routed].sort((a, b) => b.ts - a.ts);
}
function paintLogs() {
  const body = $('#sq-body'); if (!body || !sq.logs) return;
  const c = $('#sq-clock'); if (c) c.textContent = sq.paused ? 'PAUSED' : `LIVE · ${clock(sq.logs.ts)}`;
  const all = allRequests(); const errs = sq.logs.errors;
  const now = sq.logs.ts; const lastMin = all.filter((r) => now - r.ts < 60000).length;
  const ttft = all.map((r) => r.ttftMs); const durs = all.map((r) => r.durationMs);
  const outRate = all.filter((r) => r.durationMs > 0 && r.output > 0).map((r) => r.output / (r.durationMs / 1000));
  const bad = all.filter((r) => r.status !== 'ok').length;
  const recentSeries = (f) => all.slice(0, 30).reverse().map((r) => f(r) || 0);
  const perMin = Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * 60000, ok: 0, bad: 0 }));
  for (const r of all) { const i = 59 - Math.floor((now - r.ts) / 60000); if (i >= 0) perMin[i][r.status === 'ok' ? 'ok' : 'bad']++; }
  const tiles = [
    metricTile({ spark: perMin.map((m) => m.ok + m.bad), label: 'Requests · 3h', value: whole.format(all.length), sub: `${whole.format(all.filter((r) => r.source === 'router').length)} through the router`, color: HOLO.cyan }),
    metricTile({ spark: perMin.slice(-15).map((m) => m.ok + m.bad), label: 'Last minute', value: whole.format(lastMin), sub: 'requests', color: HOLO.cyan }),
    metricTile({ spark: recentSeries((r) => r.ttftMs), label: 'TTFT p50', value: msFmt(quantile(ttft, 0.5)), sub: 'input → first output', color: HOLO.violet }),
    metricTile({ spark: recentSeries((r) => r.ttftMs), label: 'TTFT p95', value: msFmt(quantile(ttft, 0.95)), sub: 'slowest 5%', color: HOLO.violet }),
    metricTile({ spark: recentSeries((r) => r.durationMs), label: 'Duration p50', value: msFmt(quantile(durs, 0.5)), sub: 'input → last output', color: HOLO.blue }),
    metricTile({ spark: recentSeries((r) => (r.durationMs > 0 ? r.output / (r.durationMs / 1000) : 0)), label: 'Output speed', value: outRate.length ? `${Math.round(quantile(outRate, 0.5))} tok/s` : '—', sub: 'median per request', color: HOLO.blue }),
    metricTile({ spark: perMin.map((m) => m.bad), label: 'Error rate', value: pct(all.length ? bad / all.length : 0), sub: `${whole.format(bad)} requests not ok`, color: bad ? '#ff4f6d' : '#5cf0a8', p: all.length ? bad / all.length : 0 }),
    metricTile({ label: 'Tool errors', value: whole.format(errs.filter((e) => e.kind === 'tool').length), sub: 'failed tool results', color: HOLO.orange }),
    metricTile({ label: 'API errors', value: whole.format(errs.filter((e) => e.kind === 'api').length), sub: 'provider-side failures', color: '#ff4f6d' }),
    metricTile({ label: 'Interrupts', value: whole.format(errs.filter((e) => e.kind === 'interrupt').length), sub: 'you stopped a turn', color: HOLO.pink }),
    metricTile({ label: 'Streaming now', value: whole.format(all.filter((r) => !r.stop && now - r.ts < 60000).length), sub: 'no stop reason yet', color: HOLO.pink }),
    metricTile({ spark: recentSeries((r) => r.output), label: 'Output tokens', value: fmtN(all.reduce((a, r) => a + r.output, 0)), sub: `${fmtN(all.reduce((a, r) => a + r.cacheRead, 0))} read from cache`, color: HOLO.violet }),
  ];
  const q = sq.q.toLowerCase();
  const rows = all.filter((r) => (sq.filter === 'all' || r.source === sq.filter) && (sq.status === 'all' || (sq.status === 'errors' ? r.status !== 'ok' : r.status === 'ok'))
    && (!q || `${r.agent} ${r.model} ${r.blocks.map((b) => `${b.tool || ''} ${b.target || ''}`).join(' ')}`.toLowerCase().includes(q))).slice(0, 200);
  if (!sq.selected || !all.some((r) => r.id === sq.selected)) sq.selected = rows[0] ? rows[0].id : null;
  const chip = (key, val, label, n) => `<button class="chipbtn" data-sq-${key}="${val}" aria-pressed="${sq[key === 'src' ? 'filter' : 'status'] === val}">${label}${n != null ? ` <b>${n}</b>` : ''}</button>`;
  const table = rows.length ? `<table class="holo-table logs-table"><thead><tr><th>Time</th><th>Agent · model</th><th class="r">In / cache / out</th><th class="r">TTFT</th><th class="r">Duration</th><th>Tools</th><th>Status</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="${r.id === sq.selected ? 'sel' : ''}${sq.seen.has(r.id) ? '' : ' fresh'}" data-req="${esc(r.id)}" tabindex="0">
      <td class="num muted">${clock(r.ts)}</td><td><span class="tool-dot" style="background:${r.source === 'router' ? HOLO.orange : r.source === 'codex' ? PROV_COLOR.codex : r.kind === 'subagent' ? '#a99cff' : PROV_COLOR.claude}"></span>${esc(r.agent)}<small class="block muted">${esc(String(r.model).replace(/^claude-/, ''))}</small></td><td class="r num">${fmtN(r.input)} / ${fmtN(r.cacheRead)} / <b>${fmtN(r.output)}</b></td>
      <td class="r num">${msFmt(r.ttftMs)}</td><td class="r num">${msFmt(r.durationMs)}</td>
      <td class="tools-cell">${r.blocks.filter((b) => b.type === 'tool_use').slice(0, 3).map((b) => `<code style="--c:${ZONE_COLOR[b.zone] || HOLO.cyan}">${esc(b.tool)}</code>`).join('')}</td>
      <td><span class="state-pill" style="--c:${statusColor(r.status)}"><i></i>${esc(r.status)}</span></td></tr>`).join('')}</tbody></table>` : holoEmpty('No requests match the filters.');
  for (const r of all) sq.seen.add(r.id);
  const sel = all.find((r) => r.id === sq.selected);
  const keepScroll = $('.logs-scroll') ? $('.logs-scroll').scrollTop : 0;
  const search = $('#sq-q'); const hadFocus = search && document.activeElement === search;
  body.innerHTML = `<div class="live-metrics">${tiles.join('')}</div>
    ${panel('Throughput', 'requests per minute · last hour', holoBars(perMin, { series: [{ name: 'ok', color: HOLO.cyan, get: (r) => r.ok }, { name: 'not ok', color: '#ff4f6d', get: (r) => r.bad }], label: (r) => clock(r.t).slice(0, 5), every: 10, height: 170, W: 1120 }))}
    <div class="logs-grid">
      <section class="holo panel"><div class="panel-head"><h3>Request log</h3><span class="meta">newest first · click a row to inspect</span></div>
        <div class="filters">${chip('src', 'all', 'All', all.length)}${chip('src', 'claude', 'Claude Code', all.filter((r) => r.source === 'claude').length)}${chip('src', 'codex', 'Codex', all.filter((r) => r.source === 'codex').length)}${chip('src', 'router', 'Router', all.filter((r) => r.source === 'router').length)}
          <span class="sep"></span>${chip('st', 'all', 'Any status')}${chip('st', 'errors', 'Errors', bad)}
          <label class="search sq-search">${icon('search', 14)}<input id="sq-q" type="search" placeholder="Agent, model, tool…" value="${esc(sq.q)}" autocomplete="off"></label></div>
        <div class="table-wrap logs-scroll">${table}</div></section>
      <section class="holo panel inspector" aria-live="polite">${inspector(sel)}</section>
    </div>
    ${panel('Error traces', `${errs.length} in the last 3 hours · text masked`, errs.length ? `<div class="feed traces">${errs.slice(0, 40).map((e) => `<div class="trace"><span class="state-pill" style="--c:${e.kind === 'api' ? '#ff4f6d' : e.kind === 'tool' ? '#ffb547' : HOLO.pink}"><i></i>${esc(e.kind)}</span>
      <span class="muted num">${clock(e.ts)}</span><b>${esc(e.agent)}</b><span>${esc(e.source)} · ${esc(e.label)}</span><code class="trace-text">${esc(e.text)}</code></div>`).join('')}</div>` : holoEmpty('No errors in the last 3 hours.'))}`;
  const sc = $('.logs-scroll'); if (sc) sc.scrollTop = keepScroll;
  if (hadFocus) { const s2 = $('#sq-q'); s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); }
}

// Stream events for one request: what fed it, then each block it produced, in order.
function inspector(r) {
  if (!r) return `<div class="panel-head"><h3>Stream inspector</h3></div>${holoEmpty('Select a request.')}`;
  const tot = r.input + r.cacheRead + r.cacheWrite + r.output || 1;
  const parts = [['Input', r.input, HOLO.blue], ['Cache read', r.cacheRead, HOLO.cyan], ['Cache write', r.cacheWrite, HOLO.orange], ['Output', r.output, HOLO.pink]];
  const gen = r.durationMs != null && r.ttftMs != null ? Math.max(0, r.durationMs - r.ttftMs) : null;
  const ev = [];
  for (const i of r.inputs) ev.push(i.type === 'tool_result' ? ['in', i.ok ? '#5cf0a8' : '#ff4f6d', `Tool result · ${esc(i.tool)}`, `${i.ok ? 'ok' : 'error'} · ${whole.format(i.size)} chars`] : ['in', '#dfe6ff', i.type === 'summary' ? 'Compaction summary' : 'Your prompt', `${whole.format(i.size)} chars`]);
  if (r.ttftMs != null) ev.push(['wait', HOLO.violet, 'Waiting for first output', msFmt(r.ttftMs)]);
  for (const b of r.blocks) {
    if (b.type === 'tool_use') ev.push(['out', ZONE_COLOR[b.zone] || HOLO.cyan, `Tool call · ${esc(b.tool)}`, b.target ? esc(b.target) : '']);
    else if (b.type === 'http') ev.push(['out', HOLO.orange, `${esc(b.method)} ${esc(b.path)}`, `${esc(b.provider || '')} · ${esc(b.formats)}${b.account ? ` · ${esc(b.account)}` : ''}${b.combo ? ` · combo ${esc(b.combo)}` : ''}`]);
    else ev.push(['out', b.type === 'text' ? '#dfe6ff' : HOLO.violet, b.type === 'text' ? 'Text' : b.type === 'redacted_thinking' ? 'Thinking (redacted)' : 'Thinking', b.size ? `${whole.format(b.size)} chars` : '']);
  }
  ev.push(['end', statusColor(r.status), r.stop ? `Stop · ${esc(r.stop)}` : 'Still streaming', esc(r.status)]);
  return `<div class="panel-head"><h3>Stream inspector</h3><span class="meta">${clock(r.ts)}</span></div>
    <div class="insp-title"><b>${esc(r.agent)}</b><span class="muted">${esc(r.model)}</span></div>
    <div class="timing"><i style="flex:${r.ttftMs || 0};background:${HOLO.violet}" data-tip="Time to first output ${msFmt(r.ttftMs)}"></i><i style="flex:${gen || 0};background:${HOLO.pink}" data-tip="Generating ${msFmt(gen)}"></i></div>
    <div class="kpi-sub">first output ${msFmt(r.ttftMs)} · generating ${msFmt(gen)} · total ${msFmt(r.durationMs)}</div>
    <div class="comp">${parts.filter((p) => p[1] > 0).map(([n, v, col]) => `<i style="flex-grow:${v / tot};background:${col}" data-tip="${n}: ${whole.format(v)}"></i>`).join('')}</div>
    <div class="kv small">${parts.map(([n, v]) => `<span>${n}</span><b class="num">${whole.format(v)}</b>`).join('')}</div>
    <ol class="events">${ev.map(([k, col, a, b]) => `<li class="ev ${k}" style="--c:${col}"><b>${a}</b>${b ? `<span>${b}</span>` : ''}</li>`).join('')}</ol>
    <p class="kpi-sub">Only block types, sizes, tool names and targets are shown. Message text stays in your transcripts.</p>`;
}

document.addEventListener('click', (e) => {
  if (state.route !== 'squad') return;
  const row = e.target.closest('[data-req]'); if (row) { sq.selected = row.dataset.req; paintLogs(); return; }
  const src = e.target.closest('[data-sq-src]'); if (src) { sq.filter = src.dataset.sqSrc; paintLogs(); return; }
  const st = e.target.closest('[data-sq-st]'); if (st) { sq.status = st.dataset.sqSt; paintLogs(); return; }
  const pf = e.target.closest('[data-px]'); if (pf) { sq.pxFilter = pf.dataset.px; paintProxy(); return; }
  const prow = e.target.closest('[data-prx]'); if (prow) { sq.pxSelected = prow.dataset.prx; paintProxy(); return; }
  if (e.target.closest('#sq-pause')) { sq.paused = !sq.paused; const b = $('#sq-pause'); b.textContent = sq.paused ? 'Resume' : 'Pause'; b.setAttribute('aria-pressed', String(sq.paused)); paintLogs(); return; }
  const hb = e.target.closest('[data-hours]'); if (hb) { sq.hours = hb.dataset.hours; store.set('timelineHours', sq.hours); for (const b of $$('[data-hours]')) b.setAttribute('aria-pressed', String(b === hb)); loadTimeline(); }
});
document.addEventListener('input', (e) => { if (e.target.id === 'sq-q') { sq.q = e.target.value; paintLogs(); } });
document.addEventListener('keydown', (e) => { const row = e.target.closest && e.target.closest('[data-req]'); if (row && e.key === 'Enter') { sq.selected = row.dataset.req; paintLogs(); } });

/* ---------- Proxy logs ---------- */
async function loadProxy() {
  const [router, mcp] = await Promise.all([api('/api/router?section=proxy').catch(() => ({ configured: false })), api('/api/mcp-calls').catch(() => ({ calls: [] }))]);
  if (state.sub !== 'proxy') return;
  sq.proxy = router; sq.mcp = mcp.calls || [];
  paintProxy();
}
function proxyRows() {
  const up = sq.proxy && sq.proxy.configured && Array.isArray(sq.proxy.data) ? sq.proxy.data.map((l) => ({ ...l, kind: 'upstream', key: `u:${l.id}`, ok: l.status === 'success', name: l.target || l.provider, via: l.level || 'direct' })) : [];
  const mcp = (sq.mcp || []).map((c, i) => ({ kind: 'mcp', key: `m:${c.ts}:${i}`, ts: c.ts, ok: c.ok, name: `${c.integration} · ${c.tool}`, provider: c.integration, latencyMs: c.ms, via: 'MCP hub', args: c.args, error: c.error || null }));
  return [...up, ...mcp].sort((a, b) => b.ts - a.ts);
}
function paintProxy() {
  const body = $('#sq-body'); if (!body || !sq.proxy) return;
  const c = $('#sq-clock'); if (c) c.textContent = `LIVE · ${clock(Date.now())}`;
  const all = proxyRows(); const up = all.filter((r) => r.kind === 'upstream'); const mcp = all.filter((r) => r.kind === 'mcp');
  const lat = all.map((r) => r.latencyMs);
  // Traffic over the span of the logs, in up to 24 buckets
  const span = all.length ? Math.max(3600000, all[0].ts - all[all.length - 1].ts) : 3600000; const size = span / 24; const t0 = all.length ? all[all.length - 1].ts : Date.now() - span;
  const buckets = Array.from({ length: 24 }, (_, i) => ({ t: t0 + i * size, ok: 0, bad: 0 }));
  for (const r of all) { const i = Math.min(23, Math.floor((r.ts - t0) / size)); buckets[i][r.ok ? 'ok' : 'bad']++; }
  const tiles = [
    metricTile({ spark: buckets.map((b) => b.ok + b.bad), label: 'Upstream attempts', value: whole.format(up.length), sub: 'router → provider', color: HOLO.orange }),
    metricTile({ label: 'Upstream success', value: up.length ? pct(up.filter((r) => r.ok).length / up.length) : '—', sub: `${whole.format(up.filter((r) => !r.ok).length)} failed`, color: '#5cf0a8', p: up.length ? up.filter((r) => r.ok).length / up.length : null }),
    metricTile({ spark: all.slice(0, 30).reverse().map((r) => r.latencyMs || 0), label: 'Latency p50', value: msFmt(quantile(lat, 0.5)), sub: 'all proxied calls', color: HOLO.cyan }),
    metricTile({ spark: all.slice(0, 30).reverse().map((r) => r.latencyMs || 0), label: 'Latency p95', value: msFmt(quantile(lat, 0.95)), sub: 'slowest 5%', color: HOLO.cyan }),
    metricTile({ label: 'Headers p50', value: msFmt(quantile(up.map((r) => r.headersMs), 0.5)), sub: 'upstream time to headers', color: HOLO.violet }),
    metricTile({ label: 'First chunk p50', value: msFmt(quantile(up.map((r) => r.firstChunkMs), 0.5)), sub: 'streaming responses', color: HOLO.violet }),
    metricTile({ label: 'Retries', value: whole.format(up.filter((r) => r.attempt > 1).length), sub: 'attempt 2 or later', color: HOLO.pink }),
    metricTile({ label: 'Via proxy', value: up.length ? pct(up.filter((r) => r.via !== 'direct').length / up.length) : '—', sub: 'not direct egress', color: HOLO.blue }),
    metricTile({ spark: buckets.map((b) => b.ok + b.bad), label: 'MCP hub calls', value: whole.format(mcp.length), sub: 'tools proxied to integrations', color: HOLO.cyan }),
    metricTile({ label: 'MCP errors', value: whole.format(mcp.filter((r) => !r.ok).length), sub: mcp.length ? `${pct(mcp.filter((r) => !r.ok).length / mcp.length)} of calls` : 'no calls', color: '#ff4f6d' }),
    metricTile({ label: 'MCP p95', value: msFmt(quantile(mcp.map((r) => r.latencyMs), 0.95)), sub: 'integration round trip', color: HOLO.blue }),
    metricTile({ label: 'Targets', value: whole.format(new Set(all.map((r) => r.name)).size), sub: 'distinct upstreams', color: HOLO.orange }),
  ];
  const hist = [[0, 100], [100, 300], [300, 1000], [1000, 3000], [3000, 10000], [10000, Infinity]].map(([lo, hi]) => ({ label: hi === Infinity ? `${msFmt(lo)}+` : `<${msFmt(hi)}`, n: all.filter((r) => r.latencyMs >= lo && r.latencyMs < hi).length }));
  const byTarget = {}; for (const r of all) { const t = (byTarget[r.name] ||= { name: r.name, kind: r.kind, n: 0, ok: 0, lat: [] }); t.n++; if (r.ok) t.ok++; t.lat.push(r.latencyMs); }
  const rows = all.filter((r) => !sq.pxFilter || sq.pxFilter === 'all' || (sq.pxFilter === 'errors' ? !r.ok : r.kind === sq.pxFilter)).slice(0, 200);
  if (!sq.pxSelected || !all.some((r) => r.key === sq.pxSelected)) sq.pxSelected = rows[0] ? rows[0].key : null;
  const sel = all.find((r) => r.key === sq.pxSelected);
  const chip = (v, label, n) => `<button class="chipbtn" data-px="${v}" aria-pressed="${(sq.pxFilter || 'all') === v}">${label} <b>${n}</b></button>`;
  const fields = sel ? Object.entries(sel).filter(([k, v]) => !['key', 'kind'].includes(k) && v !== null && v !== undefined && v !== '').map(([k, v]) => [k, k === 'ts' ? fmtDate(v) : /Ms$/.test(k) ? msFmt(v) : Array.isArray(v) ? v.join(', ') || '—' : String(v)]) : [];
  body.innerHTML = `<div class="live-metrics">${tiles.join('')}</div>
    <div class="live-grid">
      ${panel('Traffic', 'proxied calls over time', holoBars(buckets, { series: [{ name: 'ok', color: HOLO.cyan, get: (b) => b.ok }, { name: 'failed', color: '#ff4f6d', get: (b) => b.bad }], label: (b) => fmtDate(b.t).replace(/^\w+ \d+, /, ''), every: 4, height: 160 }))}
      ${panel('Latency', 'distribution', holoBars(hist, { series: [{ name: 'calls', color: HOLO.violet, get: (b) => b.n }], label: (b) => b.label, every: 1, height: 160 }))}
    </div>
    <div class="logs-grid">
      <section class="holo panel"><div class="panel-head"><h3>Proxy log</h3><span class="meta">${sq.proxy.configured ? `OmniRoute · ${esc(sq.proxy.id)}` : 'no router configured'} · MCP hub audit</span></div>
        <div class="filters">${chip('all', 'All', all.length)}${chip('upstream', 'Router upstream', up.length)}${chip('mcp', 'MCP hub', mcp.length)}${chip('errors', 'Failed', all.filter((r) => !r.ok).length)}</div>
        <div class="table-wrap logs-scroll">${rows.length ? `<table class="holo-table logs-table"><thead><tr><th>Time</th><th>Source</th><th>Target</th><th>Via</th><th class="r">Latency</th><th>Status</th></tr></thead><tbody>
          ${rows.map((r) => `<tr class="${r.key === sq.pxSelected ? 'sel' : ''}" data-prx="${esc(r.key)}"><td class="num muted">${fmtDate(r.ts)}</td><td>${r.kind === 'mcp' ? 'MCP hub' : 'Router'}</td><td><b>${esc(r.name)}</b></td><td class="muted">${esc(r.via)}${r.attempt > 1 ? ` · try ${r.attempt}` : ''}</td>
            <td class="r num">${msFmt(r.latencyMs)}</td><td><span class="state-pill" style="--c:${r.ok ? '#5cf0a8' : '#ff4f6d'}"><i></i>${r.upstreamStatus || (r.ok ? 'ok' : 'failed')}</span></td></tr>`).join('')}</tbody></table>` : holoEmpty('No proxied calls yet. Calls through OmniRoute and the MCP hub appear here.')}</div></section>
      <section class="holo panel inspector"><div class="panel-head"><h3>Traffic inspector</h3></div>${sel ? `<div class="insp-title"><b>${esc(sel.name)}</b><span class="muted">${sel.kind === 'mcp' ? 'MCP hub call' : 'Router upstream attempt'}</span></div>
        <div class="kv">${fields.map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join('')}</div><p class="kpi-sub">Argument values and credentials are never logged; accounts are masked.</p>` : holoEmpty('Select a call.')}</section>
    </div>
    ${panel('By target', 'requests, success and latency', Object.keys(byTarget).length ? `<div class="table-wrap"><table class="holo-table"><thead><tr><th>Target</th><th>Source</th><th class="r">Calls</th><th class="r">Success</th><th class="r">p50</th><th class="r">p95</th></tr></thead><tbody>
      ${Object.values(byTarget).sort((a, b) => b.n - a.n).map((t) => `<tr><td><b>${esc(t.name)}</b></td><td class="muted">${t.kind === 'mcp' ? 'MCP hub' : 'Router'}</td><td class="r num">${t.n}</td><td class="r num">${pct(t.ok / t.n)}</td><td class="r num">${msFmt(quantile(t.lat, 0.5))}</td><td class="r num">${msFmt(quantile(t.lat, 0.95))}</td></tr>`).join('')}</tbody></table></div>` : holoEmpty('No targets yet.'))}`;
}

/* ---------- Time ---------- */
async function loadTimeline() {
  const tl = await api(`/api/timeline?hours=${sq.hours}`);
  if (state.sub !== 'time') return;
  sq.timeline = tl; paintTimeline();
}
function laneName(l) { return l.kind === 'subagent' ? l.agentType || 'subagent' : l.project || 'session'; }
function paintTimeline() {
  const body = $('#sq-body'); const tl = sq.timeline; if (!body || !tl) return;
  const { start, ts: end, lanes } = tl; const span = end - start;
  const sum = (l, type) => l.segments.filter((s) => s[2] === type).reduce((a, s) => a + (s[1] - s[0]), 0);
  // Agents busy (tool or thinking) per slice of the window
  const slices = 120; const busy = Array.from({ length: slices }, (_, i) => ({ t: start + (i + 0.5) * (span / slices), n: 0, w: 0 }));
  for (const l of lanes) {
    const on = new Array(slices).fill(0); const wt = new Array(slices).fill(0);
    for (const s of l.segments) {
      const a = Math.max(0, Math.floor(((s[0] - start) / span) * slices)); const b = Math.min(slices - 1, Math.floor(((s[1] - start) / span) * slices));
      for (let i = a; i <= b; i++) (s[2] === 'wait' ? wt : on)[i] = 1;
    }
    on.forEach((v, i) => { busy[i].n += v; busy[i].w += wt[i] && !v ? 1 : 0; });
  }
  const tools = lanes.flatMap((l) => l.segments.filter((s) => s[2] === 'tool'));
  const longest = tools.reduce((m, s) => (s[1] - s[0] > (m ? m[1] - m[0] : 0) ? s : m), null);
  const marks = (k) => lanes.reduce((a, l) => a + l.marks.filter((m) => m[1] === k).length, 0);
  const totalTool = lanes.reduce((a, l) => a + sum(l, 'tool'), 0); const totalThink = lanes.reduce((a, l) => a + sum(l, 'think'), 0); const totalWait = lanes.reduce((a, l) => a + sum(l, 'wait'), 0);
  const tiles = [
    metricTile({ spark: busy.map((b) => b.n + b.w), label: 'Agents in window', value: whole.format(lanes.length), sub: `${lanes.filter((l) => l.kind === 'session').length} sessions · ${lanes.filter((l) => l.kind === 'subagent').length} subagents`, color: HOLO.cyan }),
    metricTile({ spark: busy.map((b) => b.n), label: 'Peak parallel', value: whole.format(Math.max(0, ...busy.map((b) => b.n))), sub: 'agents working at once', color: HOLO.cyan }),
    metricTile({ label: 'Tool time', value: dur(totalTool / 1000), sub: 'summed over agents', color: ZONE_COLOR.terminal }),
    metricTile({ label: 'Thinking time', value: dur(totalThink / 1000), sub: 'model generating', color: HOLO.violet }),
    metricTile({ spark: busy.map((b) => b.w), label: 'Waiting for you', value: dur(totalWait / 1000), sub: 'turn done, no reply yet', color: '#ffb547' }),
    metricTile({ label: 'Tool calls', value: whole.format(tools.length), sub: `${pct(tools.length ? tools.filter((s) => !s[6]).length / tools.length : 0)} failed`, color: HOLO.blue }),
    metricTile({ label: 'Longest call', value: longest ? dur((longest[1] - longest[0]) / 1000) : '—', sub: longest ? `${esc(longest[4])}${longest[5] ? ' ' + esc(longest[5]) : ''}` : 'no tool calls', color: HOLO.orange }),
    metricTile({ label: 'Prompts', value: whole.format(marks('prompt')), sub: 'you typed', color: '#dfe6ff' }),
    metricTile({ label: 'Errors', value: whole.format(marks('error')), sub: 'failed calls and API errors', color: '#ff4f6d' }),
    metricTile({ label: 'Compactions', value: whole.format(marks('compact')), sub: 'context summarised', color: HOLO.cyan }),
    metricTile({ label: 'Interrupts', value: whole.format(marks('interrupt')), sub: 'you stopped a turn', color: HOLO.pink }),
    metricTile({ spark: busy.map((b) => b.n), label: 'Utilization', value: pct(lanes.length ? (totalTool + totalThink) / (lanes.length * span) : 0), sub: 'busy share of agent time', color: HOLO.pink, p: lanes.length ? (totalTool + totalThink) / (lanes.length * span) : 0 }),
  ];
  const tick = span <= 3600000 ? 600000 : span <= 6 * 3600000 ? 3600000 : 3 * 3600000;
  const ticks = []; for (let t = Math.ceil(start / tick) * tick; t <= end; t += tick) ticks.push(t);
  const X = (t) => (((t - start) / span) * 100).toFixed(3);
  const axis = `<div class="tl-axis">${ticks.map((t) => `<span style="left:${X(t)}%">${clock(t).slice(0, 5)}</span>`).join('')}</div>`;
  const laneRows = lanes.map((l) => {
    const segs = l.segments.map((s) => {
      const w = Math.max(0.08, ((s[1] - s[0]) / span) * 100);
      if (s[2] === 'tool') return `<i class="seg tool${s[6] ? '' : ' fail'}" style="left:${X(s[0])}%;width:${w.toFixed(3)}%;--c:${ZONE_COLOR[s[3]] || HOLO.cyan}" data-tip="${esc(`${clock(s[0])} · ${toolVerb(s[4])}${s[5] ? ' ' + s[5] : ''} · ${msFmt(s[1] - s[0])}${s[6] ? '' : ' · failed'}`)}"></i>`;
      return `<i class="seg ${s[2]}" style="left:${X(s[0])}%;width:${w.toFixed(3)}%" data-tip="${esc(`${clock(s[0])} · ${s[2] === 'think' ? 'Thinking' : 'Waiting for you'} · ${msFmt(s[1] - s[0])}`)}"></i>`;
    }).join('');
    const mk = l.marks.map((m) => `<b class="mark ${m[1]}" style="left:${X(m[0])}%" data-tip="${esc(`${clock(m[0])} · ${m[2]}`)}"></b>`).join('');
    const busyPct = span ? (sum(l, 'tool') + sum(l, 'think')) / (Math.max(1, l.last - l.first)) : 0;
    return `<div class="tl-row${l.kind === 'subagent' ? ' sub' : ''}"><div class="tl-label"><span class="tool-dot" style="background:${l.tool === 'codex' ? PROV_COLOR.codex : l.kind === 'subagent' ? '#a99cff' : PROV_COLOR.claude}"></span>
      <div><b>${esc(laneName(l))}</b><small>${l.kind === 'subagent' ? `↳ ${esc(l.project)}` : esc(toolName(l.tool))} · ${pct(Math.min(1, busyPct))} busy</small></div></div>
      <div class="tl-track">${segs}${mk}</div></div>`;
  }).join('');
  const legend = `<div class="legend holo-legend tl-legend">${Object.entries(ZONE_NAME).map(([z, n]) => `<span><i style="background:${ZONE_COLOR[z]}"></i>${n}</span>`).join('')}<span><i class="lg think"></i>Thinking</span><span><i class="lg wait"></i>Waiting for you</span>
    <span><b class="mark prompt static"></b>Prompt</span><span><b class="mark error static"></b>Error</span><span><b class="mark compact static"></b>Compaction</span></div>`;
  const byZone = {}; for (const s of tools) byZone[s[3]] = (byZone[s[3]] || 0) + (s[1] - s[0]);
  body.innerHTML = `<div class="live-metrics">${tiles.join('')}</div>
    ${panel('Parallel work', 'agents working (cyan) and waiting for you (amber) across the window', holoBars(busy, { series: [{ name: 'working', color: HOLO.cyan, get: (b) => b.n }, { name: 'waiting', color: '#ffb547', get: (b) => b.w }], label: (b) => clock(b.t).slice(0, 5), every: 20, height: 150, fmt: (v) => v.toFixed(0), W: 1120 }))}
    <section class="holo panel"><div class="panel-head"><h3>Agent timeline</h3><span class="meta">last ${tl.hours} hour${tl.hours > 1 ? 's' : ''} · each bar is a tool call, from call to result · hover for details</span></div>
      ${legend}
      ${lanes.length ? `<div class="timeline"><div class="tl-row head"><div class="tl-label"></div>${axis}</div>${laneRows}</div>` : holoEmpty(`No agent activity in the last ${tl.hours} hours.`)}</section>
    ${panel('Where the tool time went', 'summed over all agents', meters(Object.entries(byZone).sort((a, b) => b[1] - a[1]).map(([z, ms]) => ({ label: ZONE_NAME[z] || z, value: ms, max: totalTool, color: ZONE_COLOR[z] || HOLO.cyan, right: `${dur(ms / 1000)} · ${pct(ms / Math.max(1, totalTool))}` }))) || holoEmpty('No tool calls.'))}`;
}
