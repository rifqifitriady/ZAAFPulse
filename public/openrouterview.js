'use strict';
/* Quality & safety → Models and Rankings, from OpenRouter (public API + the public rankings page),
   plus the provider directory on Provider stats. Lat. and TPS come from your own requests when
   OpenRouter does not publish them. */

const OR_VENDOR = { 'x-ai': 'xai', 'meta-llama': 'meta', qwen: 'alibaba', 'z-ai': 'zai' };
const orVendor = (prefix) => {
  const id = OR_VENDOR[prefix] || prefix;
  const v = VENDOR[id];
  return v
    ? { id, name: v[0], color: v[1], mono: v[2] }
    : {
        id,
        name: prefix.replace(/(^|-)\w/g, (c) => c.toUpperCase()).replace(/-/g, ' '),
        color: '#8f98cc',
        mono: (prefix[0] || '?').toUpperCase(),
      };
};
// How your logs name an OpenRouter model: Anthropic uses dashes for versions, others keep dots.
const orLocalKey = (id) => {
  const [v, slug = ''] = id.replace(/^~/, '').split('/');
  return v === 'anthropic' ? slug.replace(/\./g, '-') : slug;
};
const orMatches = (id, model) => {
  const k = orLocalKey(id);
  return model === k || new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}$`).test(model);
};
const or = {
  models: null,
  rankings: null,
  providers: null,
  account: null,
  eps: {},
  local: null,
  q: '',
  vendor: 'all',
  view: 'featured',
  sort: 'popular',
  shown: 36,
  appsPeriod: 'week',
  loading: false,
};
const uptimeColor = (u) =>
  u == null ? 'rgba(140,160,255,.25)' : u >= 99 ? '#5cf0a8' : u >= 95 ? '#ffb547' : '#ff4f6d';

async function loadOpenRouter(parts) {
  const res = await Promise.all(
    parts.map((p) => api(`/api/openrouter?section=${p}`).catch((err) => ({ error: err.message }))),
  );
  parts.forEach((p, i) => {
    or[p] = res[i];
  });
  if (!or.local) {
    // Your own latency and output speed per model, from the last 3 hours of requests.
    try {
      const logs = await api('/api/logs');
      const by = {};
      for (const r of logs.requests) (by[r.model] ||= []).push(r);
      or.local = Object.fromEntries(
        Object.entries(by).map(([m, rs]) => [
          m,
          {
            n: rs.length,
            ttft: quantile(
              rs.map((r) => r.ttftMs),
              0.5,
            ),
            tps: quantile(
              rs.filter((r) => r.durationMs > 0 && r.output > 0).map((r) => r.output / (r.durationMs / 1000)),
              0.5,
            ),
          },
        ]),
      );
    } catch {
      or.local = {};
    }
  }
}
const usedModels = () => ((state.data && state.data.models) || []).map((m) => m.model);
const localFor = (id) => {
  const hit = Object.entries(or.local || {}).find(([m]) => orMatches(id, m));
  return hit ? hit[1] : null;
};
const rankOf = (id) =>
  or.rankings && or.rankings.data
    ? or.rankings.data.models.find((m) => m.slug === id.replace(/^~/, '').replace(/:.*$/, ''))
    : null;
const freshness = (v, label) =>
  v && v.fetchedAt
    ? `${label} · updated ${ago(v.fetchedAt)}${v.stale ? ' (stale)' : ''}`
    : v && v.error
      ? `${label} · ${esc(v.error)}`
      : `${label} · loading`;

async function mountOpenRouterPage(sub) {
  const el = $('#qp-body');
  if (!el) return;
  await loadOpenRouter(sub === 'models' ? ['models', 'rankings', 'account'] : ['rankings', 'models']);
  if (state.sub !== sub || !$('#qp-body')) return;
  if (sub === 'models') {
    paintModels();
    mountVendorCity();
  } else {
    paintRankings();
    mountRankSkyline();
  }
}

/* ---------- Models ---------- */
function modelList() {
  const all = (or.models && or.models.data) || [];
  const used = usedModels();
  const q = or.q.toLowerCase();
  let list = all.filter((m) => !m.id.startsWith('~') && !m.id.endsWith(':batch'));
  if (or.view === 'featured') list = list.filter((m) => used.some((u) => orMatches(m.id, u)) || rankOf(m.id));
  else if (or.view === 'used') list = list.filter((m) => used.some((u) => orMatches(m.id, u)));
  else if (or.view === 'free') list = list.filter((m) => m.free || (m.input === 0 && m.output === 0));
  if (or.vendor !== 'all') list = list.filter((m) => orVendor(m.vendor).id === or.vendor);
  if (q) list = list.filter((m) => `${m.id} ${m.name} ${m.description}`.toLowerCase().includes(q));
  const blend = (m) => (m.input || 0) + (m.output || 0);
  const sorters = {
    popular: (a, b) =>
      (rankOf(a.id) || { rank: 999 }).rank - (rankOf(b.id) || { rank: 999 }).rank ||
      (b.created || 0) - (a.created || 0),
    newest: (a, b) => (b.created || 0) - (a.created || 0),
    desc: (a, b) => blend(b) - blend(a),
    asc: (a, b) => blend(a) - blend(b),
    context: (a, b) => (b.context || 0) - (a.context || 0),
  };
  return list.sort(sorters[or.sort] || sorters.popular);
}

function modelCard(m) {
  const v = orVendor(m.vendor);
  const ep = or.eps[m.id];
  const eps = ep && ep.data ? ep.data : null;
  const up = eps && eps.length ? eps.reduce((a, e) => a + (e.uptime1d ?? 100), 0) / eps.length : null;
  const lat =
    eps && eps.some((e) => e.latencyMs != null)
      ? Math.min(...eps.filter((e) => e.latencyMs != null).map((e) => e.latencyMs))
      : null;
  const tps =
    eps && eps.some((e) => e.tps != null) ? Math.max(...eps.filter((e) => e.tps != null).map((e) => e.tps)) : null;
  const loc = localFor(m.id);
  const rk = rankOf(m.id);
  const tags = [
    m.params.includes('reasoning') && 'Reasoning',
    m.params.includes('tools') && 'Tools',
    m.modalities.in.includes('image') && 'Vision',
    m.params.includes('structured_outputs') && 'Structured output',
    m.modalities.out.includes('image') && 'Image out',
  ].filter(Boolean);
  const price = (label, val) =>
    `<div><span>${label}</span><em class="pc-line"><b class="num">${val == null ? '—' : money(val)}</b><small> / 1M</small></em></div>`;
  const bars = eps
    ? eps
        .slice(0, 20)
        .map(
          (e) =>
            `<i style="background:${uptimeColor(e.uptime1d)}" title="${esc(e.provider)} · ${e.uptime1d == null ? 'no data' : e.uptime1d.toFixed(2) + '%'}"></i>`,
        )
        .join('')
    : '<i class="pending"></i>'.repeat(12);
  return `<article class="pcard orcard" style="--v:${v.color}">
    <div class="pc-head"><span class="pc-logo">${esc(v.mono)}</span><div class="pc-title"><b title="${esc(m.id)}">${esc(m.id.split('/')[1] || m.id)}</b><small>${esc(m.name)} · ${esc(v.name)}</small></div>
      ${rk ? `<span class="or-rank" title="Rank by tokens this ${esc(or.rankings.data.period)}">#${rk.rank}</span>` : ''}
      <button class="icon-btn pc-copy" type="button" data-pcopy="${esc(m.id)}" title="Copy model id" aria-label="Copy ${esc(m.id)}">${icon('layers', 14)}</button></div>
    <p class="pc-desc">${m.description ? esc(m.description) : 'No description available.'}</p>
    ${tags.length ? `<div class="pc-kv"><span>Tags</span><b>${esc(tags.slice(0, 2).join(', '))}${tags.length > 2 ? ` <i>+${tags.length - 2}</i>` : ''}</b></div>` : ''}
    <span class="pc-src live">${m.free || (m.input === 0 && m.output === 0) ? 'Free' : 'Live pricing'}</span>
    <div class="pc-prices">${price('Input', m.input)}${price('Output', m.output)}${m.cacheRead != null ? price('Cache read', m.cacheRead) : `<div><span>Context</span><em class="pc-line"><b class="num">${m.context ? fmtN(m.context) : '—'}</b></em></div>`}</div>
    <div class="pc-meta"><div class="pc-kv"><span>Context</span><b>${m.context ? fmtN(m.context) : '—'}</b></div><div class="pc-kv"><span>Providers</span><b>${eps ? eps.length : '…'}</b></div></div>
    <div class="pc-foot or-foot">
      <div class="pc-share"><div class="pc-kv"><span>Status</span><b class="num">${up == null ? '—' : `${up.toFixed(2)}%`}</b></div><div class="pc-bars or-bars">${bars}</div></div>
      <div class="pc-stat"><span>Lat.${lat == null && loc ? ' · yours' : ''}</span><b class="num">${lat != null ? msFmt(lat) : loc && loc.ttft != null ? msFmt(loc.ttft) : '—'}</b></div>
      <div class="pc-stat"><span>TPS${tps == null && loc ? ' · yours' : ''}</span><b class="num">${tps != null ? `${tps.toFixed(1)}t/s` : loc && loc.tps ? `${loc.tps.toFixed(1)}t/s` : '—'}</b></div>
      <button class="pc-details" type="button" data-ormodel="${esc(m.id)}">Details <span aria-hidden="true">›</span></button>
    </div></article>`;
}

function paintModels() {
  const body = $('#qp-body');
  if (!body) return;
  const all = (or.models && or.models.data) || [];
  if (!all.length) {
    body.innerHTML = holoEmpty(`Could not load OpenRouter models: ${esc((or.models && or.models.error) || 'no data')}`);
    return;
  }
  const page = modelList().slice(0, or.shown);
  const used = usedModels();
  const usedHere = all.filter((m) => used.some((u) => orMatches(m.id, u)));
  const priced = all.filter((m) => m.input != null && !m.id.startsWith('~'));
  const free = all.filter((m) => m.free || (m.input === 0 && m.output === 0));
  const vendors = new Set(all.map((m) => m.vendor));
  const newest = [...all].sort((a, b) => (b.created || 0) - (a.created || 0))[0];
  const ctx = [...all].sort((a, b) => (b.context || 0) - (a.context || 0))[0];
  const cheapTools = [...priced]
    .filter((m) => m.params.includes('tools') && m.input > 0)
    .sort((a, b) => a.input + a.output - b.input - b.output)[0];
  const acc = or.account || {};
  body.innerHTML = `<section class="holo stage landscape-stage"><canvas id="qp-models" aria-label="3D price landscape of OpenRouter models by vendor"></canvas>
      <div class="stage-tl"><div class="holo-kicker">PRICE LANDSCAPE · BY VENDOR</div><div class="stage-key">One row per vendor, cheapest to priciest · height = input + output price (log) · glow = in this week's top 20 · hover a tower</div></div></section>
    <div class="live-metrics">${[
      metricTile({
        label: 'Models',
        value: whole.format(all.length),
        sub: freshness(or.models, 'OpenRouter'),
        color: HOLO.cyan,
      }),
      metricTile({
        label: 'Vendors',
        value: whole.format(vendors.size),
        sub: `${whole.format(free.length)} free models`,
        color: HOLO.cyan,
      }),
      metricTile({
        label: 'You use',
        value: whole.format(usedHere.length),
        sub:
          usedHere
            .slice(0, 2)
            .map((m) => esc(m.id.split('/')[1]))
            .join(' · ') || 'none matched',
        color: HOLO.violet,
      }),
      metricTile({
        label: 'Median input',
        value: money(
          quantile(
            priced.filter((m) => m.input > 0).map((m) => m.input),
            0.5,
          ),
        ),
        sub: 'per 1M tokens',
        color: HOLO.orange,
      }),
      metricTile({
        label: 'Median output',
        value: money(
          quantile(
            priced.filter((m) => m.output > 0).map((m) => m.output),
            0.5,
          ),
        ),
        sub: 'per 1M tokens',
        color: HOLO.orange,
      }),
      metricTile({
        label: 'Cheapest with tools',
        value: cheapTools ? esc(cheapTools.id.split('/')[1]) : '—',
        sub: cheapTools ? `${money(cheapTools.input)} / ${money(cheapTools.output)}` : '',
        color: '#5cf0a8',
      }),
      metricTile({
        label: 'Largest context',
        value: ctx ? fmtN(ctx.context) : '—',
        sub: ctx ? esc(ctx.id.split('/')[1]) : '',
        color: HOLO.blue,
      }),
      metricTile({
        label: 'Newest',
        value: newest ? esc(newest.id.split('/')[1]) : '—',
        sub: newest && newest.created ? ago(newest.created) : '',
        color: HOLO.pink,
      }),
      metricTile({
        label: 'Reasoning models',
        value: whole.format(all.filter((m) => m.params.includes('reasoning')).length),
        sub: `${whole.format(all.filter((m) => m.params.includes('tools')).length)} support tools`,
        color: HOLO.violet,
      }),
      metricTile({
        label: 'Vision models',
        value: whole.format(all.filter((m) => m.modalities.in.includes('image')).length),
        sub: 'image input',
        color: HOLO.blue,
      }),
      acc.configured
        ? metricTile({
            label: 'Credits left',
            value: acc.data ? fmtUSD((acc.data.totalCredits || 0) - (acc.data.totalUsage || 0)) : '—',
            sub: acc.data ? `${fmtUSD(acc.data.usageMonthly || 0)} used this month` : esc(acc.error || ''),
            color: '#5cf0a8',
          })
        : metricTile({
            label: 'Account',
            value: 'No key',
            sub: 'add an OpenRouter integration for credits',
            color: HOLO.muted,
          }),
      metricTile({
        label: '#1 this week',
        value: or.rankings && or.rankings.data ? esc(or.rankings.data.models[0].slug.split('/')[1]) : '—',
        sub: or.rankings && or.rankings.data ? `${fmtN(or.rankings.data.models[0].tokens)} tokens` : 'rankings loading',
        color: HOLO.pink,
      }),
    ].join('')}</div>
    <section class="holo panel" id="or-catalog">${catalogHtml()}</section>`;
  loadVisibleEndpoints(page.map((m) => m.id));
}

// The catalog panel alone, so filters and paging never rebuild the 3D scene above it.
function catalogHtml() {
  const all = (or.models && or.models.data) || [];
  const list = modelList();
  const page = list.slice(0, or.shown);
  const counts = {};
  for (const m of all) {
    const id = orVendor(m.vendor).id;
    counts[id] = (counts[id] || 0) + 1;
  }
  const chipVendors = [
    'all',
    ...VENDOR_ORDER,
    ...Object.keys(counts)
      .filter((k) => !VENDOR_ORDER.includes(k))
      .sort((a, b) => counts[b] - counts[a])
      .slice(0, 6),
  ];
  return `<div class="panel-head pc-toolbar"><h3>Model catalog</h3><span class="meta">${list.length} shown of ${all.length}</span>
        <div class="pc-sync"><div class="segmented" role="group" aria-label="Which models">${[
          ['featured', 'Featured'],
          ['used', 'You use'],
          ['free', 'Free'],
          ['all', 'All'],
        ]
          .map(([v, l]) => `<button type="button" data-orview="${v}" aria-pressed="${or.view === v}">${l}</button>`)
          .join('')}</div>
          <label class="pc-basis">Sort <select class="input" data-orsort>${[
            ['popular', 'Most used'],
            ['newest', 'Newest'],
            ['desc', 'Highest price'],
            ['asc', 'Lowest price'],
            ['context', 'Largest context'],
          ]
            .map(([v, l]) => `<option value="${v}" ${or.sort === v ? 'selected' : ''}>${l}</option>`)
            .join('')}</select></label>
          <label class="search sq-search">${icon('search', 14)}<input id="or-q" type="search" placeholder="Find a model…" value="${esc(or.q)}" autocomplete="off"></label></div>
        <div class="pc-vendors">${chipVendors
          .filter((v) => v === 'all' || counts[v])
          .map((v) => {
            const meta = v === 'all' ? null : orVendor(Object.keys(OR_VENDOR).find((k) => OR_VENDOR[k] === v) || v);
            return `<button class="pc-vendor" type="button" data-orvendor="${v}" aria-pressed="${or.vendor === v}" style="--v:${v === 'all' ? 'var(--h-cyan)' : meta.color}">${v === 'all' ? 'All vendors' : `<i>${esc(meta.mono)}</i>${esc(meta.name)}`}<b>${v === 'all' ? all.length : counts[v]}</b></button>`;
          })
          .join('')}</div></div>
      <p class="kpi-sub pc-note">Status is each provider's uptime over the last day (one bar per provider serving the model). OpenRouter does not publish latency or throughput, so Lat. and TPS show your own median from the last 3 hours when you used the model.</p>
      <div class="pc-grid" id="or-grid">${page.map(modelCard).join('') || holoEmpty('No model matches.')}</div>
      ${list.length > or.shown ? `<div class="or-more"><button class="btn ghost" type="button" data-ormore>Show ${Math.min(36, list.length - or.shown)} more</button></div>` : ''}`;
}
function repaintCatalog() {
  const el = $('#or-catalog');
  if (!el) return;
  const focus =
    document.activeElement && document.activeElement.id === 'or-q' ? document.activeElement.selectionStart : null;
  el.innerHTML = catalogHtml();
  if (focus != null) {
    const q = $('#or-q');
    q.focus();
    q.setSelectionRange(focus, focus);
  }
  loadVisibleEndpoints(
    modelList()
      .slice(0, or.shown)
      .map((m) => m.id),
  );
}

async function loadVisibleEndpoints(ids) {
  const need = ids.filter((id) => !or.eps[id]).slice(0, 40);
  if (!need.length) return;
  for (const id of need) or.eps[id] = { pending: true };
  const res = await api(`/api/openrouter/endpoints?ids=${encodeURIComponent(need.join(','))}`).catch(() => ({}));
  for (const id of need) or.eps[id] = res[id] || { data: null };
  if (state.sub === 'models')
    for (const id of need) {
      const card = $(`[data-ormodel="${CSS.escape(id)}"]`)?.closest('.orcard');
      const m = or.models.data.find((x) => x.id === id);
      if (card && m) card.outerHTML = modelCard(m);
    }
}

// Vendors as rows of towers (cheapest → priciest), height = log of input + output price.
function mountVendorCity() {
  const canvas = $('#qp-models');
  const all = (or.models && or.models.data) || [];
  if (!canvas || !all.length) return;
  const vids = VENDOR_ORDER.filter((v) => all.some((m) => orVendor(m.vendor).id === v));
  const rows = vids.map((v) =>
    all
      .filter((m) => orVendor(m.vendor).id === v && m.input != null && !m.id.startsWith('~') && !m.free)
      .sort((a, b) => a.input + a.output - b.input - b.output)
      .slice(-14),
  );
  const maxLog = Math.log10(1 + Math.max(1, ...rows.flat().map((m) => m.input + m.output)));
  const top = new Set(((or.rankings && or.rankings.data && or.rankings.data.models) || []).map((m) => m.slug));
  const heights = {};
  const hov = { tip: '' };
  isoStage(canvas, {
    fit: [13, 8.4],
    origin: [0.5, 0.6],
    draw(g) {
      const { P, ctx, still } = g;
      const Z0 = -2.6;
      const dz = 5 / Math.max(1, rows.length - 1);
      g.glow();
      g.platform(-6, 6, -3.1, 2.9);
      const items = [];
      const pts = [];
      rows.forEach((list, ri) => {
        const v = orVendor(Object.keys(OR_VENDOR).find((k) => OR_VENDOR[k] === vids[ri]) || vids[ri]);
        const z = Z0 + ri * dz;
        list.forEach((m, i) => {
          const x = -5.4 + i * 0.8;
          const key = m.id;
          const target = 0.06 + 3 * (Math.log10(1 + m.input + m.output) / maxLog);
          heights[key] = (heights[key] ?? 0.02) + (target - (heights[key] ?? 0.02)) * (still ? 1 : 0.08);
          const hot = top.has(m.id);
          items.push({
            depth: P(x, 0, z)[2],
            draw: () =>
              g.box(x, z, 0.5, 0.42, heights[key], v.color, { slices: 0, glow: hot ? 18 : 0, alpha: hot ? 1 : 0.85 }),
          });
          pts.push({
            at: P(x + 0.25, heights[key], z + 0.21),
            key,
            html: () =>
              `<b>${esc(m.id)}</b><div class="row"><span>Input / output</span><span class="num">${money(m.input)} / ${money(m.output)}</span></div><div class="row"><span>Context</span><span class="num">${m.context ? fmtN(m.context) : '—'}</span></div>${hot ? '<div class="row"><span>Rankings</span><span>top 20 this week</span></div>' : ''}`,
          });
        });
        const q = P(-5.75, 0, z + 0.2);
        ctx.save();
        ctx.fillStyle = v.color;
        ctx.font = '700 10.5px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(v.name, q[0] - 6, q[1] + 4);
        ctx.restore();
      });
      items.sort((a, b) => a.depth - b.depth).forEach((it) => it.draw());
      g.particles();
      hoverTip(g, pts, hov);
    },
  });
}

/* ---------- Rankings ---------- */
function paintRankings() {
  const body = $('#qp-body');
  if (!body) return;
  const r = or.rankings && or.rankings.data;
  if (!r) {
    body.innerHTML = holoEmpty(
      `Could not read OpenRouter rankings: ${esc((or.rankings && or.rankings.error) || 'no data')}`,
    );
    return;
  }
  const models = r.models;
  const total = models.reduce((a, m) => a + m.tokens, 0) || 1;
  const priceOfSlug = (slug) => ((or.models && or.models.data) || []).find((m) => m.id === slug);
  const byVendor = {};
  for (const m of models) {
    const v = orVendor(m.slug.split('/')[0]);
    (byVendor[v.id] ||= { ...v, tokens: 0 }).tokens += m.tokens;
  }
  const vendorsSorted = Object.values(byVendor).sort((a, b) => b.tokens - a.tokens);
  const used = usedModels();
  const yours = models.filter((m) => used.some((u) => orMatches(m.slug, u)));
  const apps = r.apps[or.appsPeriod] || [];
  const b = r.benchmarks;
  const completion = models.reduce((a, m) => a + m.completion, 0);
  const tiles = [
    metricTile({
      label: '#1 model',
      value: esc(models[0].slug.split('/')[1]),
      sub: `${pct(models[0].tokens / total)} of top-20 tokens`,
      color: HOLO.pink,
      p: models[0].tokens / total,
    }),
    metricTile({
      label: 'Top-20 tokens',
      value: fmtN(total),
      sub: `this ${esc(r.period)} · ${fmtN(models.reduce((a, m) => a + m.requests, 0))} requests`,
      color: HOLO.cyan,
      spark: models.map((m) => m.tokens).reverse(),
    }),
    metricTile({
      label: 'Leading vendor',
      value: esc(vendorsSorted[0].name),
      sub: `${pct(vendorsSorted[0].tokens / total)} of top-20 tokens`,
      color: vendorsSorted[0].color,
      p: vendorsSorted[0].tokens / total,
    }),
    metricTile({
      label: 'Vendors in top 20',
      value: whole.format(vendorsSorted.length),
      sub: vendorsSorted
        .slice(0, 3)
        .map((v) => esc(v.name))
        .join(' · '),
      color: HOLO.violet,
    }),
    metricTile({
      label: 'Output share',
      value: pct(completion / total),
      sub: 'completion tokens of total',
      color: HOLO.violet,
      p: completion / total,
    }),
    metricTile({
      label: 'Your models in top 20',
      value: whole.format(yours.length),
      sub: yours.length ? `best: #${yours[0].rank} ${esc(yours[0].slug.split('/')[1])}` : 'none of yours',
      color: '#5cf0a8',
    }),
    metricTile({
      label: 'Top app listed',
      value: apps[0] ? esc(apps[0].title) : '—',
      sub: apps[0] ? `rank #${esc(apps[0].rank)} · ${fmtN(apps[0].tokens)} tokens this ${esc(or.appsPeriod)}` : '',
      color: HOLO.orange,
    }),
    metricTile({
      label: 'Tokens / request',
      value: fmtN(
        total /
          Math.max(
            1,
            models.reduce((a, m) => a + m.requests, 0),
          ),
      ),
      sub: 'top-20 average',
      color: HOLO.blue,
    }),
    metricTile({
      label: 'Top intelligence',
      value: b.intelligence[0] ? esc(b.intelligence[0].slug.split('/')[1]) : '—',
      sub: b.intelligence[0] ? `score ${b.intelligence[0].score}` : '',
      color: HOLO.cyan,
    }),
    metricTile({
      label: 'Top coding',
      value: b.coding[0] ? esc(b.coding[0].slug.split('/')[1]) : '—',
      sub: b.coding[0] ? `score ${b.coding[0].score}` : '',
      color: HOLO.cyan,
    }),
    metricTile({
      label: 'Top agentic',
      value: b.agentic[0] ? esc(b.agentic[0].slug.split('/')[1]) : '—',
      sub: b.agentic[0] ? `score ${b.agentic[0].score}` : '',
      color: HOLO.cyan,
    }),
    metricTile({
      label: 'Snapshot',
      value: esc(String(r.date).slice(0, 10)),
      sub: freshness(or.rankings, 'read'),
      color: HOLO.muted,
    }),
  ];
  const maxT = models[0].tokens;
  const table = `<table class="holo-table"><thead><tr><th>#</th><th>Model</th><th>Tokens</th><th class="r">Requests</th><th class="r">Tokens / req</th><th class="r">Output share</th><th class="r">Input / output</th></tr></thead><tbody>
    ${models
      .map((m) => {
        const v = orVendor(m.slug.split('/')[0]);
        const p = priceOfSlug(m.slug);
        const mine = used.some((u) => orMatches(m.slug, u));
        return `<tr><td class="num"><b>${m.rank}</b></td><td><span class="tool-dot" style="background:${v.color}"></span><b>${esc(m.slug.split('/')[1])}</b>${mine ? ' <span class="state-pill" style="--c:#5cf0a8"><i></i>you use</span>' : ''}${m.variant !== 'standard' ? ` <small class="muted">${esc(m.variant)}</small>` : ''}<small class="block muted">${esc(v.name)}</small></td>
        <td><div class="cell-bar left"><span class="num">${fmtN(m.tokens)} · ${pct(m.tokens / total)}</span><i style="width:${((m.tokens / maxT) * 100).toFixed(1)}%;background:${v.color}"></i></div></td>
        <td class="r num">${fmtN(m.requests)}</td><td class="r num">${fmtN(m.tokens / Math.max(1, m.requests))}</td><td class="r num">${pct(m.completion / Math.max(1, m.tokens))}</td>
        <td class="r num">${p ? `${money(p.input)} / ${money(p.output)}` : '—'}</td></tr>`;
      })
      .join('')}</tbody></table>`;
  const bench = (title, list) =>
    panel(
      title,
      `top 10 of ${list.length}`,
      barList(list.slice(0, 10), {
        value: (x) => x.score,
        label: (x) =>
          `${esc(x.slug.split('/')[1] || x.slug)}${used.some((u) => orMatches(x.slug, u)) ? ' <small>you use</small>' : ''}`,
        color: (x) => orVendor(x.slug.split('/')[0]).color,
        fmt: (v) => String(+v.toFixed(1)),
      }),
    );
  body.innerHTML = `<section class="holo stage landscape-stage"><canvas id="qp-rankings" aria-label="3D skyline of the most-used models on OpenRouter"></canvas>
      <div class="stage-tl"><div class="holo-kicker">TOP 20 MODELS · TOKENS THIS ${esc(r.period.toUpperCase())}</div><div class="stage-key">Ranked left to right · height = tokens processed · color = vendor · podium glow for the top 3 · walls: requests and output share · hover a tower</div></div>
      <div class="stage-legend">${vendorsSorted
        .slice(0, 7)
        .map((v) => `<span><i style="background:${v.color}"></i>${esc(v.name)}</span>`)
        .join('')}</div></section>
    <div class="live-metrics">${tiles.join('')}</div>
    <div class="live-grid">
      ${panel('Most-used models', `OpenRouter · ${esc(r.period)} of ${esc(String(r.date).slice(0, 10))}`, `<div class="table-wrap">${table}</div>`)}
      ${panel('Share by vendor', 'top-20 tokens', meters(vendorsSorted.map((v) => ({ label: esc(v.name), value: v.tokens, max: total, color: v.color, right: `${fmtN(v.tokens)} · ${pct(v.tokens / total)}` }))))}
    </div>
    <section class="holo panel"><div class="panel-head"><h3>Top apps</h3><span class="meta">by tokens through OpenRouter</span>
      <div class="right"><div class="segmented" role="group" aria-label="Period">${['day', 'week', 'month'].map((p) => `<button type="button" data-orapps="${p}" aria-pressed="${or.appsPeriod === p}">${p === 'day' ? 'Today' : p === 'week' ? 'This week' : 'This month'}</button>`).join('')}</div></div></div>
      <div class="or-apps" id="or-apps">${appsHtml()}</div></section>
    <div class="live-grid even">${bench('Intelligence', b.intelligence)}${bench('Coding', b.coding)}</div>
    <div class="live-grid even">${bench('Agentic', b.agentic)}${bench('Vals index', b.vals)}</div>
    <p class="kpi-sub">Rankings, apps and benchmarks are read from the public openrouter.ai/rankings page (there is no API for them) and refreshed every 6 hours. If the page changes, this section shows an error rather than guessing.</p>`;
}
function appsHtml() {
  const apps = or.rankings.data.apps[or.appsPeriod] || [];
  return `${apps.map((a) => `<div class="or-app"><span class="or-app-rank">${esc(a.rank)}</span><div><b>${a.url ? `<a href="${esc(safeUrl(a.url))}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a>` : esc(a.title)}</b><small>${esc(a.categories.join(' · ') || 'app')}</small></div><span class="num">${fmtN(a.tokens)}</span></div>`).join('') || holoEmpty('No apps for this period.')}`;
}

