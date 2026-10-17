'use strict';
/* Second brain extras (knowledge-growth scene and vault metrics) and the Integrations deck, which
   wraps the Integrations page from integrations.js with a 3D hub scene and a metric strip. */

const BRAIN_NEON = { hub: '#5b8cff', project: '#ff8a4c', reference: '#3ee6b0', feedback: '#ffb547', account: '#ff5ca8', vault: '#5cf0a8', other: '#8f98cc' };

/* ---------- Second brain ---------- */
// Called by mountBrain once the vault has loaded.
function mountBrainExtras(v) {
  const notes = v.notes; const edges = v.edges;
  const words = notes.reduce((a, n) => a + n.words, 0);
  const folders = new Set(notes.map((n) => n.folder)).size;
  const tags = new Set(notes.flatMap((n) => n.tags || [])).size;
  const week = Date.now() - 7 * 86400000;
  const created7 = notes.filter((n) => n.created >= week).length; const touched7 = notes.filter((n) => n.modified >= week).length;
  const biggest = [...notes].sort((a, b) => b.words - a.words)[0];
  const linked = notes.filter((n) => n.inLinks + n.outLinks > 0).length;
  const n = Math.max(1, notes.length);
  const el = $('#brain-metrics');
  if (el) el.innerHTML = [
    metricTile({ label: 'Words', value: fmtN(words), sub: `${fmtN(words / n)} per note`, color: HOLO.cyan }),
    metricTile({ label: 'Folders', value: whole.format(folders), sub: `${(n / Math.max(1, folders)).toFixed(1)} notes each`, color: HOLO.cyan }),
    metricTile({ label: 'Tags', value: whole.format(tags), sub: 'distinct', color: HOLO.violet }),
    metricTile({ label: 'Links per note', value: (edges.length / n).toFixed(1), sub: `${whole.format(edges.length)} links`, color: HOLO.violet }),
    metricTile({ label: 'Connected', value: pct(linked / n), sub: `${whole.format(n - linked)} orphans`, color: '#5cf0a8', p: linked / n }),
    metricTile({ label: 'Graph density', value: `${((edges.length / Math.max(1, n * (n - 1))) * 1000).toFixed(2)}‰`, sub: 'links ÷ possible links', color: HOLO.blue }),
    metricTile({ label: 'New this week', value: whole.format(created7), sub: 'notes created', color: HOLO.pink }),
    metricTile({ label: 'Edited this week', value: whole.format(touched7), sub: `${pct(touched7 / n)} of the vault`, color: HOLO.pink, p: touched7 / n }),
    metricTile({ label: 'Largest note', value: biggest ? fmtN(biggest.words) : '—', sub: biggest ? esc(biggest.name) : 'none', color: HOLO.orange }),
    metricTile({ label: 'Unresolved names', value: whole.format(v.unresolved.length), sub: 'notes worth writing', color: HOLO.orange }),
    metricTile({ label: 'Groups', value: whole.format(new Set(notes.map((x) => x.group)).size), sub: 'note types detected', color: HOLO.blue }),
    metricTile({ label: 'Oldest note', value: notes.length ? new Date(Math.min(...notes.map((x) => x.created))).toLocaleDateString('en', { month: 'short', year: 'numeric' }) : '—', sub: 'start of the vault', color: HOLO.cyan }),
  ].join('');
  const canvas = $('#brain-scene');
  if (canvas) mountBrainGrowth(canvas, v);
}

