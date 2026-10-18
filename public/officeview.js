'use strict';
/* AI Office page as a 3D office: every agent session (and each subagent) is a character that walks to
   the room for the tool it is using right now, read from the live transcripts via /api/office. */

const STATE_COLOR = { working: '#4de8ff', thinking: '#8b7bff', waiting: '#ffb547', approval: '#ff4f6d', idle: '#7d86b8', done: '#5cf0a8', running: '#5b8cff' };
const STATE_TEXT = { working: 'Working', thinking: 'Thinking', waiting: 'Waiting for you', approval: 'Needs approval', idle: 'Idle', done: 'Done', running: 'Running' };
const ROOMS = [
  ['code', 'Coding desks', '#6d7cff'], ['read', 'Library', '#3ee6b0'], ['terminal', 'Server room', '#4de8ff'],
  ['web', 'Web globe', '#ffb547'], ['meeting', 'Planning table', '#c45cf2'], ['tools', 'MCP hub', '#ff5ca8'],
];
const CORRIDOR_Z = 1.0;

let office = null;      // latest /api/office snapshot
let seeded = false;     // after the first snapshot, newcomers walk in through the door
const sprites = {};     // agent id -> { x, z, path, seat, ... }, kept across polls

// Seats in each room, in world units on the office floor.
const DESKS = [-4.7, -3.6, -2.5, -1.4].flatMap((x) => [-1.9, -0.6].map((z) => ({ x, z })));
const SLOTS = {
  code: DESKS.map((d) => ({ x: d.x + 0.4, z: d.z + 0.78, sit: true })),
  read: [0.75, 1.6, 2.45, 1.15, 2.05].map((x, i) => ({ x, z: i < 3 ? -2.25 : -1.75 })),
  terminal: [3.6, 4.3, 5.0, 3.95, 4.65].map((x, i) => ({ x, z: i < 3 ? -2.0 : -1.5 })),
  web: [{ x: 4.0, z: -0.45 }, { x: 4.75, z: 0.25 }, { x: 4.0, z: 0.2 }, { x: 5.2, z: -0.1 }],
  meeting: [{ x: 0.45, z: -1.55 }, { x: 1.25, z: -1.55 }, { x: 2.05, z: -1.55 }, { x: 0.45, z: -0.05 }, { x: 1.25, z: -0.05 }, { x: 2.05, z: -0.05 }],
  tools: [{ x: 4.1, z: 2.3 }, { x: 4.9, z: 1.7 }, { x: 5.2, z: 2.5 }],
  help: [0.0, 0.7, 1.4, 2.1, 0.35, 1.75].map((x, i) => ({ x, z: i < 4 ? 2.75 : 2.95 })),
  lounge: [{ x: -4.9, z: 2.25, sit: true }, { x: -4.35, z: 2.25, sit: true }, { x: -3.8, z: 2.25, sit: true }, { x: -3.2, z: 1.75 }, { x: -5.1, z: 1.6 }],
  guest: [-3.0, -2.2, -1.4].map((x) => ({ x: x + 0.3, z: 2.65, sit: true })),
};

