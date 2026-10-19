// OpenRouter data for the Models and Rankings pages and the openrouter connector.
// Public API (no key): the model list, per-model provider endpoints with uptime, and the provider
// directory. Rankings have no API, so they are read from the state embedded in the public
// openrouter.ai/rankings page (top models, top apps, benchmark scores); that parser is best-effort
// and reports an error instead of guessing when the page changes. With an API key: credits and key limits.
const fs = require('fs');
const path = require('path');

const BASE = 'https://openrouter.ai';
const TTL = {
  models: 12 * 3600e3,
  providers: 24 * 3600e3,
  rankings: 6 * 3600e3,
  endpoints: 10 * 60e3,
  account: 5 * 60e3,
};
const TIMEOUT_MS = 15000;

async function getJSON(url, { fetchImpl = fetch, key } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, {
      headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).pathname}`);
    return await r.json();
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? `timed out: ${new URL(url).pathname}` : err.message);
  } finally {
    clearTimeout(t);
  }
}

const perM = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 1e12) / 1e6);
function slimModel(m) {
  const [vendor] = m.id.replace(/^~/, '').split('/');
  return {
    id: m.id,
    vendor,
    name: (m.name || m.id).replace(/^[^:]+:\s*/, ''),
    description: typeof m.description === 'string' ? m.description.replace(/\s+/g, ' ').trim().slice(0, 400) : '',
    context: m.context_length || null,
    created: m.created ? m.created * 1000 : null,
    knowledgeCutoff: m.knowledge_cutoff || null,
    input: perM(m.pricing && m.pricing.prompt),
    output: perM(m.pricing && m.pricing.completion),
    cacheRead: perM(m.pricing && m.pricing.input_cache_read),
    modalities: { in: m.architecture?.input_modalities || [], out: m.architecture?.output_modalities || [] },
    params: (m.supported_parameters || []).filter((p) =>
      ['tools', 'reasoning', 'structured_outputs', 'response_format', 'web_search_options'].includes(p),
    ),
    free: m.id.endsWith(':free'),
  };
}
function slimEndpoint(e) {
  return {
    provider: e.provider_name,
    tag: e.tag,
    status: e.status,
    quantization: e.quantization,
    context: e.context_length,
    maxOutput: e.max_completion_tokens,
    uptime5m: e.uptime_last_5m,
    uptime30m: e.uptime_last_30m,
    uptime1d: e.uptime_last_1d,
    latencyMs: e.latency_last_30m,
    tps: e.throughput_last_30m,
    input: perM(e.pricing && e.pricing.prompt),
    output: perM(e.pricing && e.pricing.completion),
    cacheRead: perM(e.pricing && e.pricing.input_cache_read),
    implicitCaching: !!e.supports_implicit_caching,
  };
}

// The rankings page is a Next.js app; its data sits in self.__next_f.push chunks as a dehydrated
// react-query cache. We decode the chunks, find that cache, and pick the queries by key.
function parseRankings(html) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map((m) => {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return '';
    }
  });
  const queries = {};
  for (const text of chunks) {
    let at = text.indexOf('{"state":{"mutations":[],"queries":');
    while (at !== -1) {
      const obj = decodeAt(text, at);
      if (obj) for (const q of obj.state.queries || []) queries[JSON.stringify(q.queryKey)] = q.state && q.state.data;
      at = text.indexOf('{"state":{"mutations":[],"queries":', at + 10);
    }
  }
  const modelsKey = Object.keys(queries).find((k) => k.startsWith('["rankings","models"'));
  const rows = modelsKey ? queries[modelsKey] : null;
  if (!Array.isArray(rows) || !rows.length) throw new Error('rankings page changed: no model leaderboard found');
  const stripDate = (s) => s.replace(/-\d{8}$/, '');
  const models = rows
    .map((r) => ({
      slug: stripDate(r.model_permaslug),
      permaslug: r.model_permaslug,
      variant: r.variant,
      prompt: r.total_prompt_tokens || 0,
      completion: r.total_completion_tokens || 0,
      reasoning: r.total_native_tokens_reasoning || 0,
      tokens: (r.total_prompt_tokens || 0) + (r.total_completion_tokens || 0),
      requests: r.count || 0,
      date: r.date,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .map((m, i) => ({ ...m, rank: i + 1 }));
  const appsRaw = queries['["rankings","apps"]'] || {};
  const apps = Object.fromEntries(
    ['day', 'week', 'month'].map((p) => [
      p,
      (appsRaw[p] || [])
        .map((a) => ({
          rank: Number(a.rank) || null, // a number from a scraped page, never markup
          title: a.app?.title || a.app?.slug || 'app',
          url: a.app?.origin_url || a.app?.main_url || null,
          categories: a.app?.categories || [],
          description: (a.app?.description || '').slice(0, 220),
          tokens: Number(a.total_tokens) || 0,
          requests: a.total_requests || 0,
        }))
        .sort((x, y) => x.rank - y.rank),
    ]),
  );
  const bench = queries['["rankings","benchmarks"]'] || {};
  const board = (list) =>
    (list || [])
      .map((b) => ({
        slug: b.openrouter_slug || b.heuristic_openrouter_slug || stripDate(b.permaslug || ''),
        name: b.aa_name || b.vals_model_label || b.permaslug,
        score: b.score,
      }))
      .filter((b) => b.slug && Number.isFinite(b.score))
      .sort((a, b) => b.score - a.score);
  return {
    period: modelsKey.includes('week') ? 'week' : 'period',
    date: rows[0].date,
    models,
    apps,
    benchmarks: {
      intelligence: board(bench.aaData?.intelligence),
      coding: board(bench.aaData?.coding),
      agentic: board(bench.aaData?.agentic),
      vals: board(bench.valsIndex?.models),
    },
  };
}
// JSON.parse of the object starting at `at` (the payload has trailing RSC text after it).
function decodeAt(text, at) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) {
      try {
        return JSON.parse(text.slice(at, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function createOpenRouter({ cacheDir, getKey = () => null, fetchImpl = fetch, now = Date.now, offline = false }) {
  const mem = new Map();
  const errors = {};
  const inflight = new Map();
  const file = (name) => path.join(cacheDir, `openrouter-${name}.json`);
  const read = (name) => {
    if (mem.has(name)) return mem.get(name);
    try {
      const v = JSON.parse(fs.readFileSync(file(name), 'utf8'));
      mem.set(name, v);
      return v;
    } catch {
      return null;
    }
  };
  const write = (name, value) => {
    mem.set(name, value);
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(`${file(name)}.tmp`, JSON.stringify(value));
      fs.renameSync(`${file(name)}.tmp`, file(name));
    } catch {
      /* cache is optional */
    }
  };

  // Cached value when fresh; otherwise fetch (one request at a time per name), falling back to stale data.
  async function cached(name, ttl, load, persist = true) {
    const hit = persist ? read(name) : mem.get(name);
    if (hit && now() - hit.fetchedAt < ttl) return hit;
    if (offline) return hit || { fetchedAt: null, data: null, error: 'demo mode: not fetched' };
    if (!inflight.has(name)) {
      inflight.set(
        name,
        (async () => {
          try {
            const v = { fetchedAt: now(), data: await load() };
            if (persist) write(name, v);
            else mem.set(name, v);
            delete errors[name];
            return v;
          } catch (err) {
            errors[name] = err.message;
            return hit
              ? { ...hit, stale: true, error: err.message }
              : { fetchedAt: null, data: null, error: err.message };
          } finally {
            inflight.delete(name);
          }
        })(),
      );
    }
    return inflight.get(name);
  }

  const api = {
    models: () =>
      cached('models', TTL.models, async () =>
        ((await getJSON(`${BASE}/api/v1/models`, { fetchImpl })).data || []).map(slimModel),
      ),
    providers: () =>
      cached('providers', TTL.providers, async () =>
        ((await getJSON(`${BASE}/api/v1/providers`, { fetchImpl })).data || []).map((p) => ({
          name: p.name,
          slug: p.slug,
          headquarters: p.headquarters,
          datacenters: p.datacenters || [],
          statusPage: p.status_page_url,
          privacy: p.privacy_policy_url,
        })),
      ),
    rankings: () =>
      cached('rankings', TTL.rankings, async () => {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        try {
          const r = await fetchImpl(`${BASE}/rankings`, { headers: { accept: 'text/html' }, signal: ctl.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status} from /rankings`);
          return parseRankings(await r.text());
        } finally {
          clearTimeout(t);
        }
      }),
    endpoints: (id) => {
      if (!/^[\w.\-~]+\/[\w.\-:]+$/.test(id))
        return Promise.resolve({ fetchedAt: null, data: null, error: 'bad model id' });
      return cached(
        `ep:${id}`,
        TTL.endpoints,
        async () =>
          (
            ((await getJSON(`${BASE}/api/v1/models/${id.replace(/^~/, '')}/endpoints`, { fetchImpl })).data || {})
              .endpoints || []
          ).map(slimEndpoint),
        false,
      );
    },
    // Several models, four requests at a time.
    async endpointsMany(ids) {
      const out = {};
      let i = 0;
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (i < ids.length) {
            const id = ids[i++];
            out[id] = await api.endpoints(id);
          }
        }),
      );
      return out;
    },
    async account() {
      const key = getKey();
      if (!key) return { configured: false };
      const v = await cached(
        'account',
        TTL.account,
        async () => {
          const [credits, info] = await Promise.all([
            getJSON(`${BASE}/api/v1/credits`, { fetchImpl, key }),
            getJSON(`${BASE}/api/v1/key`, { fetchImpl, key }),
          ]);
          const k = info.data || {};
          return {
            totalCredits: credits.data?.total_credits ?? null,
            totalUsage: credits.data?.total_usage ?? null,
            label: k.label || null,
            limit: k.limit ?? null,
            limitRemaining: k.limit_remaining ?? null,
            usage: k.usage ?? null,
            usageDaily: k.usage_daily ?? null,
            usageWeekly: k.usage_weekly ?? null,
            usageMonthly: k.usage_monthly ?? null,
            isFreeTier: !!k.is_free_tier,
          };
        },
        false,
      );
      return { configured: true, ...v };
    },
    errors: () => ({ ...errors }),
  };
  return api;
}

module.exports = { createOpenRouter, parseRankings, slimModel, slimEndpoint, BASE };
