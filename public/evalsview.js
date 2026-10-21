'use strict';
/* Local evals on the page: the Evals card on the Quality overview (pass rate per evaluator, a 7-day sparkline,
   judge agreement) and the Evals section in Settings (judge on or off, provider, model, caps, evaluators, the
   preview that confirms an external provider). Server strings go through esc() in templates; reasons, messages
   and the preview text are set with textContent only (S1). */

/* ---------- pure helpers (exported for the tests) ---------- */
const EV_DAY = 86400e3;
const EV_BAND = 'Arize recommends 75–85%';
const EV_DISAGREE = 'Judge and your ratings disagree often: review the judge model or template';
const EV_MIN_PAIRS = 10;
const evP2 = (x) => String(x).padStart(2, '0');
const evDayOf = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${evP2(d.getMonth() + 1)}-${evP2(d.getDate())}`;
};
const evIsObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const evPct = (r) => (Number.isFinite(r) ? `${Math.round(r * 100)}%` : '—');
// A day's rate from a summary day ({ pass, total }) or a plain number; null when nothing ran or it is not a number.
function evRate(d) {
  if (typeof d === 'number') return Number.isFinite(d) ? Math.min(1, Math.max(0, d)) : null;
  if (evIsObj(d) && Number.isFinite(d.total) && d.total > 0 && Number.isFinite(d.pass))
    return Math.min(1, Math.max(0, d.pass / d.total));
  return null;
}

// The SVG points of a pass-rate sparkline, from numbers only. `days` is a list (oldest first) of rates or
// summary days, or the summary's days object (sorted by date). A day with no samples is a gap, not a zero; one
// known day draws a flat line across. The scale follows the series, with at least 20 points of span so small wobbles
// stay small, and every point stays inside the box.
function sparkPoints(days, { width = 84, height = 22, pad = 2 } = {}) {
  const list = Array.isArray(days)
    ? days
    : evIsObj(days)
      ? Object.keys(days)
          .sort()
          .map((k) => days[k])
      : [];
  const rates = list.map(evRate);
  const known = rates.filter((r) => r !== null);
  if (!known.length) return '';
  let lo = Math.min(...known);
  let hi = Math.max(...known);
  if (hi - lo < 0.2) {
    const mid = (hi + lo) / 2;
    lo = Math.max(0, Math.min(mid - 0.1, 0.8));
    hi = Math.min(1, lo + 0.2);
  }
  const y = (r) => +(pad + (1 - (r - lo) / (hi - lo)) * (height - 2 * pad)).toFixed(1);
  if (known.length === 1) return `0,${y(known[0])} ${width},${y(known[0])}`;
  const step = width / (rates.length - 1);
  const pts = [];
  rates.forEach((r, i) => {
    if (r !== null) pts.push(`${+(i * step).toFixed(1)},${y(r)}`);
  });
  return pts.join(' ');
}

// The seven local days up to today (oldest first) as rates, null for a day nothing ran.
function evalWeek(days, now = Date.now()) {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const k = evDayOf(now - i * EV_DAY);
    out.push(evIsObj(days) && Object.hasOwn(days, k) ? evRate(days[k]) : null);
  }
  return out;
}

// The copy for the judge agreement metric. A warning needs enough rated turns to mean something.
function agreementNote(agreement) {
  const a = evIsObj(agreement) ? agreement : {};
  const pairs = Number.isInteger(a.pairs) && a.pairs > 0 ? a.pairs : 0;
  const rate = pairs && Number.isFinite(a.rate) ? Math.min(1, Math.max(0, a.rate)) : null;
  const agree = Number.isInteger(a.agree) ? Math.min(a.agree, pairs) : 0;
  const warn = rate !== null && pairs >= EV_MIN_PAIRS && rate < 0.7 ? EV_DISAGREE : null;
  const few = pairs < EV_MIN_PAIRS ? ` · ${EV_MIN_PAIRS} needed for a fair read` : '';
  return {
    rate: evPct(rate),
    value: rate,
    pairs: pairs
      ? `${agree} of ${pairs} rated turn${pairs === 1 ? '' : 's'} agree${few}`
      : 'No rated turns yet: rate turns Good or Bad in the trace explorer',
    band: EV_BAND,
    warn,
    tone: rate === null ? 'muted' : warn ? 'bad' : rate >= 0.75 ? 'good' : 'mid',
  };
}

// Code and judge evaluators in two groups, in the order of the evaluator list (or the summary's, without it).
function evalGroups(summary, evaluators, now = Date.now()) {
  const sums = summary && evIsObj(summary.evaluators) ? summary.evaluators : {};
  const list = Array.isArray(evaluators)
    ? evaluators.filter((e) => e && typeof e.id === 'string')
    : Object.keys(sums).map((id) => ({ id, kind: sums[id] && sums[id].kind, title: id }));
  const out = { code: [], judge: [] };
  for (const e of list) {
    if (!Object.hasOwn(sums, e.id) || !evIsObj(sums[e.id])) continue;
    const s = sums[e.id];
    const kind = (e.kind || s.kind) === 'code' ? 'code' : 'judge';
    out[kind].push({
      id: e.id,
      title: typeof e.title === 'string' && e.title ? e.title : e.id,
      rate: Number.isFinite(s.rate) ? s.rate : null,
      total: Number.isFinite(s.total) ? s.total : 0,
      week: evalWeek(s.days, now),
    });
  }
  return out;
}

const EV_KIND = { ollama: 'Ollama', lmstudio: 'LM Studio', 'claude-cli': 'Claude Code' };
const EV_CLAUDE = 'claude-code';
// Cents for whole amounts, up to four decimals below a dollar so a few cheap calls do not read as $0.00.
const evMoney = (c) =>
  `$${!Number.isFinite(c) || c <= 0 ? '0.00' : c < 1 ? c.toFixed(4).replace(/0{1,2}$/, '') : c.toFixed(2)}`;
// The Settings status line from /api/evals/status: who judges, or why nothing does, and today's count and cost.
function evalsStatusLine(st) {
  if (!evIsObj(st)) return { text: 'Judge status unavailable', tone: 'muted' };
  const j = evIsObj(st.judge) ? st.judge : {};
  const t = evIsObj(st.today) ? st.today : {};
  const today = `${Number.isFinite(t.count) ? t.count : 0} judged today · ${evMoney(t.cost)}`;
  const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : '');
  if (st.paused === 'judge off') return { text: `Judging is off · ${today}`, tone: 'muted' };
  if (j.waiting) {
    const why = str(j.reason, 160) || 'install or start Ollama, or choose a provider';
    return { text: `Waiting: ${why} · ${today}`, tone: 'warn' };
  }
  if (st.paused === 'daily cap' || st.paused === 'cost cap')
    return { text: `Paused: ${st.paused} reached, resumes tomorrow · ${today}`, tone: 'warn' };
  if (str(st.paused, 60)) return { text: `Paused: ${str(st.paused, 60)} · ${today}`, tone: 'warn' };
  const dest = str(j.destination, 160);
  const who =
    j.kind === 'external'
      ? `External (${str(j.provider, 60) || 'provider'})`
      : j.kind === 'claude-cli' && dest
        ? `Claude Code (to ${dest})`
        : EV_KIND[j.kind] || str(j.kind, 40) || 'Judge';
  return { text: `${who} · ${str(j.model, 120) || 'default model'} · ${today}`, tone: 'good' };
}

// The provider choices: local first, then Claude Code and one entry per gateway provider, each saying where the
// masked text goes. Claude Code also carries whether the server found the CLI.
function evalsProviderOptions(providers) {
  const out = [
    { id: 'auto', label: 'Auto (local first)', external: false },
    { id: 'ollama', label: 'Ollama', external: false },
    { id: 'lmstudio', label: 'LM Studio', external: false },
  ];
  for (const p of Array.isArray(providers) ? providers : []) {
    if (!p || typeof p.id !== 'string' || out.some((o) => o.id === p.id)) continue;
    if (p.kind === 'claude-cli' && p.id === EV_CLAUDE) {
      const label = 'Claude Code (your Claude login) · sends masked text to Anthropic';
      out.push({
        id: p.id,
        label,
        external: true,
        available: p.available === null ? null : p.available === true,
        destination: typeof p.destination === 'string' ? p.destination.slice(0, 160) : null,
        confirm: typeof p.confirm === 'string' ? p.confirm : null,
      });
    } else if (p.kind === 'external') {
      out.push({ id: p.id, label: `External: ${p.id} (sends masked text)`, external: true });
    }
  }
  return out;
}

// The line under the provider choice: what leaves the machine, and for Claude Code whether it was found.
function evalsProviderHint(opt) {
  if (!opt || !opt.external) return 'Nothing leaves this machine. Auto tries Ollama, then LM Studio.';
  if (opt.id === EV_CLAUDE) {
    if (opt.available === null) return 'Checking for Claude Code on this machine…';
    const where = opt.destination || 'Anthropic, through your Claude login';
    return opt.available
      ? `Claude Code found. Masked turn text goes to ${where}. Save it, then preview what will be sent.`
      : 'Claude Code not found on this machine: install it, or set ZAAFPULSE_CLAUDE_BIN. It is looked for again ' +
          'every 5 minutes.';
  }
  return 'Masked turn text goes to this provider. Save it, then preview what will be sent.';
}

// Model names for the datalist: the chosen provider's, or every local one for Auto. Nothing is probed here.
function evalsModelList(providers, provider) {
  const list = Array.isArray(providers) ? providers.filter((p) => p && typeof p.id === 'string') : [];
  const pick = provider === 'auto' ? list.filter((p) => p.kind === 'local') : list.filter((p) => p.id === provider);
  const names = pick.flatMap((p) => (Array.isArray(p.models) ? p.models : [])).filter((m) => typeof m === 'string');
  return [...new Set(names)].slice(0, 200);
}

// Only what changed, for POST /api/evals/settings. A number field that does not parse is sent as typed, so the
// server's own message explains it.
function evalsPatch(cur, next) {
  const c = evIsObj(cur) ? cur : {};
  const n = evIsObj(next) ? next : {};
  const patch = {};
  const asNum = (v) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
  if (typeof n.judge === 'boolean' && n.judge !== c.judge) patch.judge = n.judge;
  if (typeof n.provider === 'string' && n.provider !== c.provider) patch.provider = n.provider;
  if (typeof n.model === 'string' && n.model.trim() !== (c.model || '')) patch.model = n.model.trim();
  for (const k of ['dailyCap', 'costCapUSD']) {
    if (n[k] === undefined) continue;
    const v = asNum(n[k]);
    if (v !== c[k]) patch[k] = v;
  }
  if (evIsObj(n.evaluators)) {
    const was = evIsObj(c.evaluators) ? c.evaluators : {};
    const ev = {};
    for (const [id, on] of Object.entries(n.evaluators)) if (typeof on === 'boolean' && on !== was[id]) ev[id] = on;
    if (Object.keys(ev).length) patch.evaluators = ev;
  }
  return patch;
}

// Where the saved provider stands: a local one needs nothing, an external one needs its preview first. Claude Code
// is confirmed for one destination (its `confirm` token); a confirmation of another one reads "changed".
function evalsConfirm(settings, providers) {
  const s = evIsObj(settings) ? settings : {};
  const list = Array.isArray(providers) ? providers : [];
  const p = list.find((x) => x && (x.kind === 'external' || x.external === true) && x.id === s.provider);
  if (!p) return 'local';
  const done = typeof s.externalConfirmed === 'string' ? s.externalConfirmed : '';
  if (p.kind === 'claude-cli') {
    if (p.confirm && done === p.confirm) return 'confirmed';
    return done.startsWith(`${p.id}@`) ? 'changed' : 'unconfirmed';
  }
  return done === s.provider ? 'confirmed' : 'unconfirmed';
}

// The newest Claude or Codex session (the list is newest first): the ones whose turns the judge reads.
function previewKey(res) {
  const rows = res && Array.isArray(res.sessions) ? res.sessions : [];
  const r = rows.find((x) => x && typeof x.key === 'string' && (x.source === 'claude' || x.source === 'codex'));
  return r ? r.key : null;
}

function previewError(err) {
  if (err && err.status === 403) return 'Turn on content viewing (ZAAFPULSE_CONTENT=on) to preview';
  const m = err && typeof err.message === 'string' ? err.message.trim() : '';
  return m ? m.slice(0, 200) : 'Could not build the preview';
}

/* ---------- Quality overview: the Evals card ---------- */
let evCardCache = null; // the last summary, status and evaluators, so a background repaint does not flash
let evCardReq = 0; // only the newest read paints: a range switch can overtake a slow one
const evRange = () => {
  const n = Number(typeof state !== 'undefined' ? state.range : 7);
  return Number.isFinite(n) && n > 0 ? Math.min(30, n) : 30;
};
const evTone = (r) => (r === null ? 'muted' : r >= 0.9 ? 'good' : r >= 0.7 ? 'mid' : 'bad');

function evSpark(week, kind) {
  const pts = sparkPoints(week);
  if (!pts)
    return '<svg class="ev-spark" viewBox="0 0 84 22" aria-hidden="true"><line x1="0" x2="84" y1="20" y2="20" class="ev-spark-none"/></svg>';
  const last = pts.split(' ').pop().split(',');
  return `<svg class="ev-spark ${kind}" viewBox="0 0 84 22" aria-hidden="true"><polyline points="${pts}"/><circle cx="${+last[0]}" cy="${+last[1]}" r="2.2"/></svg>`;
}
function evRows(rows, kind) {
  if (!rows.length) return '<li class="ev-empty">None in this range.</li>';
  return rows
    .map(
      (r, i) =>
        `<li class="ev-row" style="--i:${i}"><span class="ev-name" title="${esc(r.title)}">${esc(r.title)}</span>${evSpark(r.week, kind)}<b class="ev-rate num ${evTone(r.rate)}">${evPct(r.rate)}</b><small class="ev-n num" title="samples in the range">${r.total ? fmtN(r.total) : '—'}</small></li>`,
    )
    .join('');
}

// The card's frame. Filled by mountEvalsCard; painted at once from the last read when there is one.
function evalsCardShell() {
  return `<section class="card ev-card" id="ev-card" aria-labelledby="ev-card-title">
    <div class="card-head"><h3 id="ev-card-title">Evals</h3><span class="meta" id="ev-card-meta">pass rate · last 7 days · samples</span><span class="right"><a class="link" href="#trace">Trace explorer →</a></span></div>
    <div class="ev-wait" id="ev-wait" role="status" hidden><span id="ev-wait-msg"></span><a href="#settings">Settings → Evals</a></div>
    <div id="ev-card-body">${evCardCache ? '' : '<div class="skeleton" style="height:150px"></div>'}</div></section>`;
}

function paintEvalsCard(data) {
  const body = $('#ev-card-body');
  if (!body) return;
  const groups = evalGroups(data.summary, data.evaluators);
  const a = agreementNote(data.summary && data.summary.agreement);
  const judgeOf = data.status && evIsObj(data.status.judge) && !data.status.judge.waiting ? data.status.judge : null;
  const judgeMeta = judgeOf && judgeOf.model ? esc(judgeOf.model) : 'model judge';
  const mark = a.value === null ? '' : `<i class="ev-mark ${a.tone}" style="left:${(a.value * 100).toFixed(1)}%"></i>`;
  body.innerHTML = `<div class="ev-grid">
      <div class="ev-group"><div class="ev-ghead"><b>Code checks</b><small>every turn, no model</small></div>
        <div class="ev-cols-head" aria-hidden="true"><span></span><span>7 days</span><span>pass</span><span>n</span></div>
        <ul class="ev-list">${evRows(groups.code, 'code')}</ul></div>
      <div class="ev-group"><div class="ev-ghead"><b>Judge</b><small>${judgeMeta}</small></div>
        <div class="ev-cols-head" aria-hidden="true"><span></span><span>7 days</span><span>pass</span><span>n</span></div>
        <ul class="ev-list">${evRows(groups.judge, 'judge')}</ul></div>
      <div class="ev-agree ${a.tone}">
        <div class="ev-agree-a"><div class="holo-kicker">JUDGE AGREEMENT</div>
          <div class="ev-agree-num"><b class="num" id="ev-agree-rate"></b><small>with your Good / Bad ratings</small></div></div>
        <div class="ev-agree-b" aria-hidden="true"><div class="ev-bandbar"><i class="ev-band"></i>${mark}</div>
          <div class="ev-bandkey"><span>0</span><span>75</span><span>85</span><span>100</span></div></div>
        <div class="ev-agree-c"><small id="ev-agree-pairs"></small><small id="ev-agree-band"></small></div>
        <div class="ev-agree-alert" id="ev-agree-alert" hidden></div>
      </div></div>`;
  $('#ev-agree-rate').textContent = a.rate;
  $('#ev-agree-pairs').textContent = a.pairs;
  $('#ev-agree-band').textContent = a.band;
  const w = $('#ev-agree-alert');
  w.hidden = !a.warn;
  w.textContent = a.warn || '';
  const meta = $('#ev-card-meta');
  if (meta) {
    meta.textContent = `pass rate in the last ${data.range} day${data.range === 1 ? '' : 's'} · 7-day trend · samples`;
  }
  // The same short line as the trace explorer's banner when nothing would judge now.
  const b = typeof trJudgeBanner === 'function' ? trJudgeBanner(data.status) : null;
  $('#ev-wait').hidden = !b;
  $('#ev-wait-msg').textContent = b ? b.text : '';
}

async function mountEvalsCard() {
  if (!$('#ev-card')) return;
  if (evCardCache) paintEvalsCard(evCardCache);
  const range = evRange();
  const my = ++evCardReq;
  try {
    const [summary, status, list] = await Promise.all([
      trApi(`/api/evals/summary?range=${range}`),
      trApi('/api/evals/status').catch(() => null),
      evCardCache && evCardCache.evaluators
        ? Promise.resolve({ evaluators: evCardCache.evaluators })
        : trApi('/api/evals/evaluators').catch(() => null),
    ]);
    if (my !== evCardReq) return;
    evCardCache = { summary, status, evaluators: (list && list.evaluators) || null, range };
    paintEvalsCard(evCardCache);
  } catch (e) {
    const body = $('#ev-card-body');
    if (!body || evCardCache || my !== evCardReq) return;
    body.innerHTML = '<div class="empty" id="ev-card-err"></div>';
    $('#ev-card-err').textContent = `Could not read the evals: ${e.message}`;
  }
}

/* ---------- Settings → Evals ---------- */
function evalsSettingsShell() {
  return `<section class="card ev-settings" id="ev-settings" aria-labelledby="ev-set-title">
    <div class="card-head"><h3 id="ev-set-title">Evals</h3><span class="meta">a model grades finished turns · local first · stored in config.json</span></div>
    <div class="ev-status muted" id="ev-status" role="status"><i aria-hidden="true"></i><span id="ev-status-msg">Reading the judge status…</span></div>
    <form class="ev-form" id="ev-form" novalidate><div class="skeleton" style="height:180px"></div></form></section>`;
}

function evalsFormHtml(cur, evaluators) {
  const opts = evalsProviderOptions(cur.providers);
  if (!opts.some((o) => o.id === cur.provider)) opts.push({ id: cur.provider, label: cur.provider, external: true });
  const judges = (Array.isArray(evaluators) ? evaluators : []).filter((e) => e && e.kind === 'judge');
  const codes = (Array.isArray(evaluators) ? evaluators : []).filter((e) => e && e.kind === 'code');
  const on = evIsObj(cur.evaluators) ? cur.evaluators : {};
  const checks = judges.length
    ? judges
        .map(
          (e) =>
            `<label class="ev-check"><input type="checkbox" name="ev" value="${esc(e.id)}" ${on[e.id] !== false ? 'checked' : ''}><span><b>${esc(e.title || e.id)}</b><small>${esc((e.labels || []).join(' / '))}${e.scope === 'session' ? ' · whole session' : ''}</small></span></label>`,
        )
        .join('')
    : Object.keys(on)
        .map(
          (id) =>
            `<label class="ev-check"><input type="checkbox" name="ev" value="${esc(id)}" ${on[id] !== false ? 'checked' : ''}><span><b>${esc(id)}</b></span></label>`,
        )
        .join('');
  return `<div class="ev-set-grid">
      <div class="ev-set-col">
        <label class="ie-switch ev-switch"><input type="checkbox" name="judge" ${cur.judge ? 'checked' : ''}><span></span>Judge finished turns</label>
        <label>Provider<select class="input" name="provider">${opts.map((o) => `<option value="${esc(o.id)}" ${o.id === cur.provider ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
          <small id="ev-prov-hint"></small></label>
        <label>Model<input class="input" name="model" list="ev-models" maxlength="200" autocomplete="off" spellcheck="false" value="${esc(cur.model)}" placeholder="Empty = the first model the provider has">
          <datalist id="ev-models"></datalist></label>
        <div class="ev-caps">
          <label>Daily cap<input class="input" name="dailyCap" type="number" min="1" max="10000" step="1" value="${esc(cur.dailyCap)}"><small>judgments per day</small></label>
          <label>Cost cap<input class="input" name="costCapUSD" type="number" min="0" max="100" step="0.01" value="${esc(cur.costCapUSD)}"><small>USD per day, external only</small></label>
        </div>
      </div>
      <fieldset class="ev-set-col ev-evs"><legend>Judge evaluators</legend>${checks}
        ${codes.length ? `<p class="ev-codes">Code checks always run: ${codes.map((e) => esc(e.title || e.id)).join(', ')}.</p>` : ''}</fieldset>
    </div>
    <div class="ev-ext" id="ev-ext" hidden>
      <div class="ev-confirm"><span class="ev-confirm-dot" aria-hidden="true"></span><b id="ev-confirm-msg"></b>
        <button type="button" class="btn ghost" id="ev-preview-btn">Preview what will be sent</button></div>
      <div class="ev-pre-err" id="ev-pre-err" role="status" hidden></div>
      <div class="ev-preview" id="ev-preview" hidden>
        <div class="ev-pre-head" id="ev-pre-dest-row" hidden>Sent to <small id="ev-pre-dest"></small></div>
        <div class="ev-pre-head">System <small>as the provider receives it</small></div><pre class="ev-pre" id="ev-pre-system" tabindex="0"></pre>
        <div class="ev-pre-head">User <small>masked turn text</small></div><pre class="ev-pre" id="ev-pre-user" tabindex="0"></pre>
      </div>
    </div>
    <div class="ev-actions"><button class="btn" type="submit">Save</button><span class="saved" id="ev-saved" role="status"></span></div>`;
}

async function mountEvalsSettings() {
  const form = $('#ev-form');
  if (!form) return;
  const S = { cur: null, evaluators: null };
  const statusMsg = $('#ev-status-msg');
  const refreshStatus = () =>
    trApi('/api/evals/status')
      .then((st) => {
        const line = evalsStatusLine(st);
        const box = $('#ev-status');
        if (!box) return;
        box.className = `ev-status ${line.tone}`;
        statusMsg.textContent = line.text;
      })
      .catch((e) => {
        if (statusMsg.isConnected) statusMsg.textContent = `Judge status unavailable: ${e.message}`;
      });
  refreshStatus();
  try {
    const [cur, list] = await Promise.all([
      trApi('/api/evals/settings'),
      trApi('/api/evals/evaluators').catch(() => null),
    ]);
    S.cur = cur;
    S.evaluators = (list && list.evaluators) || null;
  } catch (e) {
    form.innerHTML = '<div class="empty" id="ev-form-err"></div>';
    $('#ev-form-err').textContent = `Could not read the eval settings: ${e.message}`;
    return;
  }
  if (!form.isConnected) return;
  form.innerHTML = evalsFormHtml(S.cur, S.evaluators);
  const saved = $('#ev-saved');
  const say = (msg, bad = false) => {
    saved.textContent = msg;
    saved.classList.toggle('bad', bad);
  };

  // The models the server listed for the chosen provider; nothing is asked of Ollama from here.
  function paintModels() {
    const dl = $('#ev-models');
    dl.replaceChildren(
      ...evalsModelList(S.cur.providers, form.provider.value).map((m) => {
        const o = document.createElement('option');
        o.value = m;
        return o;
      }),
    );
  }
  // The external part: a provider picked but not saved yet, saved but not confirmed, or confirmed.
  function paintExternal() {
    const picked = form.provider.value;
    const ext = evalsProviderOptions(S.cur.providers).find((o) => o.id === picked);
    const isExt = !!(ext && ext.external);
    const hint = $('#ev-prov-hint');
    hint.textContent = evalsProviderHint(ext);
    // A gateway judge has no default model: the gateway needs one of the provider's own names. Claude Code has its
    // own default, and a small model spends less of the owner's limits.
    form.model.placeholder =
      picked === EV_CLAUDE
        ? "Empty = Claude Code's default; haiku saves your limits"
        : isExt
          ? "Required: one of the provider's models"
          : 'Empty = the first model the provider has';
    const box = $('#ev-ext');
    box.hidden = !isExt;
    if (!isExt) return;
    const btn = $('#ev-preview-btn');
    const msg = $('#ev-confirm-msg');
    const unsaved = picked !== S.cur.provider;
    const st = unsaved ? 'unsaved' : evalsConfirm(S.cur, S.cur.providers);
    box.dataset.state = st;
    msg.textContent =
      st === 'unsaved'
        ? 'Save this provider first, then preview what will be sent'
        : st === 'confirmed'
          ? 'Confirmed: masked text may go to this provider'
          : st === 'changed'
            ? 'The Claude Code destination changed; preview again'
            : 'Not confirmed: preview what will be sent';
    btn.disabled = unsaved;
    btn.textContent = st === 'confirmed' ? 'Preview again' : 'Preview what will be sent';
  }
  paintModels();
  paintExternal();
  form.provider.onchange = () => {
    paintModels();
    $('#ev-preview').hidden = true;
    $('#ev-pre-err').hidden = true;
    paintExternal();
  };

  $('#ev-preview-btn').onclick = async () => {
    const btn = $('#ev-preview-btn');
    const err = $('#ev-pre-err');
    const provider = S.cur.provider;
    btn.disabled = true;
    err.hidden = true;
    say('');
    try {
      const sessions = await trApi('/api/trace/sessions?range=30');
      const key = previewKey(sessions);
      if (!key) {
        throw Object.assign(new Error('No Claude or Codex session in the last 30 days to preview'), { status: 400 });
      }
      const r = await trApi('/api/evals/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, provider }),
      });
      if (!form.isConnected) return;
      $('#ev-pre-system').textContent = typeof r.system === 'string' ? r.system : '';
      $('#ev-pre-user').textContent = typeof r.user === 'string' ? r.user : '';
      // Claude Code says where the text goes; shown as text, like the rest of the preview.
      const dest = typeof r.destination === 'string' ? r.destination : '';
      $('#ev-pre-dest').textContent = dest;
      $('#ev-pre-dest-row').hidden = !dest;
      $('#ev-preview').hidden = false;
      const opt = evalsProviderOptions(S.cur.providers).find((o) => o.id === provider);
      S.cur = { ...S.cur, externalConfirmed: (opt && opt.confirm) || provider };
      refreshStatus();
    } catch (e) {
      if (!form.isConnected) return;
      err.textContent = previewError(e);
      err.hidden = false;
    } finally {
      if (form.isConnected) {
        btn.disabled = false;
        paintExternal();
      }
    }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const evaluators = {};
    for (const c of form.querySelectorAll('input[name=ev]')) evaluators[c.value] = c.checked;
    const patch = evalsPatch(S.cur, {
      judge: form.judge.checked,
      provider: form.provider.value,
      model: form.model.value,
      dailyCap: form.dailyCap.value,
      costCapUSD: form.costCapUSD.value,
      evaluators,
    });
    if (!Object.keys(patch).length) return say('No changes');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    say('Saving…');
    try {
      const next = await trApi('/api/evals/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!form.isConnected) return;
      S.cur = next;
      if (patch.provider !== undefined) {
        $('#ev-preview').hidden = true;
        $('#ev-pre-err').hidden = true;
      }
      say('Saved');
      paintModels();
      paintExternal();
      refreshStatus();
    } catch (err) {
      if (form.isConnected) say(err.message || 'Could not save', true);
    } finally {
      btn.disabled = false;
    }
  };
}

if (typeof module !== 'undefined')
  module.exports = {
    sparkPoints,
    evalWeek,
    agreementNote,
    evalGroups,
    evalsStatusLine,
    evalsProviderOptions,
    evalsModelList,
    evalsPatch,
    evalsConfirm,
    evalsProviderHint,
    previewKey,
    previewError,
  };