const toolVerb = (tool) => {
  if (!tool) return '';
  if (/^mcp__/.test(tool)) return `Calling ${tool.split('__')[1] || 'MCP'}`;
  return ({ Edit: 'Editing', Write: 'Writing', MultiEdit: 'Editing', NotebookEdit: 'Editing', apply_patch: 'Patching', Read: 'Reading', Grep: 'Searching', Glob: 'Finding files', LS: 'Listing',
    Bash: 'Running', exec: 'Running', shell: 'Running', exec_command: 'Running', BashOutput: 'Watching', WebFetch: 'Browsing', WebSearch: 'Searching the web', web_search: 'Searching the web',
    Task: 'Delegating to', Agent: 'Delegating to', TodoWrite: 'Planning', update_plan: 'Planning', Skill: 'Using skill', AskUserQuestion: 'Asking you', request_user_input_async: 'Asking you' })[tool] || tool;
};
function agentName(a) {
  if (a.kind === 'subagent') return a.agentType || 'subagent';
  if (a.kind === 'guest') return a.name;
  const same = office.agents.filter((x) => x.kind === 'session' && x.project === a.project);
  return same.length > 1 ? `${a.project || 'session'} #${same.indexOf(a) + 1}` : a.project || 'session';
}
function doing(a) {
  const act = a.activity ? `${toolVerb(a.activity.tool)}${a.activity.target ? ' ' + a.activity.target : ''}` : '';
  if (a.state === 'working') return act || 'Working';
  if (a.state === 'thinking') return 'Thinking…';
  if (a.state === 'approval') return `Needs approval${act ? ' · ' + act : ''}`;
  if (a.state === 'waiting') return a.activity ? 'Asked you a question' : 'Waiting for you';
  return STATE_TEXT[a.state] || a.state;
}
const agentColor = (a) => (a.kind === 'guest' ? a.color : a.tool === 'codex' ? '#ff8a4c' : a.kind === 'subagent' ? '#a99cff' : '#6d7cff');

// Office agents plus running apps without readable logs, seated in the guest booths.
function floorAgents() {
  const live = state.live || { apps: [] };
  const guests = live.apps.filter((x) => !['claude', 'codex'].includes(x.id)).slice(0, 3).map((x, i) => ({
    id: `app:${x.id}`, kind: 'guest', name: x.name, state: 'running', zone: 'guest', color: appColor(i + 1), cpu: x.cpu, memMB: x.memMB, activity: null, calls10m: 0, lastTs: live.ts,
  }));
  return [...(office ? office.agents : []), ...guests];
}

/* ---------- page ---------- */
function viewSquad() {
  const s = squadCards(99);
  return `<div class="holo-deck">${subTabs('squad')}
    <div class="hero"><div><div class="eyebrow">AI OFFICE</div><h1>The AI office</h1>
      <p>Each agent session is a character. It walks to the room for the tool it is using right now, read live from your transcripts.</p></div>
      <div class="hero-actions"><span class="pill live-pill"><i class="live-dot"></i><span id="of-clock">CONNECTING</span></span><span class="pill" id="of-count"></span></div></div>

    <section class="holo stage office-stage">
      <canvas id="of-scene" aria-label="3D office: agent characters move between coding desks, library, server room, web globe, planning table, MCP hub, help desk and lounge according to what they are doing"></canvas>
      <div class="stage-tl"><div class="holo-kicker">AGENTS AT WORK · 3D OFFICE</div>
        <div class="stage-key">Desks = editing · library = reading · server room = shell · globe = web · table = planning &amp; delegating · help desk = waiting for you · lounge = idle</div></div>
      <div class="stage-readouts" id="of-readouts"></div>
      <div class="stage-legend">${Object.entries(STATE_COLOR).filter(([k]) => k !== 'done').map(([k, c]) => `<span><i style="background:${c}"></i>${STATE_TEXT[k]}</span>`).join('')}</div>
    </section>

    <div class="live-metrics" id="of-metrics"></div>

    <div class="live-grid">
      <section class="holo panel"><div class="panel-head"><h3>Agent roster</h3><span class="meta">sessions written in the last 30 minutes</span></div>
        <div class="table-wrap" id="of-roster"><div class="empty">Reading transcripts…</div></div></section>
      <section class="holo panel"><div class="panel-head"><h3>Live activity</h3><span class="meta">latest tool calls</span></div>
        <div class="feed" id="of-feed"></div></section>
    </div>

    <div class="section-head"><h2>Installed AI tools</h2><span class="meta">— ${s.total} detected · ${s.running} running now · usage for the ${rangeText()}</span></div>
    <div class="grid squad">${s.html}</div>
  </div>`;
}

