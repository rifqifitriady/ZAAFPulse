'use strict';
/* Local model servers in the dashboard: Start and Stop in AI Office (an action row on the Ollama and LM Studio cards,
   a card of their own for llama.cpp, Jan, LocalAI and the owner's runtimes) and Settings → Local models (the owner's
   entries: add, edit, delete, approve). Everything from /api/runtimes reaches the page as text: nodes are made with
   createElement and filled with textContent (S1). The only innerHTML here is this app's own icon markup. The helpers
   at the top are pure, so test/runtimes-ui.test.js runs them without a browser. */

const RT_CARD_IDS = ['ollama', 'lmstudio']; // runtimes that already have a card among the installed AI tools
const RT_POLL_MS = 5000;
const RT_ID_RE = /^[a-z0-9-]{1,40}$/;
const RT_HOW = {
  app: 'app',
  service: 'brew service',
  zaafpulse: 'started here',
  process: 'started outside ZAAFPulse',
  system: 'managed by the system',
};
const RT_DESC = {
  ollama: 'Runs open models on this machine. Stopping the server unloads every model.',
  lmstudio: 'Runs open models on this machine. Start and Stop use its lms command.',
  llamacpp: "llama.cpp's OpenAI-compatible server. Add it in Settings → Local models with a model file to start it here.",
  jan: "Jan desktop app. Its local API server answers on port 1337 while it is on in Jan's settings.",
  localai: 'LocalAI, an OpenAI-compatible server for local models.',
};
const RT_OWN_DESC = 'Your own runtime from Settings → Local models.';

// One line of text from the server: control characters out, spaces folded, clipped. Markup stays text.
const rtText = (v, max = 300) =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const rtCap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// The runtime's status line: { cls: 'running' | 'idle' | 'off', text }.
function rtStatus(r) {
  if (!r || typeof r !== 'object') return { cls: 'off', text: '' };
  const port = Number.isInteger(r.port) ? ` · port ${r.port}` : '';
  if (r.running) {
    const n = Number.isInteger(r.children) ? r.children : 0;
    const kids = n > 0 ? ` · ${n} model process${n === 1 ? '' : 'es'}` : '';
    return { cls: 'running', text: `Server running${port}${r.healthy ? '' : ' · not answering'}${kids}` };
  }
  if (!r.installed) return { cls: 'off', text: 'Not installed' };
  return { cls: 'idle', text: `Server stopped${port}` };
}

// How a running server runs, as a short note next to Stop; '' when it is not running.
const rtHowNote = (r) => (r && r.running && Object.hasOwn(RT_HOW, r.how) ? RT_HOW[r.how] : '');

// The one button a runtime gets, or null: Stop while running, Start while stopped, a label while a request is out.
function rtButton(r, busy) {
  if (busy === 'start') return { action: 'start', label: 'Starting…', disabled: true };
  if (busy === 'stop') return { action: 'stop', label: 'Stopping…', disabled: true };
  if (!r) return null;
  if (r.running && r.canStop === true) return { action: 'stop', label: 'Stop', disabled: false };
  if (!r.running && r.canStart === true) return { action: 'start', label: 'Start', disabled: false };
  return null;
}

const rtConfirmText = (r) => `Stop ${rtText(r && r.name, 60) || 'this server'}? Models it has loaded are unloaded.`;

// What happened, from the answer of /api/runtimes/start or /stop.
function rtResultText(action, res) {
  if (!res || typeof res !== 'object') return '';
  if (res.demo) return `Demo mode: nothing was ${action === 'stop' ? 'stopped' : 'started'}.`;
  if (res.state === 'running') return 'Started.';
  if (res.state === 'starting') return `${rtCap(rtText(res.note)) || 'Started, not answering yet'}.`;
  if (res.state === 'stopped') return 'Stopped.';
  if (res.state === 'stopping') return `${rtCap(rtText(res.note)) || 'Still shutting down'}.`;
  return '';
}

// Any refusal as text, with its status.
function rtErrorText(e) {
  const st = e && Number.isInteger(e.status) ? e.status : 0;
  const msg = rtCap(rtText(e && e.message)) || 'The request failed';
  return st ? `${msg} (${st})` : msg;
}

// The masked log lines of a start, as text: at most 20, each clipped.
const rtLogLines = (v) =>
  Array.isArray(v)
    ? v
        .filter((l) => typeof l === 'string')
        .slice(-20)
        .map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, 300))
    : [];

