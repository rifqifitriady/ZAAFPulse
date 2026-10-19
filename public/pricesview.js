'use strict';
/* Settings → Model prices: live provider prices (OpenRouter's public list) shown as model cards with
   your usage, plus pinning your own price for any model and adding prefixes the list does not have. */

const VENDOR = {
  anthropic: ['Anthropic', '#d4a27f', 'A'],
  openai: ['OpenAI', '#5cf0a8', 'O'],
  google: ['Google', '#5b8cff', 'G'],
  deepseek: ['DeepSeek', '#4d8bff', 'D'],
  alibaba: ['Alibaba', '#ff8a3d', 'Q'],
  xai: ['xAI', '#e6ebff', 'X'],
  meta: ['Meta', '#3ea6ff', 'M'],
  tencent: ['Tencent', '#2fd3a0', 'T'],
  zai: ['Z.ai', '#b06cff', 'Z'],
  other: ['Custom', '#8f98cc', '#'],
};
const VENDOR_ORDER = ['anthropic', 'openai', 'google', 'deepseek', 'alibaba', 'xai', 'meta', 'tencent', 'zai'];
const pv2 = { data: null, q: '', vendor: 'all', showCatalog: false, editing: null, busy: '', sort: null, basis: null }; // sort/basis read lazily: store lives in app.js, loaded later
// What "price" means when sorting: input and output per 1M summed, or one rate.
const BASES = [
  ['blend', 'Input + output'],
  ['input', 'Input'],
  ['output', 'Output'],
  ['cacheRead', 'Cache read'],
];
const SORTS = [
  ['default', 'Default'],
  ['desc', 'Highest price'],
  ['asc', 'Lowest price'],
];
const priceOf = (p, basis) => (!p ? 0 : basis === 'blend' ? (p.input || 0) + (p.output || 0) : p[basis] || 0);
const priceFields = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['cacheRead', 'Cache read'],
  ['cacheWrite5m', 'Cache write 5m'],
  ['cacheWrite1h', 'Cache write 1h'],
];
const money = (v) => (v == null ? '—' : `$${v >= 1 || v === 0 ? +v.toFixed(2) : +v.toPrecision(3)}`);
const vendorOf = (key, cat) =>
  cat
    ? cat.vendor
    : /^claude|^opus|^sonnet|^haiku/.test(key)
      ? 'anthropic'
      : /^gpt|^o\d|^codex/.test(key)
        ? 'openai'
        : /^gemini|^gemma/.test(key)
          ? 'google'
          : /^deepseek/.test(key)
            ? 'deepseek'
            : /^qwen/.test(key)
              ? 'alibaba'
              : /^grok/.test(key)
                ? 'xai'
                : /^llama/.test(key)
                  ? 'meta'
                  : /^hunyuan/.test(key)
                    ? 'tencent'
                    : /^glm/.test(key)
                      ? 'zai'
                      : 'other';

async function loadPrices() {
  pv2.data = await api('/api/prices');
  paintPrices();
}

// Usage per price key: each model in the range goes to its longest matching key, like the cost math.
function usageByKey(keys) {
  const sorted = [...keys].sort((a, b) => b.length - a.length);
  const by = {};
  for (const m of (state.data && state.data.models) || []) {
    const k = sorted.find((p) => m.model.startsWith(p));
    if (!k) continue;
    const u = (by[k] ||= { calls: 0, tokens: 0, cost: 0, models: new Set(), tools: new Set() });
    u.calls += m.calls;
    u.tokens += m.tokens;
    u.cost += m.cost;
    u.models.add(m.model);
    u.tools.add(m.tool);
  }
  return by;
}