function paintOffice() {
  if (!office) return;
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const ag = office.agents; const count = (st) => ag.filter((a) => a.state === st).length;
  const subs = ag.filter((a) => a.kind === 'subagent' && a.state !== 'done').length;
  const zones = {}; for (const a of ag) for (const [z, n] of Object.entries(a.zones10m || {})) zones[z] = (zones[z] || 0) + n;
  const calls = ag.reduce((x, a) => x + (a.calls10m || 0), 0);
  const busiest = [...ag].sort((x, y) => (y.calls10m || 0) - (x.calls10m || 0))[0];
  const clock = document.getElementById('of-clock'); if (clock) clock.textContent = `LIVE · ${new Date(office.ts).toLocaleTimeString()}`;
  set('of-count', `${icon('bot', 14)}${ag.length} agent${ag.length === 1 ? '' : 's'} on the floor`);
  set('of-readouts', readouts([
    { label: 'Working now', icon: 'terminal', value: String(count('working') + count('thinking')), sub: `${count('working')} on a tool · ${count('thinking')} thinking`, color: STATE_COLOR.working,
      pips: ag.filter((a) => a.state === 'working' || a.state === 'thinking').map((a) => STATE_COLOR[a.state]) },
    { label: 'Needs you', icon: 'alert', value: String(count('waiting') + count('approval')), sub: `${count('approval')} approval · ${count('waiting')} waiting`, color: count('approval') ? STATE_COLOR.approval : STATE_COLOR.waiting,
      pips: ag.filter((a) => a.state === 'approval' || a.state === 'waiting').map((a) => STATE_COLOR[a.state]) },
    { label: 'Subagents', icon: 'sparkle', value: String(subs), sub: 'delegated helpers active', color: '#a99cff', pips: ag.filter((a) => a.kind === 'subagent' && a.state !== 'done').map(() => '#a99cff') },
    { label: 'Tool calls · 10m', icon: 'wave', value: whole.format(calls), sub: `${(office.perMinute || []).slice(-1)[0] || 0} in the last minute`, color: HOLO.pink, spark: office.perMinute || [] },
  ]));
  set('of-metrics', [
    metricTile({ label: 'On the floor', value: String(ag.length).padStart(2, '0'), sub: `${ag.filter((a) => a.kind === 'session').length} sessions · ${subs} subagents`, color: HOLO.cyan }),
    metricTile({ label: 'Working', value: String(count('working')), sub: 'tool call in flight', color: STATE_COLOR.working, p: ag.length ? count('working') / ag.length : 0 }),
    metricTile({ label: 'Thinking', value: String(count('thinking')), sub: 'model is generating', color: STATE_COLOR.thinking, p: ag.length ? count('thinking') / ag.length : 0 }),
    metricTile({ label: 'Waiting for you', value: String(count('waiting')), sub: 'finished a turn or asked', color: STATE_COLOR.waiting, p: ag.length ? count('waiting') / ag.length : 0 }),
    metricTile({ label: 'Needs approval', value: String(count('approval')), sub: 'tool call stuck > 45 s', color: STATE_COLOR.approval, p: ag.length ? count('approval') / ag.length : 0 }),
    metricTile({ label: 'Idle', value: String(count('idle')), sub: 'quiet for 5+ minutes', color: STATE_COLOR.idle }),
    metricTile({ label: 'Tool calls · 10m', value: whole.format(calls), sub: `${(office.perMinute || []).slice(-1)[0] || 0} in the last minute`, color: HOLO.pink, spark: office.perMinute || [] }),
    ...ROOMS.slice(0, 4).map(([z, label, c]) => metricTile({ label: `${label} · 10m`, value: whole.format(zones[z] || 0), sub: `${calls ? Math.round(((zones[z] || 0) / calls) * 100) : 0}% of calls`, color: c, p: calls ? (zones[z] || 0) / calls : 0 })),
    metricTile({ label: 'Busiest agent', value: busiest && busiest.calls10m ? esc(agentName(busiest)) : '—', sub: busiest && busiest.calls10m ? `${busiest.calls10m} calls in 10 min` : 'no tool calls yet', color: HOLO.violet }),
  ].join(''));
  set('of-roster', ag.length ? `<table class="holo-table"><thead><tr><th>Agent</th><th>State</th><th>Doing</th><th class="r">Calls · 10m</th><th class="r">Last action</th></tr></thead><tbody>
    ${ag.map((a) => `<tr><td><span class="tool-dot" style="background:${agentColor(a)}"></span><b>${esc(agentName(a))}</b>
        <small class="block muted">${a.kind === 'subagent' ? `subagent of ${esc(agentName(office.agents.find((p) => p.id === a.parent) || { kind: 'session', project: a.project }))}` : esc(toolName(a.tool))}${a.model ? ` · ${esc(a.model.replace(/^claude-/, ''))}` : ''}</small></td>
      <td><span class="state-pill" style="--c:${STATE_COLOR[a.state]}"><i></i>${STATE_TEXT[a.state]}</span></td>
      <td class="clip-wide">${esc(doing(a))}</td><td class="r num">${a.calls10m || 0}</td><td class="r muted">${ago(a.lastTs)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">No agent has written a transcript in the last 30 minutes. Start a Claude Code or Codex session and it walks in here.</div>');
  const byId = new Map(ag.map((a) => [a.id, a]));
  set('of-feed', office.feed.length ? office.feed.slice(0, 14).map((e) => {
    const a = byId.get(e.agent); const room = ROOMS.find((r) => r[0] === e.zone) || ROOMS[0];
    return `<div class="feed-row"><span class="feed-dot" style="background:${room[2]}"></span><span class="muted num">${new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>
      <b>${esc(a ? agentName(a) : '—')}</b><span>${esc(toolVerb(e.tool))}${e.target ? ` <code>${esc(e.target)}</code>` : ''}</span></div>`;
  }).join('') : '<div class="empty">No tool calls yet.</div>');
}
const spark = (vals) => `<span class="metric-spark">${sparkline(vals, HOLO.pink)}</span>`;

/* ---------- 3D office ---------- */
// Pick a free slot in the agent's room; agents keep their seat while they stay in the same room.
function assignSeats(agents) {
  const taken = {};
  const home = {}; // session -> desk index, so each session has its own desk
  agents.filter((a) => a.kind !== 'guest').forEach((a, i) => { home[a.id] = i % DESKS.length; });
  for (const a of agents) {
    const sp = (sprites[a.id] ||= spawnSprite(a));
    const room = a.zone || 'lounge';
    const slots = SLOTS[room] || SLOTS.lounge;
    let idx;
    if (room === 'code') idx = home[a.id];
    else if (room === 'guest') idx = agents.filter((x) => x.kind === 'guest').indexOf(a);
    else idx = sp.room === room && sp.slot != null && !(taken[room] || new Set()).has(sp.slot) ? sp.slot : slots.findIndex((_, k) => !(taken[room] || new Set()).has(k));
    if (idx < 0 || idx == null) idx = Math.floor(Math.random() * slots.length);
    (taken[room] ||= new Set()).add(idx);
    if (sp.room !== room || sp.slot !== idx) {
      const s = slots[idx % slots.length];
      // Walk out to the corridor, along it, then into the room.
      sp.path = sp.room ? [{ x: sp.x, z: CORRIDOR_Z }, { x: s.x, z: CORRIDOR_Z }, { x: s.x, z: s.z }] : [{ x: s.x, z: s.z }];
      if (!sp.room) { sp.x = s.x; sp.z = s.z; sp.path = []; }
      sp.room = room; sp.slot = idx; sp.sit = !!s.sit;
    }
  }
  for (const id of Object.keys(sprites)) if (!agents.some((a) => a.id === id)) delete sprites[id];
  if (office) seeded = true;
}
function spawnSprite(a) {
  const parent = a.parent && sprites[a.parent];
  // Subagents appear next to their parent and walk off from there.
  if (parent) return { x: parent.x + 0.3, z: parent.z + 0.3, room: 'spawn', slot: null, path: [], sit: false, phase: Math.random() * 6 };
  return seeded ? { x: -5.5, z: CORRIDOR_Z, room: 'door', slot: null, path: [], sit: false, phase: Math.random() * 6 }
    : { x: 0, z: 0, room: null, slot: null, path: [], sit: false, phase: Math.random() * 6 };
}

let ofLast = 0; let ofTip = '';
function drawOffice(g) {
  const { P, ctx, still, t } = g;
  const dt = Math.min(0.1, ofLast ? t - ofLast : 0); ofLast = t;
  g.glow();
  g.platform(-5.6, 5.6, -3.3, 3.2);
  const agents = floorAgents();
  assignSeats(agents);

  // Back walls: tool calls by room (10 min) and tool calls per minute (15 min)
  const zones = {}; for (const a of agents) for (const [z, n] of Object.entries(a.zones10m || {})) zones[z] = (zones[z] || 0) + n;
  const roomVals = ROOMS.map(([z]) => zones[z] || 0); const top = roomVals.indexOf(Math.max(...roomVals));
  g.wall(-5.4, -3.05, -0.2, -3.25, { vals: roomVals, color: HOLO.violet, title: 'CALLS BY ROOM · 10 MIN', value: roomVals[top] ? `busiest: ${ROOMS[top][1].toLowerCase()}` : 'quiet', hot: roomVals[top] ? top : -1, H: 2.6 });
  const pm = office ? office.perMinute : Array(15).fill(0);
  g.wall(0.2, -3.25, 5.4, -3.05, { vals: pm, color: HOLO.cyan, title: 'TOOL CALLS / MIN · 15 MIN', value: `${pm[pm.length - 1] || 0} this minute`, hot: pm.length - 1, H: 2.6 });

  const items = [];
  const add = (x, z, draw) => items.push({ depth: P(x, 0, z)[2], draw });
  const deskOwner = {};
  for (const a of agents) { const sp = sprites[a.id]; if (sp && sp.room === 'code' && !sp.path.length) deskOwner[sp.slot] = a; }
  // Coding desks with monitors; a monitor glows in its owner's state color
  DESKS.forEach((d, i) => {
    add(d.x + 0.4, d.z + 0.25, () => {
      g.box(d.x, d.z, 0.8, 0.5, 0.36, '#3a3f8f', { slices: 0, glow: 0 });
      const o = deskOwner[i]; const c = o ? STATE_COLOR[o.state] : '#2c3270';
      g.box(d.x + 0.15, d.z + 0.05, 0.5, 0.05, 0.3, c, { y0: 0.36, slices: 0, glow: o ? 16 : 0 });
    });
  });
  // Library shelves with book spines
  [0.35, 1.2, 2.05].forEach((x, i) => add(x + 0.38, -2.75, () => {
    g.box(x, -2.95, 0.75, 0.35, 1.5, '#2f6f78', { slices: 0.37, glow: 0 });
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let r = 0; r < 4; r++) for (let b = 0; b < 6; b++) {
      const bx = x + 0.08 + b * 0.11; const by = 0.08 + r * 0.37; const h = 0.18 + ((b * 7 + r * 3 + i) % 5) * 0.025;
      const p0 = P(bx, by, -2.6); const p1 = P(bx, by + h, -2.6);
      ctx.strokeStyle = ['#3ee6b0', '#ffb547', '#ff5ca8', '#8b7bff', '#4de8ff'][(b + r + i) % 5]; ctx.lineWidth = Math.max(2, g.s * 0.06);
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
    }
    ctx.restore();
  }));
  // Server racks with blinking LEDs
  [3.25, 3.95, 4.65].forEach((x, i) => add(x + 0.27, -2.7, () => {
    g.box(x, -2.95, 0.55, 0.55, 1.7, '#1d2560', { slices: 0.2, glow: 0 });
    const busy = agents.filter((a) => a.zone === 'terminal').length;
    for (let r = 0; r < 7; r++) {
      const on = still ? r % 2 : Math.sin(t * (3 + r) + i * 2 + r) > (busy ? -0.2 : 0.6);
      const q = P(x + 0.1 + (r % 3) * 0.15, 0.2 + r * 0.21, -2.4);
      ctx.fillStyle = on ? (r % 3 ? '#5cf0a8' : '#4de8ff') : 'rgba(80, 90, 160, .5)'; ctx.fillRect(q[0] - 1.5, q[1] - 1.5, 3, 3);
    }
  }));
  // Web globe on a pedestal: spins faster while someone is browsing
  add(4.7, -0.6, () => {
    g.box(4.5, -0.8, 0.4, 0.4, 0.5, '#2b3180', { slices: 0, glow: 0 });
    const c = P(4.7, 1.05, -0.6); const r = g.s * 0.42; const busy = agents.some((a) => a.zone === 'web');
    const spin = still ? 0 : t * (busy ? 1.6 : 0.3);
    ctx.save(); ctx.strokeStyle = busy ? '#ffb547' : 'rgba(255, 181, 71, .55)'; ctx.lineWidth = 1.2; ctx.shadowColor = '#ffb547'; ctx.shadowBlur = busy ? 12 : 0;
    ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, 7); ctx.stroke();
    for (let k = 0; k < 4; k++) { const w = Math.abs(Math.cos(spin + (k * Math.PI) / 4)) * r; ctx.beginPath(); ctx.ellipse(c[0], c[1], w, r, 0, 0, 7); ctx.stroke(); }
    for (const f of [-0.5, 0, 0.5]) { ctx.beginPath(); ctx.ellipse(c[0], c[1] + f * r, r * Math.sqrt(1 - f * f), r * 0.18, 0, 0, 7); ctx.stroke(); }
    ctx.restore();
  });
  // Planning table, MCP hub, help desk, lounge sofa and guest booths
  add(1.25, -0.8, () => g.box(0.35, -1.2, 1.8, 0.8, 0.34, '#5b3fa8', { slices: 0, glow: 0 }));
  add(4.7, 2.1, () => {
    g.box(4.45, 1.85, 0.5, 0.5, 0.35, '#5a2a7a', { slices: 0, glow: 0 });
    const c = P(4.7, 0.75 + Math.sin(t * 2) * 0.05, 2.1); const busy = agents.some((a) => a.zone === 'tools');
    ctx.save(); ctx.strokeStyle = '#ff5ca8'; ctx.lineWidth = 2; ctx.shadowColor = '#ff5ca8'; ctx.shadowBlur = busy ? 16 : 6;
    ctx.beginPath(); ctx.ellipse(c[0], c[1], g.s * 0.42, g.s * 0.16, 0, 0, 7); ctx.stroke(); ctx.restore();
  });
  add(1.05, 2.2, () => {
    g.box(0.0, 2.0, 2.1, 0.45, 0.55, '#7a5a1e', { slices: 0, glow: 0 });
    const q = P(1.05, 1.6 + (still ? 0 : Math.sin(t * 2.2) * 0.06), 2.2); const needs = agents.some((a) => a.state === 'approval');
    ctx.save(); ctx.font = `800 ${Math.round(g.s * 0.55)}px system-ui, sans-serif`; ctx.textAlign = 'center';
    ctx.fillStyle = needs ? STATE_COLOR.approval : STATE_COLOR.waiting; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 18; ctx.fillText(needs ? '!' : '?', q[0], q[1]);
    ctx.font = '700 10px system-ui, sans-serif'; ctx.shadowBlur = 0; ctx.fillText('HELP DESK', q[0], q[1] + 14); ctx.restore();
  });
  add(-4.3, 2.05, () => {
    g.box(-5.25, 1.95, 1.9, 0.45, 0.22, '#3b2f7a', { slices: 0, glow: 0 });
    g.box(-5.25, 2.35, 1.9, 0.12, 0.5, '#4a3a92', { slices: 0, glow: 0 });
    g.box(-4.0, 1.35, 0.5, 0.35, 0.18, '#2d3478', { slices: 0, glow: 0 });
  });
  SLOTS.guest.forEach((s, i) => add(s.x, 2.0, () => {
    const gst = agents.filter((a) => a.kind === 'guest')[i];
    g.box(s.x - 0.3, 1.95, 0.6, 0.4, 0.34, '#33397f', { slices: 0, glow: 0 });
    g.box(s.x - 0.2, 1.97, 0.4, 0.04, 0.24, gst ? gst.color : '#2c3270', { y0: 0.34, slices: 0, glow: gst ? 10 + Math.min(20, gst.cpu * 2) : 0 });
  }));

  // Characters
  const heads = {};
  for (const a of agents) {
    const sp = sprites[a.id]; if (!sp) continue;
    if (sp.path.length && !still) {
      const tgt = sp.path[0]; const dx = tgt.x - sp.x; const dz = tgt.z - sp.z; const d = Math.hypot(dx, dz); const step = 1.7 * dt;
      if (d <= step) { sp.x = tgt.x; sp.z = tgt.z; sp.path.shift(); } else { sp.x += (dx / d) * step; sp.z += (dz / d) * step; }
    } else if (sp.path.length) { const last = sp.path[sp.path.length - 1]; sp.x = last.x; sp.z = last.z; sp.path = []; }
    const walking = sp.path.length > 0;
    const scale = a.kind === 'subagent' ? 1.05 : 1.3;
    add(sp.x, sp.z + 0.01, () => { heads[a.id] = person(g, sp, a, scale, walking); });
  }
  items.sort((p, q) => p.depth - q.depth).forEach((it) => it.draw());
  g.particles();

  // Subagent links to their parent
  ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(169, 156, 255, .7)'; ctx.lineWidth = 1.2;
  for (const a of agents) if (a.parent && heads[a.id] && heads[a.parent]) { ctx.beginPath(); ctx.moveTo(...heads[a.parent]); ctx.lineTo(...heads[a.id]); ctx.stroke(); }
  ctx.restore();

  // Name and activity callouts
  g.labels(agents.filter((a) => heads[a.id]).map((a) => ({ at: [heads[a.id][0], heads[a.id][1] - 10], text: `${agentName(a)} · ${a.kind === 'guest' ? `${a.cpu.toFixed(1)}% CPU` : doing(a)}`, color: STATE_COLOR[a.state] })));

  // Hover a character for details
  const p = g.pointer; let hit = null;
  if (p) for (const a of agents) { const h = heads[a.id]; if (h && Math.hypot(h[0] - p.x, h[1] + 12 - p.y) < 22) hit = a; }
  if (hit) {
    const key = `${hit.id}|${hit.state}|${p.cx}|${p.cy}`;
    if (key !== ofTip) {
      const rows = [['State', STATE_TEXT[hit.state]], ['Doing', hit.kind === 'guest' ? 'no readable logs' : doing(hit)], hit.model ? ['Model', hit.model] : null,
        hit.kind !== 'guest' ? ['Tool calls · 10m', String(hit.calls10m || 0)] : ['CPU', `${hit.cpu.toFixed(1)}%`], ['Last action', ago(hit.lastTs)]].filter(Boolean);
      showTip({ clientX: p.cx, clientY: p.cy }, `<b>${esc(agentName(hit))}</b>${rows.map(([k, v]) => `<div class="row"><span>${k}</span><span>${esc(v)}</span></div>`).join('')}`);
    }
    ofTip = key;
  } else if (ofTip) { hideTip(); ofTip = ''; }
}