// Notes created per week, stacked by group; walls: cumulative notes and the biggest hubs.
function mountBrainGrowth(canvas, v) {
  const notes = v.notes; if (!notes.length) return;
  const WEEK = 7 * 86400000;
  const first = Math.min(...notes.map((x) => x.created)); const weeks = Math.max(1, Math.ceil((Date.now() - first) / WEEK));
  const k = Math.ceil(weeks / 40); const cols = Math.ceil(weeks / k);
  const buckets = Array.from({ length: cols }, (_, i) => ({ start: first + i * k * WEEK, groups: {} , total: 0 }));
  for (const x of notes) { const b = buckets[Math.min(cols - 1, Math.floor((x.created - first) / (k * WEEK)))]; b.groups[x.group] = (b.groups[x.group] || 0) + 1; b.total++; }
  let run = 0; const cum = buckets.map((b) => (run += b.total));
  const hubs = [...notes].sort((a, b) => b.inLinks + b.outLinks - (a.inLinks + a.outLinks)).slice(0, 12);
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const groups = BRAIN_GROUPS.map((g) => g.id);
  const hov = { tip: '' };
  isoStage(canvas, {
    fit: [13.2, 8.6], origin: [0.47, 0.64],
    draw(g) {
      const { P, ctx, still } = g; const X0 = -5.8; const X1 = 5.8;
      g.glow(); g.platform(X0, X1, -3.2, 2.6);
      g.wall(-5.6, -2.7, -0.1, -3.0, { vals: cum, color: HOLO.cyan, title: 'NOTES OVER TIME', value: whole.format(notes.length), H: 2.8 });
      g.wall(0.1, -3.0, 5.6, -2.7, { vals: hubs.map((h) => h.inLinks + h.outLinks), color: HOLO.violet, title: 'BIGGEST HUBS · LINKS', value: hubs[0] ? hubs[0].name.slice(0, 22) : '', hot: 0, H: 2.8 });
      const step = (X1 - X0 - 0.6) / cols; const w = Math.min(0.5, step * 0.72); const z = -0.6; const d0 = 0.9;
      const items = []; const pts = [];
      buckets.forEach((b, i) => {
        const x = X0 + 0.3 + i * step + (step - w) / 2; let y = 0;
        for (const gid of groups) {
          const c = b.groups[gid]; if (!c) continue;
          const h = ease(`br:${b.start}:${gid}`, (c / max) * 3.4, still); const y0 = y;
          items.push({ depth: P(x, 0, z)[2] + y0 * 0.001, draw: () => g.box(x, z, w, d0, h, BRAIN_NEON[gid] || '#8f98cc', { y0, slices: 0, glow: gid === 'hub' ? 12 : 0 }) });
          y += h;
        }
        if (!b.total) items.push({ depth: P(x, 0, z)[2], draw: () => g.box(x, z, w, d0, 0.02, '#2a2f78', { slices: 0, glow: 0, alpha: 0.6 }) });
        pts.push({ at: P(x + w / 2, y, z + d0 / 2), key: b.start, html: () => `<b>Week of ${new Date(b.start).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}</b>${groups.filter((gid) => b.groups[gid]).map((gid) => `<div class="row"><span><i style="background:${BRAIN_NEON[gid]}"></i>${esc(groupMeta(gid).name)}</span><span class="num">${b.groups[gid]}</span></div>`).join('')}<div class="row"><span>Total</span><span class="num">${b.total}</span></div>` });
      });
      items.sort((a, b) => a.depth - b.depth).forEach((it) => it.draw());
      ctx.fillStyle = HOLO.muted; ctx.font = '10.5px system-ui, sans-serif';
      const every = Math.ceil(cols / 7);
      buckets.forEach((b, i) => { if ((cols - 1 - i) % every) return; const q = P(X0 + 0.3 + (i + 0.5) * step, 0, 2.95); const t = new Date(b.start).toLocaleDateString('en', { month: 'short', day: 'numeric' }); ctx.fillText(t, q[0] - ctx.measureText(t).width / 2, q[1] + 12); });
      g.particles();
      const peak = buckets.reduce((a, b) => (b.total > a.total ? b : a), buckets[0]);
      if (peak.total) g.labels([{ at: pts[buckets.indexOf(peak)].at, text: `Busiest week · ${peak.total} notes`, color: HOLO.pink }]);
      hoverTip(g, pts, hov);
    },
  });
}

/* ---------- Integrations ---------- */
const INTEG_NEON = { ok: '#5cf0a8', error: '#ff4f6d', disabled: '#5d6599', unchecked: '#ffb547' };