function mountRankSkyline() {
  const canvas = $('#qp-rankings');
  const r = or.rankings && or.rankings.data;
  if (!canvas || !r) return;
  const models = r.models;
  const maxT = Math.max(1, ...models.map((m) => m.tokens));
  const heights = {};
  const hov = { tip: '' };
  isoStage(canvas, {
    fit: [13.2, 8.4],
    origin: [0.5, 0.62],
    draw(g) {
      const { P, still } = g;
      g.glow();
      g.platform(-6, 6, -3.1, 2.6);
      g.wall(-5.8, -2.6, -0.1, -2.9, {
        vals: models.map((m) => m.requests),
        color: HOLO.cyan,
        title: 'REQUESTS BY RANK',
        value: fmtN(models.reduce((a, m) => a + m.requests, 0)),
        H: 2.4,
        hot: 0,
      });
      g.wall(0.1, -2.9, 5.8, -2.6, {
        vals: models.map((m) => m.completion / Math.max(1, m.tokens)),
        color: HOLO.violet,
        title: 'OUTPUT SHARE BY RANK',
        value: pct(
          models.reduce((a, m) => a + m.completion, 0) /
            Math.max(
              1,
              models.reduce((a, m) => a + m.tokens, 0),
            ),
        ),
        H: 2.4,
      });
      const items = [];
      const pts = [];
      models.forEach((m, i) => {
        const row = i % 2;
        const x = -5.5 + Math.floor(i / 2) * 1.12 + row * 0.5;
        const z = -1.2 + row * 1.6;
        const v = orVendor(m.slug.split('/')[0]);
        const target = 0.12 + 3.6 * Math.sqrt(m.tokens / maxT);
        heights[m.permaslug] =
          (heights[m.permaslug] ?? 0.05) + (target - (heights[m.permaslug] ?? 0.05)) * (still ? 1 : 0.07);
        const h = heights[m.permaslug];
        items.push({
          depth: P(x, 0, z)[2],
          draw: () => g.box(x, z, 0.6, 0.6, h, v.color, { glow: i < 3 ? 22 : 0, slices: 0.4 }),
        });
        pts.push({
          at: P(x + 0.3, h, z + 0.3),
          key: m.permaslug,
          m,
          html: () =>
            `<b>#${m.rank} ${esc(m.slug)}</b><div class="row"><span>Tokens</span><span class="num">${fmtN(m.tokens)}</span></div><div class="row"><span>Requests</span><span class="num">${fmtN(m.requests)}</span></div><div class="row"><span>Output share</span><span class="num">${pct(m.completion / Math.max(1, m.tokens))}</span></div>`,
        });
      });
      items.sort((a, b) => a.depth - b.depth).forEach((it) => it.draw());
      g.particles();
      g.labels(
        pts.slice(0, 5).map((p) => ({
          at: p.at,
          text: `#${p.m.rank} ${p.m.slug.split('/')[1]} · ${fmtN(p.m.tokens)}`,
          color: p.m.rank <= 3 ? HOLO.pink : orVendor(p.m.slug.split('/')[0]).color,
        })),
      );
      hoverTip(g, pts, hov);
    },
  });
}