function priceCard(key, d, usage, totalCost) {
  const cat = d.catalog.find((m) => m.key === key);
  const vend = vendorOf(key, cat);
  const [vName, vColor, mono] = VENDOR[vend] || VENDOR.other;
  const p = d.effective[key] || (cat && cat.price) || {};
  const src = d.source[key] || (cat ? 'live' : 'default');
  const pinned = d.sync.pinned.includes(key) && key in d.manual;
  const u = usage[key];
  const share = u && totalCost ? u.cost / totalCost : 0;
  const editing = pv2.editing === key;
  const label =
    src === 'live'
      ? `<span class="pc-src live">Live pricing · OpenRouter</span>`
      : src === 'manual'
        ? `<span class="pc-src manual">${pinned ? 'Your price · pinned' : 'Your price'}</span>`
        : `<span class="pc-src builtin">Built-in price</span>`;
  const tags =
    cat && cat.tags.length
      ? `<div class="pc-kv"><span>Tags</span><b>${esc(cat.tags.slice(0, 2).join(', '))}${cat.tags.length > 2 ? ` <i>+${cat.tags.length - 2}</i>` : ''}</b></div>`
      : '';
  const prices = editing
    ? `<div class="pc-edit-grid">${priceFields.map(([f, l]) => `<label><span>${l}</span><input class="input num" type="number" min="0" step="0.001" name="pe-${f}" value="${p[f] ?? 0}"></label>`).join('')}</div>`
    : `<div class="pc-prices">${priceFields
        .slice(0, 3)
        .map(
          ([f, l]) =>
            `<div><span>${l}</span><em class="pc-line"><b class="num">${money(p[f])}</b><small> / 1M</small></em></div>`,
        )
        .join('')}</div>
       <div class="pc-meta"><div class="pc-kv"><span>Cache write</span><b class="num">${money(p.cacheWrite5m)}<i> · 1h ${money(p.cacheWrite1h)}</i></b></div><div class="pc-kv"><span>Context</span><b>${cat && cat.context ? fmtN(cat.context) : '—'}</b></div></div>`;
  const bars = Array.from(
    { length: 20 },
    (_, i) => `<i class="${i < Math.round(share * 20) || (share > 0 && i === 0) ? 'on' : ''}"></i>`,
  ).join('');
  return `<article class="pcard${editing ? ' editing' : ''}" style="--v:${vColor}" data-pkey="${esc(key)}">
    <div class="pc-head"><span class="pc-logo">${mono}</span><div class="pc-title"><b>${esc(key)}</b><small>${esc(cat ? cat.name : vName)} · ${esc(vName)}</small></div>
      <button class="icon-btn pc-copy" type="button" data-pcopy="${esc(key)}" title="Copy model key" aria-label="Copy ${esc(key)}">${icon('layers', 14)}</button></div>
    <p class="pc-desc">${cat && cat.description ? esc(cat.description) : 'No description available.'}</p>
    ${tags}${label}${prices}
    <div class="pc-foot">
      <div class="pc-share"><div class="pc-kv"><span>Spend share</span><b class="num">${pct(share)}</b></div><div class="pc-bars">${bars}</div></div>
      <div class="pc-stat"><span>Calls</span><b class="num">${u ? fmtN(u.calls) : '0'}</b></div>
      <div class="pc-stat"><span>Cost</span><b class="num">${u ? fmtUSD(u.cost) : '$0'}</b></div>
      ${
        editing
          ? `<div class="pc-actions"><button class="btn" type="button" data-psave="${esc(key)}">Save &amp; pin</button>${src === 'manual' && cat ? `<button class="btn ghost" type="button" data-punpin="${esc(key)}">Use live price</button>` : ''}${!cat && key in d.manual ? `<button class="btn ghost danger" type="button" data-premove="${esc(key)}">Remove</button>` : ''}<button class="btn ghost" type="button" data-pcancel>Cancel</button></div>`
          : `<button class="pc-details" type="button" data-pedit="${esc(key)}">Edit <span aria-hidden="true">›</span></button>`
      }
    </div></article>`;
}