function viewIntegrationsPage() {
  const inner = viewIntegrations(); // also starts loading
  const d = integ.data;
  if (!d) return `<div class="holo-deck">${subHero('INTEGRATIONS', 'MCP connections', 'Checking every connection…')}<div class="skeleton" style="height:420px"></div></div>`;
  const list = d.integrations || []; const calls = d.calls || []; const clients = d.clients || [];
  const by = (st) => list.filter((i) => i.state === st).length;
  const ms = calls.map((c) => c.ms);
  const callsBy = {}; for (const c of calls) callsBy[c.integration] = (callsBy[c.integration] || 0) + 1;
  const busiest = Object.entries(callsBy).sort((a, b) => b[1] - a[1])[0];
  const okCalls = calls.filter((c) => c.ok).length;
  return `<div class="holo-deck">
    ${subHero('INTEGRATIONS', 'MCP connections', `${by('ok')} of ${list.length} connected. AI clients reach these through <code>ai-command-center</code>; edit them in config.json.`, `<span class="pill">${icon('refresh', 14)}Checked ${ago(integ.at)}</span>`)}
    ${workStage('ig-scene', 'INTEGRATION HUB', 'Centre = the ai-command-center MCP server · ring = integrations (height = tools, color = health) · left = AI clients · pulses = recent tool calls · hover a node',
      '3D map of the MCP hub, its integrations and the clients registered to it',
      Object.entries({ ok: 'Connected', error: 'Error', unchecked: 'Not checked', disabled: 'Disabled' }).map(([k, l]) => `<span><i style="background:${INTEG_NEON[k]}"></i>${l}</span>`).join(''))}
    <div class="live-metrics">${[
      metricTile({ label: 'Integrations', value: whole.format(list.length), sub: `${list.filter((i) => i.enabled !== false).length} enabled`, color: HOLO.cyan }),
      metricTile({ label: 'Connected', value: whole.format(by('ok')), sub: 'answering health checks', color: INTEG_NEON.ok, p: list.length ? by('ok') / list.length : 0 }),
      metricTile({ label: 'Errors', value: whole.format(by('error')), sub: by('error') ? esc(list.find((i) => i.state === 'error').id) : 'none', color: INTEG_NEON.error }),
      metricTile({ label: 'Disabled', value: whole.format(by('disabled')), sub: 'turned off in config', color: INTEG_NEON.disabled }),
      metricTile({ label: 'Tools exposed', value: whole.format(list.reduce((a, i) => a + (i.tools || 0), 0)), sub: 'to AI clients', color: HOLO.violet }),
      metricTile({ label: 'Write tools', value: whole.format(list.reduce((a, i) => a + (i.writeTools || 0), 0)), sub: `${list.filter((i) => i.allowWrite).length} integrations allow writes`, color: HOLO.orange }),
      metricTile({ label: 'Clients registered', value: `${clients.filter((c) => c.registered).length} / ${clients.length}`, sub: clients.filter((c) => c.registered).map((c) => esc(c.name)).join(' · ') || 'none yet', color: HOLO.blue, p: clients.length ? clients.filter((c) => c.registered).length / clients.length : 0 }),
      metricTile({ label: 'Recent calls', value: whole.format(calls.length), sub: calls[0] ? `latest ${ago(calls[0].ts)}` : 'none yet', color: HOLO.cyan }),
      metricTile({ label: 'Call success', value: calls.length ? pct(okCalls / calls.length) : '—', sub: `${whole.format(calls.length - okCalls)} failed`, color: INTEG_NEON.ok, p: calls.length ? okCalls / calls.length : null }),
      metricTile({ label: 'Latency p50', value: msFmt(quantile(ms, 0.5)), sub: `p95 ${msFmt(quantile(ms, 0.95))}`, color: HOLO.pink }),
      metricTile({ label: 'Busiest integration', value: busiest ? esc(busiest[0]) : '—', sub: busiest ? `${busiest[1]} calls` : 'no calls yet', color: HOLO.pink }),
      metricTile({ label: 'Fastest health', value: list.filter((i) => i.latencyMs != null && i.state === 'ok').length ? esc([...list].filter((i) => i.latencyMs != null && i.state === 'ok').sort((a, b) => a.latencyMs - b.latencyMs)[0].id) : '—', sub: 'lowest check latency', color: HOLO.blue }),
    ].join('')}</div>
    <div class="integ-legacy">${inner}</div>
  </div>`;
}