/* ---------- Provider directory on Provider stats ---------- */
async function appendProviderDirectory() {
  const v = await api('/api/openrouter?section=providers').catch((err) => ({ error: err.message }));
  const host = $('#qp-body');
  if (!host || state.sub !== 'providers') return;
  const list = v.data || [];
  const html = list.length
    ? `<div class="table-wrap or-dir"><table class="holo-table"><thead><tr><th>Provider</th><th>Headquarters</th><th>Datacenters</th><th>Status page</th></tr></thead><tbody>
    ${list
      .map(
        (
          p,
        ) => `<tr><td><b>${esc(p.name)}</b></td><td class="muted">${esc(p.headquarters || '—')}</td><td class="muted">${p.datacenters.length ? esc(p.datacenters.slice(0, 8).join(', ')) + (p.datacenters.length > 8 ? ` +${p.datacenters.length - 8}` : '') : '—'}</td>
      <td>${p.statusPage ? `<a class="link" href="${esc(safeUrl(p.statusPage))}" target="_blank" rel="noopener noreferrer">status ↗</a>` : '<span class="muted">—</span>'}</td></tr>`,
      )
      .join('')}</tbody></table></div>`
    : holoEmpty(`Could not load the provider directory: ${esc(v.error || 'no data')}`);
  host.insertAdjacentHTML(
    'beforeend',
    panel('Inference providers on OpenRouter', `${list.length} providers · ${freshness(v, 'OpenRouter')}`, html),
  );
}