function paintPrices() {
  const el = $('#prices-panel');
  const d = pv2.data;
  if (!el || !d) return;
  if (pv2.sort === null) {
    pv2.sort = store.get('priceSort', 'default');
    pv2.basis = store.get('priceBasis', 'blend');
  }
  const keys = new Set([...Object.keys(d.effective)]);
  const usage = usageByKey(keys);
  const totalCost = Object.values(usage).reduce((a, u) => a + u.cost, 0);
  const q = pv2.q.toLowerCase();
  const match = (k) => {
    const cat = d.catalog.find((m) => m.key === k);
    return (
      (pv2.vendor === 'all' || vendorOf(k, cat) === pv2.vendor) &&
      (!q || `${k} ${cat ? `${cat.name} ${cat.description}` : ''}`.toLowerCase().includes(q))
    );
  };
  const inUse = [...keys]
    .filter((k) => usage[k])
    .sort((a, b) => usage[b].cost - usage[a].cost || usage[b].calls - usage[a].calls);
  const yours = Object.keys(d.manual).filter((k) => !usage[k]);
  const catalog = d.catalog.map((m) => m.key).filter((k) => !usage[k] && !(k in d.manual));
  const st = d.status;
  const section = (title, meta, list) =>
    list.length
      ? `<div class="pc-section"><h4>${title}</h4><span class="meta">${meta}</span></div><div class="pc-grid">${list.map((k) => priceCard(k, d, usage, totalCost)).join('')}</div>`
      : '';
  // Sort by price when asked; ties keep the default order (cost for In use, list order otherwise).
  const priceFor = (k) => priceOf(d.effective[k] || (d.catalog.find((m) => m.key === k) || {}).price, pv2.basis);
  const sorted = (list) =>
    pv2.sort === 'default'
      ? list
      : [...list].sort((a, b) => (pv2.sort === 'desc' ? priceFor(b) - priceFor(a) : priceFor(a) - priceFor(b)));
  const shownCatalog = sorted(catalog.filter(match));
  const unpriced = (state.data ? state.data.unpriced : []) || [];
  el.innerHTML = `<div class="panel-head pc-toolbar"><h3>Model prices</h3><span class="meta">USD per 1M tokens · your own prices are kept in config.json</span>
      <div class="pc-sync">
        <span class="pill live-pill">${d.sync.enabled ? `<i class="live-dot"></i>${st.fetchedAt ? `Live · updated ${ago(st.fetchedAt)} · ${st.models} models` : 'Live · not fetched yet'}` : 'Auto-update off'}${st.error ? ` · <span class="pc-err">last try failed: ${esc(st.error)}</span>` : ''}</span>
        <label class="ie-switch"><input type="checkbox" data-psync ${d.sync.enabled ? 'checked' : ''} ${d.demo ? 'disabled' : ''}><span></span>Auto-update</label>
        <button class="btn ghost" type="button" data-prefresh ${pv2.busy || d.demo ? 'disabled' : ''}>${pv2.busy === 'refresh' ? 'Refreshing…' : 'Refresh now'}</button>
        <button class="btn" type="button" data-padd>+ Add model</button></div>
      <div class="pc-vendors" role="group" aria-label="Filter by vendor">${['all', ...VENDOR_ORDER]
        .map((v) => {
          const n =
            v === 'all'
              ? keys.size + catalog.length - [...keys].filter((k) => catalog.includes(k)).length
              : [...new Set([...keys, ...catalog])].filter(
                  (k) =>
                    vendorOf(
                      k,
                      d.catalog.find((m) => m.key === k),
                    ) === v,
                ).length;
          return `<button class="pc-vendor" type="button" data-pvendor="${v}" aria-pressed="${pv2.vendor === v}" ${v !== 'all' && !n ? 'disabled' : ''} style="--v:${v === 'all' ? 'var(--h-cyan)' : VENDOR[v][1]}">${v === 'all' ? '' : `<i>${VENDOR[v][2]}</i>`}${v === 'all' ? 'All vendors' : VENDOR[v][0]}<b>${n}</b></button>`;
        })
        .join('')}</div></div>
    <p class="kpi-sub pc-note">Prices come from OpenRouter's public model list, which carries each provider's list price; it is fetched every 12 hours with one request that sends no data from this machine. A model you edit is pinned to your price. ${unpriced.length ? `<b>Still unpriced:</b> ${unpriced.map(esc).join(', ')}.` : 'Every model you used has a price.'}</p>
    ${
      pv2.editing === '__new'
        ? `<div class="pc-grid"><article class="pcard editing" style="--v:#8f98cc"><div class="pc-head"><span class="pc-logo">#</span><div class="pc-title"><b>New model prefix</b><small>Prices any model whose name starts with it</small></div></div>
      <label class="pc-newkey"><span>Model prefix</span><input class="input" name="pe-key" placeholder="e.g. gpt-6 or claude-opus-6" autocomplete="off"></label>
      <div class="pc-edit-grid">${priceFields.map(([f, l]) => `<label><span>${l}</span><input class="input num" type="number" min="0" step="0.001" name="pe-${f}" value="0"></label>`).join('')}</div>
      <div class="pc-foot"><div class="pc-actions"><button class="btn" type="button" data-psave="__new">Add &amp; pin</button><button class="btn ghost" type="button" data-pcancel>Cancel</button></div></div></article></div>`
        : ''
    }
    <div class="pc-sortbar"><span class="pc-sortlabel">Sort</span>
      <div class="segmented" role="group" aria-label="Sort by price">${SORTS.map(([v, l]) => `<button type="button" data-psort="${v}" aria-pressed="${pv2.sort === v}">${v === 'desc' ? '↓ ' : v === 'asc' ? '↑ ' : ''}${l}</button>`).join('')}</div>
      <label class="pc-basis">by <select class="input" data-pbasis ${pv2.sort === 'default' ? 'disabled' : ''}>${BASES.map(([v, l]) => `<option value="${v}" ${pv2.basis === v ? 'selected' : ''}>${l}</option>`).join('')}</select> per 1M</label></div>
    ${section('In use', pv2.sort === 'default' ? `${rangeText()} · by estimated cost` : `${rangeText()} · ${pv2.sort === 'desc' ? 'highest' : 'lowest'} price first`, sorted(inUse.filter(match)))}
    ${section('Your prices', 'pinned or custom prefixes without usage', sorted(yours.filter(match)))}
    <div class="pc-section"><h4>Catalog</h4><span class="meta">${catalog.length} live models from ${VENDOR_ORDER.length} vendors${pv2.vendor !== 'all' ? ` · showing ${VENDOR[pv2.vendor][0]}` : ''}</span>
      <div class="filters pc-filters"><label class="search sq-search">${icon('search', 14)}<input id="pc-q" type="search" placeholder="Find a model…" value="${esc(pv2.q)}" autocomplete="off"></label>
        <button class="btn ghost" type="button" data-pcatalog>${pv2.showCatalog || q ? 'Hide catalog' : `Show ${shownCatalog.length} models`}</button></div></div>
    ${pv2.showCatalog || q ? `<div class="pc-grid">${shownCatalog.map((k) => priceCard(k, d, usage, totalCost)).join('') || holoEmpty('No model matches.')}</div>` : ''}`;
}