// Which runtimes go on an existing card's slot and which get a card of their own.
function rtCardPlan(list, slotIds) {
  const slots = new Set(slotIds || []);
  const rows = Array.isArray(list) ? list.filter((r) => r && typeof r.id === 'string') : [];
  return { slots: rows.filter((r) => slots.has(r.id)), own: rows.filter((r) => !slots.has(r.id)) };
}

/* ---------- nodes (text only) ---------- */
function rtEl(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

// Under a card's status line: the server's state, the button and how it runs, then the result and any log lines.
function rtActionRow(doc, r, ui = {}) {
  const box = rtEl(doc, 'div', 'rt-body');
  const row = rtEl(doc, 'div', 'rt-row');
  row.appendChild(rtEl(doc, 'span', 'rt-state', rtStatus(r).text));
  const b = rtButton(r, ui.busy);
  if (b) {
    const btn = rtEl(doc, 'button', `btn ghost mon-sm${b.action === 'stop' ? ' danger' : ''}`, b.label);
    btn.type = 'button';
    btn.disabled = b.disabled;
    btn.setAttribute('data-rt-act', b.action);
    btn.setAttribute('data-rt-id', r.id);
    row.appendChild(btn);
  }
  const how = rtHowNote(r);
  if (how) row.appendChild(rtEl(doc, 'span', 'rt-how', how));
  box.appendChild(row);
  if (!b && r.reason) box.appendChild(rtEl(doc, 'p', 'mon-note off', rtCap(rtText(r.reason))));
  if (ui.msg) {
    const m = rtEl(doc, 'p', `mon-msg rt-msg ${ui.tone || ''}`, ui.msg);
    m.setAttribute('role', 'status');
    box.appendChild(m);
  }
  const lines = rtLogLines(ui.log);
  if (lines.length) box.appendChild(rtEl(doc, 'pre', 'rt-log', lines.join('\n')));
  return box;
}

// A card of its own (llama.cpp, Jan, LocalAI, the owner's runtimes): name, status, description, actions, numbers.
function rtCard(doc, r, ui = {}, iconHtml = '') {
  const card = rtEl(doc, 'div', 'card agent rt-card');
  card.setAttribute('data-rt-card', r.id);
  const top = rtEl(doc, 'div', 'agent-top');
  const ic = rtEl(doc, 'span', `agent-icon chip ${r.preset ? 'green' : 'violet'}`);
  if (iconHtml) ic.innerHTML = iconHtml;
  const names = rtEl(doc, 'div');
  names.appendChild(rtEl(doc, 'div', 'agent-name', rtText(r.name, 60).toUpperCase()));
  names.appendChild(rtEl(doc, 'div', 'agent-role', r.preset ? 'Local models' : 'Your own runtime'));
  top.appendChild(ic);
  top.appendChild(names);
  card.appendChild(top);
  const st = rtStatus(r);
  const status = rtEl(doc, 'div', `status ${st.cls}`);
  status.appendChild(rtEl(doc, 'i'));
  status.appendChild(doc.createTextNode(r.running ? 'Running now' : r.installed ? 'Installed · not running' : 'Not installed'));
  card.appendChild(status);
  card.appendChild(rtEl(doc, 'p', 'agent-desc', r.preset && RT_DESC[r.id] ? RT_DESC[r.id] : RT_OWN_DESC));
  const slot = rtEl(doc, 'div', 'rt-slot');
  slot.appendChild(rtActionRow(doc, r, ui));
  card.appendChild(slot);
  const stats = rtEl(doc, 'div', 'agent-stats');
  for (const [value, label] of [
    [Number.isInteger(r.port) ? String(r.port) : '—', 'port'],
    [r.running && Number.isInteger(r.pid) ? String(r.pid) : '—', 'pid'],
    [r.running ? String(Number.isInteger(r.children) ? r.children : 0) : '—', 'model processes'],
  ]) {
    const cell = rtEl(doc, 'div');
    cell.appendChild(rtEl(doc, 'b', 'num', value));
    cell.appendChild(rtEl(doc, 'span', '', label));
    stats.appendChild(cell);
  }
  card.appendChild(stats);
  return card;
}

/* ---------- browser side ---------- */
// `ui` holds each runtime's busy flag and message by id. No prototype: an id such as `constructor` passes the id
// pattern and must get a slot of its own, not the inherited Object function.
const RT = { list: null, ui: Object.create(null), err: '' };

// fetch with the server's { error, log } and status kept, so a failed start can show its log lines.
async function rtApi(path, body) {
  const opts =
    body === undefined
      ? undefined
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  let r;
  try {
    r = await fetch(path, opts);
  } catch {
    throw Object.assign(new Error('the server did not answer'), { status: 0 });
  }
  if (r.status === 401) {
    location.href = '/login.html';
    throw Object.assign(new Error('signed out'), { status: 401 });
  }
  let j = null;
  try {
    j = await r.json();
  } catch {
    j = null;
  }
  if (!r.ok) {
    const msg = j && typeof j.error === 'string' ? j.error : `the server answered ${r.status}`;
    throw Object.assign(new Error(msg), { status: r.status, log: j && Array.isArray(j.log) ? j.log : [] });
  }
  return j && typeof j === 'object' ? j : {};
}

// AI Office: fill the slots of the existing cards and draw the other runtimes' cards in the same grid.
function rtPaint() {
  const grid = document.querySelector('[data-rt-grid]');
  if (!grid || !Array.isArray(RT.list)) return;
  const active = document.activeElement;
  const focused = active && grid.contains(active) && active.dataset ? active.dataset.rtId : null;
  const slots = new Map([...grid.querySelectorAll('[data-rt-slot]')].map((s) => [s.dataset.rtSlot, s]));
  const plan = rtCardPlan(RT.list, [...slots.keys()]);
  for (const r of plan.slots) slots.get(r.id).replaceChildren(rtActionRow(document, r, RT.ui[r.id]));
  const cards = new Map([...grid.querySelectorAll('[data-rt-card]')].map((c) => [c.dataset.rtCard, c]));
  for (const [id, c] of cards) if (!plan.own.some((r) => r.id === id)) c.remove();
  for (const r of plan.own) {
    const next = rtCard(document, r, RT.ui[r.id], icon('cube', 18));
    if (cards.has(r.id)) cards.get(r.id).replaceWith(next);
    else grid.appendChild(next);
  }
  if (focused)
    for (const b of grid.querySelectorAll('[data-rt-act]'))
      if (b.dataset.rtId === focused) {
        b.focus({ preventScroll: true });
        break;
      }
}

async function rtLoad() {
  try {
    const list = await rtApi('/api/runtimes');
    RT.list = Array.isArray(list) ? list : [];
  } catch {
    return; // keep what is drawn; the next poll tries again
  }
  rtPaint();
}

async function rtAct(id, action) {
  const r = (RT.list || []).find((x) => x.id === id);
  if (!r) return;
  const ui = (RT.ui[id] = RT.ui[id] || {});
  if (ui.busy) return;
  if (action === 'stop' && !confirm(rtConfirmText(r))) return;
  Object.assign(ui, { busy: action, msg: '', tone: '', log: [] });
  rtPaint();
  try {
    const body = action === 'stop' ? { id, pid: r.pid, startTime: r.startTime } : { id };
    const res = await rtApi(`/api/runtimes/${action}`, body);
    const settled = res.state === 'running' || res.state === 'stopped';
    Object.assign(ui, { msg: rtResultText(action, res), tone: settled ? 'good' : 'warn', log: rtLogLines(res.log) });
  } catch (e) {
    Object.assign(ui, { msg: rtErrorText(e), tone: 'bad', log: rtLogLines(e.log) });
  } finally {
    ui.busy = '';
  }
  await rtLoad();
  rtPaint();
}

// Called by the AI Office page when it is drawn; polls while the page is on screen.
function rtMount() {
  if (!document.querySelector('[data-rt-grid]')) return;
  rtPaint();
  rtLoad();
  const timer = setInterval(() => {
    if (document.querySelector('[data-rt-grid]')) rtLoad();
  }, RT_POLL_MS);
  onUnmount(() => clearInterval(timer));
}

/* ---------- Settings → Local models ---------- */
// The Settings form as an entry for /api/runtimes/save, or { error }. The command is one argument per line.
function rtEntryFromForm(f) {
  const v = (k) => String((f && f[k]) || '').trim();
  const id = v('id');
  if (!RT_ID_RE.test(id)) return { error: 'Id: 1 to 40 lowercase letters, digits or dashes.' };
  const command = String((f && f.command) || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!command.length) return { error: 'Command: one argument per line, starting with the program.' };
  const port = Number(v('port'));
  if (!v('port') || !Number.isInteger(port) || port < 1 || port > 65535)
    return { error: 'Port: a whole number from 1 to 65535.' };
  const entry = { id, command, port };
  if (v('name')) entry.name = v('name').slice(0, 60);
  if (v('health')) entry.health = v('health');
  return { entry };
}

// The Settings form filled from an entry for Edit. The health field gets only a URL the owner gave: the default
// (`healthUsed`) is derived from the port, and filling it in would pin it to the old port after a port change.
function rtFormFromEntry(e) {
  return {
    id: e.id,
    name: e.name || '',
    port: Number.isInteger(e.port) ? String(e.port) : '',
    health: typeof e.health === 'string' ? e.health : '',
    command: (e.command || []).join('\n'),
    was: e.id,
  };
}

// One owner entry in Settings: name, command, port, approval and its buttons.
function rtEntryRow(doc, e) {
  const row = rtEl(doc, 'div', 'rt-entry');
  row.setAttribute('data-rt-entry', e.id);
  const main = rtEl(doc, 'div', 'rt-entry-main');
  main.appendChild(rtEl(doc, 'b', '', rtText(e.name, 60) || e.id));
  // The command is null while control is off (server mode, Docker): nothing to show.
  if (Array.isArray(e.command))
    main.appendChild(rtEl(doc, 'code', 'rt-cmd', e.command.join(' ').slice(0, 1000)));
  const port = Number.isInteger(e.port) ? ` · port ${e.port}` : '';
  const health = e.healthUsed || e.health; // the URL that is checked, the default included
  main.appendChild(rtEl(doc, 'small', '', `${rtText(e.id, 40)}${port}${health ? ` · ${rtText(health, 200)}` : ''}`));
  if (e.error) main.appendChild(rtEl(doc, 'p', 'mon-msg bad', rtCap(rtText(e.error))));
  row.appendChild(main);
  const acts = rtEl(doc, 'div', 'mon-acts rt-entry-acts');
  acts.appendChild(rtEl(doc, 'span', `rt-approval ${e.approved ? 'good' : ''}`, e.approved ? 'Approved' : 'Not approved'));
  const btn = (act, label, cls = 'btn ghost mon-sm') => {
    const b = rtEl(doc, 'button', cls, label);
    b.type = 'button';
    b.setAttribute('data-rt-entry-act', act);
    acts.appendChild(b);
  };
  if (!e.approved && !e.error) btn('approve', 'Approve', 'btn mon-sm');
  btn('edit', 'Edit');
  btn('delete', 'Delete', 'btn ghost mon-sm danger');
  row.appendChild(acts);
  return row;
}

function runtimesSettingsShell() {
  return `<section class="card rt-settings" id="rt-settings" aria-labelledby="rt-set-title">
    <div class="card-head"><h3 id="rt-set-title">Local models</h3><span class="meta">your own model servers · Start and Stop in AI Office · stored in config.json</span></div>
    <p class="mon-desc">Ollama, LM Studio, llama.cpp server, Jan and LocalAI need nothing here. Add a server of your own, such as <code>llama-server</code> with a model file, then approve it: ZAAFPulse only starts a command you approved, and asks again after you edit it. The command runs without a shell.</p>
    <p class="mon-note off" id="rt-off" hidden></p>
    <div class="rt-entries" id="rt-entries"><div class="skeleton" style="height:64px"></div></div>
    <form class="rt-form" id="rt-form" novalidate>
      <h4 id="rt-form-title">Add a runtime</h4>
      <fieldset class="rt-fields" id="rt-fields" style="border:0;margin:0;padding:0;min-width:0">
      <div class="rt-form-grid">
        <label>Id<input class="input" name="id" maxlength="40" placeholder="qwen-local" autocomplete="off" spellcheck="false"></label>
        <label>Name<input class="input" name="name" maxlength="60" placeholder="Qwen (llama.cpp)"></label>
        <label>Port<input class="input" name="port" type="number" min="1" max="65535" step="1" placeholder="8081"></label>
        <label>Health URL <small>optional</small><input class="input" name="health" placeholder="http://127.0.0.1:8081/" autocomplete="off" spellcheck="false"></label>
        <label class="rt-wide">Command <small>one argument per line</small><textarea class="input mono" name="command" rows="5" spellcheck="false" placeholder="llama-server&#10;-m&#10;~/models/qwen.gguf&#10;--port&#10;8081"></textarea></label>
      </div>
      <input type="hidden" name="was">
      <div class="mon-acts"><button class="btn mon-sm" type="submit">Save</button><button class="btn ghost mon-sm" type="button" data-rt-cancel hidden>Cancel</button><span class="saved" id="rt-form-msg" role="status"></span></div>
      </fieldset>
    </form></section>`;
}

async function mountRuntimesSettings() {
  const sec = document.getElementById('rt-settings');
  if (!sec) return;
  const form = document.getElementById('rt-form');
  const S = { entries: [], off: null };
  const say = (msg, bad = false) => {
    const out = document.getElementById('rt-form-msg');
    if (!out) return;
    out.textContent = msg;
    out.classList.toggle('bad', bad);
  };
  // While control is off the server refuses every change: show why and keep the form and the buttons disabled.
  const paint = () => {
    const box = document.getElementById('rt-entries');
    if (!box) return;
    const note = document.getElementById('rt-off');
    note.textContent = S.off || '';
    note.hidden = !S.off;
    document.getElementById('rt-fields').disabled = !!S.off;
    if (!S.entries.length) box.replaceChildren(rtEl(document, 'p', 'mon-note off', 'No runtimes of your own yet.'));
    else box.replaceChildren(...S.entries.map((e) => rtEntryRow(document, e)));
    if (S.off) for (const b of box.querySelectorAll('button')) b.disabled = true;
  };
  const take = (res) => {
    S.entries = Array.isArray(res.entries) ? res.entries : [];
    S.off = typeof res.off === 'string' && res.off ? rtText(res.off, 300) : null;
  };
  const reset = () => {
    form.reset();
    form.elements.was.value = '';
    document.getElementById('rt-form-title').textContent = 'Add a runtime';
    sec.querySelector('[data-rt-cancel]').hidden = true;
  };
  const load = async () => {
    try {
      take(await rtApi('/api/runtimes/config'));
    } catch (e) {
      const box = document.getElementById('rt-entries');
      if (box) box.replaceChildren(rtEl(document, 'p', 'mon-msg bad', `Could not read the runtimes: ${rtErrorText(e)}`));
      return;
    }
    paint();
  };
  await load();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (S.off) return;
    const f = form.elements;
    const draft = rtEntryFromForm({
      id: f.id.value,
      name: f.name.value,
      command: f.command.value,
      port: f.port.value,
      health: f.health.value,
    });
    if (draft.error) return say(draft.error, true);
    say('Saving…');
    try {
      // Arguments the owner did not touch are still the masked text the page showed; the server keeps the stored ones.
      const body = { entry: draft.entry, ...(f.was.value ? { was: f.was.value } : {}) };
      take(await rtApi('/api/runtimes/save', body));
      paint();
      reset();
      say('Saved. Approve it before it can start.');
    } catch (e) {
      say(rtErrorText(e), true);
    }
  });

  sec.addEventListener('click', async (ev) => {
    if (S.off) return;
    if (ev.target.closest('[data-rt-cancel]')) return void (reset(), say(''));
    const b = ev.target.closest('[data-rt-entry-act]');
    const row = b && b.closest('[data-rt-entry]');
    if (!row) return;
    const e = S.entries.find((x) => x.id === row.dataset.rtEntry);
    if (!e) return;
    const act = b.dataset.rtEntryAct;
    if (act === 'edit') {
      const f = form.elements;
      for (const [k, v] of Object.entries(rtFormFromEntry(e))) f[k].value = v;
      document.getElementById('rt-form-title').textContent = `Edit ${rtText(e.name, 60) || e.id}`;
      sec.querySelector('[data-rt-cancel]').hidden = false;
      say('');
      f.id.focus();
      return;
    }
    if (act === 'delete' && !confirm(`Delete ${rtText(e.name, 60) || e.id}? Its approval goes too.`)) return;
    if (
      act === 'approve' &&
      !confirm(`Approve this command?\n\n${(e.command || []).join(' ')}\n\nZAAFPulse runs exactly this, without a shell, when you press Start.`)
    )
      return;
    b.disabled = true;
    try {
      if (act === 'delete') {
        take(await rtApi('/api/runtimes/delete', { id: e.id }));
        if (form.elements.was.value === e.id) reset();
      }
      if (act === 'approve') {
        await rtApi('/api/runtimes/approve', { id: e.id });
        await load();
      }
      paint();
      say(act === 'approve' ? `Approved ${rtText(e.name, 60) || e.id}. Start it from AI Office.` : 'Deleted.');
    } catch (err) {
      b.disabled = false;
      say(rtErrorText(err), true);
    }
  });
}

/* ---------- page-wide clicks ---------- */
if (typeof document !== 'undefined')
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-rt-act]');
    if (b && RT_ID_RE.test(b.dataset.rtId || '')) rtAct(b.dataset.rtId, b.dataset.rtAct);
  });

if (typeof module !== 'undefined')
  module.exports = {
    rtStatus,
    rtHowNote,
    rtButton,
    rtConfirmText,
    rtResultText,
    rtErrorText,
    rtLogLines,
    rtCardPlan,
    rtActionRow,
    rtCard,
    rtEntryFromForm,
    rtFormFromEntry,
    rtEntryRow,
    RT,
  };