// A small figure: state ring, legs, body, head with a visor. Returns the screen point above its head.
function person(g, sp, a, k, walking) {
  const { P, ctx, t, still } = g; const c = agentColor(a); const sc = STATE_COLOR[a.state];
  const sitting = sp.sit && !walking;
  const bob = still ? 0 : walking ? Math.abs(Math.sin(t * 9 + sp.phase)) * 0.04 : a.state === 'working' ? Math.sin(t * 14 + sp.phase) * 0.012 : Math.sin(t * 1.6 + sp.phase) * 0.01;
  const base = (sitting ? 0.16 : 0.3) * k + bob;
  // State ring on the floor (pulses while working, blinks when approval is needed)
  const ring = P(sp.x, 0.01, sp.z);
  const pulse = still ? 1 : a.state === 'approval' ? (Math.sin(t * 8) > 0 ? 1 : 0.25) : 0.6 + 0.4 * Math.sin(t * 3 + sp.phase);
  ctx.save(); ctx.strokeStyle = hexA(sc, 0.9 * pulse); ctx.lineWidth = 2; ctx.shadowColor = sc; ctx.shadowBlur = 10;
  ctx.beginPath(); ctx.ellipse(ring[0], ring[1], g.s * 0.26 * k, g.s * 0.12 * k, 0, 0, 7); ctx.stroke(); ctx.restore();
  // Legs
  if (!sitting) {
    const swing = walking && !still ? Math.sin(t * 9 + sp.phase) * 0.12 : 0;
    ctx.strokeStyle = hexA(c, 0.9); ctx.lineWidth = Math.max(2, g.s * 0.05 * k);
    for (const side of [-1, 1]) {
      const hip = P(sp.x + side * 0.06 * k, base, sp.z); const foot = P(sp.x + side * 0.06 * k + swing * side, 0, sp.z + swing * side * 0.5);
      ctx.beginPath(); ctx.moveTo(hip[0], hip[1]); ctx.lineTo(foot[0], foot[1]); ctx.stroke();
    }
  }
  // Body
  g.box(sp.x - 0.13 * k, sp.z - 0.09 * k, 0.26 * k, 0.18 * k, 0.34 * k, c, { y0: base, slices: 0, glow: a.state === 'working' ? 12 : 0, alpha: a.state === 'idle' ? 0.7 : 1 });
  // Arms typing at a desk
  if (sitting && a.zone === 'code' && a.state === 'working' && !still) {
    ctx.strokeStyle = hexA(c, 0.9); ctx.lineWidth = 2;
    for (const side of [-1, 1]) {
      const sh = P(sp.x + side * 0.13 * k, base + 0.28 * k, sp.z); const hand = P(sp.x + side * 0.1 * k, base + 0.12 * k + Math.sin(t * 18 + side) * 0.03, sp.z - 0.28);
      ctx.beginPath(); ctx.moveTo(sh[0], sh[1]); ctx.lineTo(hand[0], hand[1]); ctx.stroke();
    }
  }
  // Head with visor
  const h = P(sp.x, base + 0.34 * k + 0.13 * k, sp.z); const r = g.s * 0.12 * k;
  ctx.save(); ctx.fillStyle = '#e8ecff'; ctx.shadowColor = sc; ctx.shadowBlur = a.state === 'idle' ? 0 : 10;
  ctx.beginPath(); ctx.arc(h[0], h[1], r, 0, 7); ctx.fill(); ctx.restore();
  ctx.fillStyle = sc; ctx.fillRect(h[0] - r * 0.7, h[1] - r * 0.2, r * 1.4, r * 0.4);
  // Thinking dots
  if (a.state === 'thinking' && !still) {
    for (let i = 0; i < 3; i++) { ctx.fillStyle = hexA(STATE_COLOR.thinking, 0.4 + 0.6 * Math.max(0, Math.sin(t * 5 - i))); ctx.beginPath(); ctx.arc(h[0] + r + 4 + i * 6, h[1] - r - 2 - i * 3, 2.2, 0, 7); ctx.fill(); }
  }
  return [h[0], h[1] - r];
}

/* ---------- lifecycle ---------- */
async function pollOffice() {
  try {
    office = await api('/api/office');
    paintOffice();
  } catch { /* server restarting */ }
}
function mountSquad() {
  const canvas = $('#of-scene');
  if (!canvas) return;
  if (office) paintOffice();
  pollOffice();
  const timer = setInterval(() => { if (document.contains(canvas)) pollOffice(); }, 3000);
  isoStage(canvas, { draw: drawOffice, fit: [13.2, 8.4], origin: [0.47, 0.6], onDestroy: () => { clearInterval(timer); ofLast = 0; } });
}