function mountIntegrations() {
  const canvas = $('#ig-scene'); const d = integ.data; if (!canvas || !d) return;
  const list = d.integrations || []; const clients = d.clients || []; const calls = d.calls || [];
  const callsBy = {}; const recent = {};
  for (const c of calls) { callsBy[c.integration] = (callsBy[c.integration] || 0) + 1; if (Date.now() - c.ts < 3600000) recent[c.integration] = (recent[c.integration] || 0) + 1; }
  const maxTools = Math.max(1, ...list.map((i) => i.tools || 0));
  const hov = { tip: '' };
  isoStage(canvas, {
    fit: [13, 8.4], origin: [0.5, 0.62],
    draw(g) {
      const { P, ctx, t, still } = g;
      g.glow(); g.platform(-5.8, 5.8, -3.2, 2.8);
      g.wall(-5.6, -2.7, -0.1, -3.0, { vals: list.map((i) => callsBy[i.id] || 0), color: HOLO.cyan, title: 'TOOL CALLS BY INTEGRATION', value: whole.format(calls.length), H: 2.4 });
      g.wall(0.1, -3.0, 5.6, -2.7, { vals: list.map((i) => i.latencyMs || 0), color: HOLO.pink, title: 'HEALTH-CHECK LATENCY', value: msFmt(quantile(list.map((i) => i.latencyMs), 0.5)), H: 2.4 });
      const hub = [0.6, -0.1];
      const nodes = list.map((i, k) => { const a = (k / Math.max(1, list.length)) * Math.PI * 2 - Math.PI / 2; return { i, x: hub[0] + Math.cos(a) * 3.6, z: hub[1] + Math.sin(a) * 1.9 }; });
      const cls = clients.map((c, k) => ({ c, x: -5.1, z: -1.4 + k * (2.8 / Math.max(1, clients.length - 1 || 1)) }));
      // Beams: hub to every integration and client; pulses travel on beams with calls in the last hour
      const hc = P(hub[0] + 0.4, 0.55, hub[1] + 0.4);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (const nd of nodes) {
        const p2 = P(nd.x + 0.3, 0.1, nd.z + 0.3); const col = INTEG_NEON[nd.i.state] || HOLO.cyan;
        ctx.strokeStyle = hexA(col, nd.i.state === 'disabled' ? 0.25 : 0.55); ctx.lineWidth = 1.4; ctx.setLineDash(nd.i.state === 'disabled' ? [4, 5] : []);
        ctx.beginPath(); ctx.moveTo(hc[0], hc[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke(); ctx.setLineDash([]);
        const n = recent[nd.i.id] || 0;
        for (let j = 0; j < Math.min(4, n); j++) {
          const f = still ? (j + 1) / 5 : (t * 0.5 + j / Math.min(4, n)) % 1;
          ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 10;
          ctx.beginPath(); ctx.arc(p2[0] + (hc[0] - p2[0]) * f, p2[1] + (hc[1] - p2[1]) * f, 2.6, 0, 7); ctx.fill();
        }
      }
      for (const cl of cls) {
        const p2 = P(cl.x + 0.25, 0.3, cl.z + 0.25);
        ctx.strokeStyle = cl.c.registered ? 'rgba(77, 232, 255, .6)' : 'rgba(143, 152, 204, .3)'; ctx.lineWidth = 1.2; ctx.setLineDash(cl.c.registered ? [] : [3, 5]); ctx.shadowBlur = 0;
        ctx.beginPath(); ctx.moveTo(p2[0], p2[1]); ctx.lineTo(hc[0], hc[1]); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.restore();
      const items = []; const pts = [];
      items.push({ depth: P(hub[0], 0, hub[1])[2], draw: () => {
        g.box(hub[0], hub[1], 0.8, 0.8, 0.5, '#4de8ff', { glow: 24, slices: 0 });
        const c = P(hub[0] + 0.4, 0.95 + Math.sin(t * 2) * 0.05, hub[1] + 0.4);
        ctx.save(); ctx.strokeStyle = '#4de8ff'; ctx.lineWidth = 2; ctx.shadowColor = '#4de8ff'; ctx.shadowBlur = 14;
        ctx.beginPath(); ctx.ellipse(c[0], c[1], g.s * 0.6, g.s * 0.22, 0, 0, 7); ctx.stroke(); ctx.restore();
      } });
      for (const nd of nodes) {
        const col = INTEG_NEON[nd.i.state] || HOLO.cyan; const h = ease(`ig:${nd.i.id}`, 0.2 + 1.8 * ((nd.i.tools || 0) / maxTools), still);
        items.push({ depth: P(nd.x, 0, nd.z)[2], draw: () => g.box(nd.x, nd.z, 0.6, 0.6, h, col, { glow: nd.i.state === 'ok' ? 14 : nd.i.state === 'error' ? 18 : 0, slices: 0.3, alpha: nd.i.state === 'disabled' ? 0.55 : 1 }) });
        pts.push({ at: P(nd.x + 0.3, h, nd.z + 0.3), key: nd.i.id, label: `${nd.i.id} · ${nd.i.state === 'ok' && nd.i.latencyMs != null ? `${nd.i.latencyMs} ms` : INTEG_STATE[nd.i.state] ? INTEG_STATE[nd.i.state][1].toLowerCase() : nd.i.state}`, color: col,
          html: () => `<b>${esc(nd.i.id)}</b><div class="row"><span>Type</span><span>${esc((INTEG_TYPES[nd.i.type] || [nd.i.type])[0])}${nd.i.flavor ? ` · ${esc(nd.i.flavor)}` : ''}</span></div><div class="row"><span>State</span><span>${esc((INTEG_STATE[nd.i.state] || ['', nd.i.state])[1])}</span></div><div class="row"><span>Tools</span><span class="num">${nd.i.tools || 0}${nd.i.writeTools ? ` · ${nd.i.writeTools} write` : ''}</span></div>${nd.i.latencyMs != null ? `<div class="row"><span>Latency</span><span class="num">${whole.format(nd.i.latencyMs)} ms</span></div>` : ''}<div class="row"><span>Recent calls</span><span class="num">${callsBy[nd.i.id] || 0}</span></div>${nd.i.error ? `<div class="row"><span>Error</span><span>${esc(nd.i.error.slice(0, 80))}</span></div>` : ''}` });
      }
      for (const cl of cls) {
        items.push({ depth: P(cl.x, 0, cl.z)[2], draw: () => g.box(cl.x, cl.z, 0.5, 0.5, 0.6, cl.c.registered ? '#5b8cff' : '#3a3f7a', { glow: cl.c.registered ? 12 : 0, slices: 0 }) });
        pts.push({ at: P(cl.x + 0.25, 0.6, cl.z + 0.25), key: `client:${cl.c.id}`, label: `${cl.c.name} · ${cl.c.registered ? 'registered' : 'not registered'}`, color: cl.c.registered ? '#5b8cff' : HOLO.muted,
          html: () => `<b>${esc(cl.c.name)}</b><div class="row"><span>Status</span><span>${cl.c.registered ? 'Registered' : 'Not registered'}</span></div><div class="row"><span>Config</span><span>${esc(cl.c.file)}</span></div>` });
      }
      items.sort((a, b) => a.depth - b.depth).forEach((it) => it.draw());
      g.particles();
      g.labels([{ at: P(hub[0] + 0.4, 0.55, hub[1] + 0.4), text: 'ai-command-center · MCP hub', color: '#4de8ff' }, ...pts.map((p) => ({ at: p.at, text: p.label, color: p.color }))]);
      hoverTip(g, pts, hov);
    },
  });
}