/* ---------- Model drill-down ---------- */
const OPENROUTER_DRILLS = {
  ormodel() {
    const m = ((or.models && or.models.data) || []).find((x) => x.id === state.orSel);
    if (!m) return { eyebrow: 'MODEL', title: 'Model', body: '<div class="empty">Model not found.</div>' };
    const eps = (or.eps[m.id] && or.eps[m.id].data) || [];
    const rk = rankOf(m.id);
    const loc = localFor(m.id);
    const b = or.rankings && or.rankings.data ? or.rankings.data.benchmarks : null;
    const score = (k) => (b ? (b[k].find((x) => x.slug === m.id) || {}).score : null);
    const upBar = (u) =>
      `<span class="or-up"><i style="width:${u == null ? 0 : Math.max(2, u)}%;background:${uptimeColor(u)}"></i></span>${u == null ? '—' : `${u.toFixed(1)}%`}`;
    return {
      eyebrow: `OPENROUTER · ${esc(orVendor(m.vendor).name.toUpperCase())}`,
      title: esc(m.id),
      body:
        tiles([
          ['Input / output', `${money(m.input)} / ${money(m.output)}`, 'per 1M tokens'],
          [
            'Context',
            m.context ? fmtN(m.context) : '—',
            m.knowledgeCutoff ? `knowledge to ${esc(m.knowledgeCutoff)}` : '',
          ],
          ['Rank this week', rk ? `#${rk.rank}` : '—', rk ? `${fmtN(rk.tokens)} tokens` : 'not in the top 20'],
          [
            'Your latency',
            loc && loc.ttft != null ? msFmt(loc.ttft) : '—',
            loc ? `${loc.n} requests · ${loc.tps ? loc.tps.toFixed(1) + ' tok/s' : '—'}` : 'not used in the last 3 h',
          ],
        ]) +
        dsec(
          1,
          'About',
          `<p class="drawer-note" style="margin:0">${esc(m.description || 'No description available.')}</p>`,
        ) +
        (b
          ? dsec(
              2,
              'Benchmarks',
              `<div class="tags">${['intelligence', 'coding', 'agentic', 'vals'].map((k) => `<span class="tag">${k}: ${score(k) != null ? +score(k).toFixed(1) : '—'}</span>`).join('')}</div>`,
            )
          : '') +
        dsec(
          3,
          'Providers serving it',
          eps.length
            ? `<div class="table-wrap"><table><thead><tr><th>Provider</th><th class="r">Input / output</th><th>Uptime 1d</th><th class="r">30m · 5m</th></tr></thead><tbody>
          ${eps.map((e) => `<tr><td><b>${esc(e.provider)}</b><small class="block muted">${[e.quantization && e.quantization !== 'unknown' ? esc(e.quantization) : '', e.maxOutput ? `max out ${fmtN(e.maxOutput)}` : ''].filter(Boolean).join(' · ') || '&nbsp;'}</small></td><td class="r num">${money(e.input)} / ${money(e.output)}</td><td class="nowrap">${upBar(e.uptime1d)}</td><td class="r num">${e.uptime30m == null ? '—' : e.uptime30m.toFixed(0)} · ${e.uptime5m == null ? '—' : e.uptime5m.toFixed(0)}</td></tr>`).join('')}
          </tbody></table></div>`
            : '<div class="empty">Loading providers…</div>',
          `${eps.length} endpoints`,
        ) +
        `<a class="btn ghost" href="https://openrouter.ai/${esc(m.id.replace(/^~/, ''))}" target="_blank" rel="noopener noreferrer">Open on OpenRouter ↗</a>`,
    };
  },
};