async function pricesAction(body) {
  pv2.busy = body.action;
  paintPrices();
  try {
    const r = await api('/api/prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.error) alert(r.error);
    pv2.editing = null;
    await loadSummary(); // costs everywhere use the new prices
    pv2.data = await api('/api/prices');
  } catch (err) {
    alert(err.message);
  }
  pv2.busy = '';
  paintPrices();
}

document.addEventListener('click', (e) => {
  if (state.route !== 'settings' || !$('#prices-panel')) return;
  const t = (sel) => e.target.closest(sel);
  if (t('[data-prefresh]')) {
    pricesAction({ action: 'refresh' });
    return;
  }
  if (t('[data-padd]')) {
    pv2.editing = '__new';
    paintPrices();
    $('[name="pe-key"]')?.focus();
    return;
  }
  if (t('[data-pcatalog]')) {
    pv2.showCatalog = !(pv2.showCatalog || pv2.q);
    pv2.q = pv2.showCatalog ? pv2.q : '';
    paintPrices();
    return;
  }
  const v = t('[data-pvendor]');
  if (v) {
    pv2.vendor = v.dataset.pvendor;
    pv2.showCatalog = pv2.vendor !== 'all';
    paintPrices();
    return;
  }
  const c = t('[data-pcopy]');
  if (c) {
    navigator.clipboard?.writeText(c.dataset.pcopy);
    c.classList.add('copied');
    setTimeout(() => c.classList.remove('copied'), 900);
    return;
  }
  const so = t('[data-psort]');
  if (so) {
    pv2.sort = so.dataset.psort;
    store.set('priceSort', pv2.sort);
    paintPrices();
    return;
  }
  const ed = t('[data-pedit]');
  if (ed) {
    pv2.editing = ed.dataset.pedit;
    paintPrices();
    return;
  }
  if (t('[data-pcancel]')) {
    pv2.editing = null;
    paintPrices();
    return;
  }
  const un = t('[data-punpin]');
  if (un) {
    pricesAction({ action: 'unpin', key: un.dataset.punpin });
    return;
  }
  const rm = t('[data-premove]');
  if (rm) {
    if (confirm(`Remove your price for "${rm.dataset.premove}"?`))
      pricesAction({ action: 'remove', key: rm.dataset.premove });
    return;
  }
  const sv = t('[data-psave]');
  if (sv) {
    const card = sv.closest('.pcard');
    const price = {};
    for (const [f] of priceFields) price[f] = Number(card.querySelector(`[name="pe-${f}"]`).value) || 0;
    const key = sv.dataset.psave === '__new' ? card.querySelector('[name="pe-key"]').value.trim() : sv.dataset.psave;
    if (!key) {
      alert('Enter a model prefix.');
      return;
    }
    pricesAction({ action: 'set', key, price });
  }
});
document.addEventListener('change', (e) => {
  if (!e.target.matches) return;
  if (e.target.matches('[data-psync]')) pricesAction({ action: 'toggle', enabled: e.target.checked });
  if (e.target.matches('[data-pbasis]')) {
    pv2.basis = e.target.value;
    store.set('priceBasis', pv2.basis);
    paintPrices();
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'pc-q') {
    pv2.q = e.target.value;
    const pos = e.target.selectionStart;
    paintPrices();
    const q = $('#pc-q');
    if (q) {
      q.focus();
      q.setSelectionRange(pos, pos);
    }
  }
});