/* ---------- events ---------- */
document.addEventListener('click', async (e) => {
  if (state.route !== 'quality') return;
  const t = (s) => e.target.closest(s);
  const d = t('[data-ormodel]');
  if (d) {
    state.orSel = d.dataset.ormodel;
    if (!or.eps[state.orSel] || !or.eps[state.orSel].data) await loadVisibleEndpoints([state.orSel]);
    openDrill('ormodel', d);
    return;
  }
  const v = t('[data-orview]');
  if (v) {
    or.view = v.dataset.orview;
    or.shown = 36;
    repaintCatalog();
    return;
  }
  const vd = t('[data-orvendor]');
  if (vd) {
    or.vendor = vd.dataset.orvendor;
    or.shown = 36;
    if (or.vendor !== 'all' && or.view === 'featured') or.view = 'all';
    repaintCatalog();
    return;
  }
  if (t('[data-ormore]')) {
    or.shown += 36;
    repaintCatalog();
    return;
  }
  const ap = t('[data-orapps]');
  if (ap) {
    or.appsPeriod = ap.dataset.orapps;
    for (const x of $$('[data-orapps]')) x.setAttribute('aria-pressed', String(x === ap));
    $('#or-apps').innerHTML = appsHtml();
    return;
  }
  const c = t('[data-pcopy]');
  if (c && $('#or-grid')) {
    navigator.clipboard?.writeText(c.dataset.pcopy);
    c.classList.add('copied');
    setTimeout(() => c.classList.remove('copied'), 900);
  }
});
document.addEventListener('change', (e) => {
  if (e.target.matches && e.target.matches('[data-orsort]')) {
    or.sort = e.target.value;
    repaintCatalog();
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'or-q') {
    or.q = e.target.value;
    or.shown = 36;
    if (or.q && or.view === 'featured') or.view = 'all';
    repaintCatalog();
  }
});
