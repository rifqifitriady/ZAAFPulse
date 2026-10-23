// The HTTP side of datasets and experiments: /api/datasets/* and /api/experiments/*. server.js puts this behind the
// dashboard sign-in and sends what `route` returns; nothing here touches the socket. A client names a trace turn by
// its opaque key; a saved example links back by key and sealed span id, never by a raw session id or a path (S3).
// With content viewing off no saved text leaves (R7). An external replay model needs the masked preview first (S4).
const crypto = require('crypto');
const { LIMITS } = require('./shape');
const { EXPERIMENT_EVALUATORS, getExperimentEvaluator, summarize } = require('./score');
const { REPLAY_DEFAULTS, previewOf, confirmToken, orderModels } = require('./replay');

const MAX_VALUE = 512; // no key, name, id or model a client sends is longer than this
const MAX_TURN = 1e6;
const MAX_RUN_MODELS = 3;
const MAX_RUN_EXAMPLES = 1000;
const LONG_FIELDS = new Set(['jsonl', 'reference']); // the only body strings that may pass MAX_VALUE
const EXPERIMENT_ID = /^exp_[0-9a-f]{16}$/;
const NDJSON = 'application/x-ndjson; charset=utf-8';
const AUTO_DEFAULTS = { enabled: false, dataset: '', onFail: true, onBad: true };
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

const fail = (status, message) => Object.assign(new Error(message), { status });
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const reply = (status, body, type) => (type ? { status, body, type } : { status, body });
const contentOffError = () => fail(403, 'content viewing is off');

// Any string over MAX_VALUE in a body, outside the fields that hold text by design.
function hasLongString(v, depth = 0, top = true) {
  if (typeof v === 'string') return v.length > MAX_VALUE;
  if (depth > 6 || !v || typeof v !== 'object') return false;
  for (const [k, x] of Object.entries(v)) {
    if (top && LONG_FIELDS.has(k)) continue;
    if (hasLongString(x, depth + 1, false)) return true;
  }
  return false;
}
const onlyKeys = (body, keys) => {
  for (const k of Object.keys(body)) if (!keys.includes(k)) throw fail(400, `unknown field ${k.slice(0, 40)}`);
};
const distinctStrings = (list) => list.every((x) => typeof x === 'string' && x) && new Set(list).size === list.length;

function createDatasetApi({
  datasets,
  experiments,
  runner,
  replay,
  trace,
  contentOff = false,
  settings,
  secret = crypto.randomBytes(16),
  now = Date.now,
  newId = () => 'exp_' + crypto.randomBytes(8).toString('hex'),
  log = (m) => console.error(m),
  limits = LIMITS,
}) {
  let active = null; // the run in progress: { id, dataset, done, total, requests, cost }

  // ---- settings (config.json under "datasets"; only stored values, defaults filled in here) ----
  const stored = () => {
    const s = settings.get();
    return isObject(s) ? s : {};
  };
  function current() {
    const a = isObject(stored().autoAdd) ? stored().autoAdd : {};
    const bool = (k) => (typeof a[k] === 'boolean' ? a[k] : AUTO_DEFAULTS[k]);
    return {
      autoAdd: {
        enabled: bool('enabled'),
        dataset: typeof a.dataset === 'string' ? a.dataset : AUTO_DEFAULTS.dataset,
        onFail: bool('onFail'),
        onBad: bool('onBad'),
      },
    };
  }
  function settingsPost(body) {
    onlyKeys(body, ['autoAdd']);
    const a = body.autoAdd;
    if (!isObject(a)) throw fail(400, 'autoAdd must be an object');
    onlyKeys(a, Object.keys(AUTO_DEFAULTS));
    for (const k of ['enabled', 'onFail', 'onBad']) {
      if (a[k] !== undefined && typeof a[k] !== 'boolean') throw fail(400, `${k} must be true or false`);
    }
    if (a.dataset !== undefined && typeof a.dataset !== 'string') throw fail(400, 'dataset must be a slug');
    const next = { ...current().autoAdd, ...a };
    // Checked when this request turns it on or points it elsewhere, so a later delete does not lock the settings.
    const touched = a.enabled !== undefined || a.dataset !== undefined;
    if (touched && next.enabled && !datasets.get(next.dataset)) throw fail(400, 'choose an existing dataset');
    settings.save({ ...stored(), autoAdd: next });
    return reply(200, current());
  }

  // ---- shapes ----
  // A saved example for a client. The link names the session by its trace key (null once the session is gone) and
  // the span by its sealed id; the raw ids stay in the store. `keys` caches keyFor within one response.
  function rowOf(e, keys = new Map()) {
    const s = e.source;
    let link = null;
    if (s) {
      const k = `${s.source}|${s.session}`;
      if (!keys.has(k)) {
        let key = null;
        try {
          key = trace.keyFor(s.source, s.session);
        } catch {
          key = null;
        }
        keys.set(k, key);
      }
      let span = null;
      try {
        span = s.span ? trace.sealSpan(s.span) : null;
      } catch {
        span = null;
      }
      link = { source: s.source, key: keys.get(k), turn: s.turn, span };
    }
    const hide = (t) => (contentOff || t == null ? null : t);
    const input = e.input || {};
    return {
      id: e.id,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      link,
      input: {
        system: hide(input.system),
        messages: (input.messages || []).map((m) => ({
          role: m.role,
          ...(m.name ? { name: m.name } : {}),
          text: hide(m.text),
        })),
        tools: (input.tools || []).map((t) => ({ name: t.name, description: hide(t.description) })),
      },
      output: { text: hide(e.output && e.output.text), model: (e.output && e.output.model) || null },
      reference: e.reference ? { text: hide(e.reference.text) } : null,
      tags: e.tags || [],
      evals: e.evals || {},
      feedback: e.feedback || null,
    };
  }
  // A stored experiment record for a client: the replayed texts go when content viewing is off.
  function recordOf(r) {
    if (!contentOff || !Array.isArray(r.perExample)) return r;
    const perExample = r.perExample.map((x) => {
      if (!x) return x;
      // A provider's error message can echo what it was sent, so it goes with the texts.
      if (!x.output) return { ...x, error: null };
      const p = x.output.proposal;
      return { ...x, error: null, output: { ...x.output, text: null, proposal: p ? { ...p, arguments: null } : null } };
    });
    return { ...r, perExample };
  }

  const need = (slug) => {
    const meta = datasets.get(slug);
    if (!meta) throw fail(404, 'unknown dataset');
    return meta;
  };

  // ---- datasets ----
  const listDatasets = () =>
    reply(200, {
      datasets: datasets.list(),
      limits: { examples: limits.examples, datasets: limits.datasets, fieldChars: limits.field },
      content: !contentOff,
    });
  function createDataset(body) {
    onlyKeys(body, ['name', 'slug']);
    return reply(200, { dataset: datasets.create({ name: body.name, slug: body.slug }) });
  }
  function getDataset(slug) {
    const meta = need(slug);
    const keys = new Map();
    return reply(200, { dataset: meta, examples: datasets.examples(slug).map((e) => rowOf(e, keys)) });
  }
  function renameDataset(slug, body) {
    onlyKeys(body, ['name']);
    return reply(200, { dataset: datasets.rename(slug, body.name) });
  }
  function deleteDataset(slug) {
    if (!datasets.remove(slug)) throw fail(404, 'unknown dataset');
    return reply(200, { deleted: true });
  }

  // Each item is read from the trace (masked there, masked again on save). An item the trace refuses (a gone
  // session, a span not in the turn) is skipped with the trace's own path-free reason; the rest are added.
  async function addExamples(slug, body) {
    if (contentOff) throw contentOffError();
    need(slug);
    onlyKeys(body, ['items']);
    const items = body.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > limits.addItems)
      throw fail(400, `items must list 1 to ${limits.addItems} turns`);
    for (const it of items) {
      if (!isObject(it) || typeof it.key !== 'string' || !it.key) throw fail(400, 'each item needs a session key');
      if (!(Number.isInteger(it.turn) && it.turn >= 0 && it.turn <= MAX_TURN)) throw fail(400, 'bad turn');
      if (it.span != null && typeof it.span !== 'string') throw fail(400, 'span must be a span id');
    }
    const skipped = [];
    const built = [];
    for (let index = 0; index < items.length; index++) {
      const { key, turn, span } = items[index];
      let ex;
      try {
        ex = await trace.example(key, turn, span == null ? undefined : span);
      } catch (e) {
        const status = e && e.status;
        if (!(Number.isInteger(status) && status >= 400 && status < 500)) throw e;
        skipped.push({ index, reason: e.message });
        continue;
      }
      if (!ex) skipped.push({ index, reason: 'this session has no text' });
      else built.push({ index, ex });
    }
    const r = built.length
      ? datasets.add(
          slug,
          built.map((b) => b.ex),
        )
      : { added: [], skipped: [] };
    for (const s of r.skipped) skipped.push({ index: built[s.index].index, reason: s.reason });
    const keys = new Map();
    return reply(200, {
      added: r.added.map((e) => rowOf(e, keys)),
      skipped: skipped.sort((a, b) => a.index - b.index),
    });
  }
  function patchExample(slug, id, body) {
    onlyKeys(body, ['reference', 'tags']);
    return reply(200, { example: rowOf(datasets.update(slug, id, { reference: body.reference, tags: body.tags })) });
  }
  function deleteExample(slug, id) {
    need(slug);
    if (!datasets.removeExample(slug, id)) throw fail(404, 'unknown example');
    return reply(200, { deleted: true });
  }
  // S3: an exported line names its session by trace key and its span by sealed id, as the rows do; the raw ids stay
  // in the store. A session this server no longer lists exports with no source. Keys are bound to the server process,
  // so the link survives an export and import on the same running server only.
  function exportDataset(slug) {
    if (contentOff) throw contentOffError();
    need(slug);
    const keys = new Map();
    const text = datasets
      .examples(slug)
      .map((e) => {
        const link = rowOf(e, keys).link;
        const source =
          link && link.key ? { source: link.source, key: link.key, turn: link.turn, span: link.span } : null;
        return JSON.stringify({ ...e, source }) + '\n';
      })
      .join('');
    return reply(200, text, NDJSON);
  }
  // An exported source ({ source, key, turn, span }) is turned back into a stored one when the key resolves here:
  // the real session is restored and the span dropped (a sealed id cannot be unsealed). An unknown key imports the
  // example with no source. Lines are rewritten one for one, so the store's reasons keep their line numbers.
  function importSource(line) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      return line; // the store reports it
    }
    const s = isObject(raw) ? raw.source : null;
    if (!isObject(s) || typeof s.key !== 'string') return line;
    let source = null;
    try {
      const { source: name, sid } = trace.sourceOf(s.key);
      source = { source: name, session: sid, turn: s.turn, span: null };
    } catch {
      source = null;
    }
    return JSON.stringify({ ...raw, source });
  }
  function importDataset(body) {
    onlyKeys(body, ['slug', 'name', 'jsonl']);
    const jsonl = typeof body.jsonl === 'string' ? body.jsonl.split(/\r?\n/).map(importSource).join('\n') : body.jsonl;
    return reply(200, datasets.importJsonl({ slug: body.slug, name: body.name, jsonl }));
  }

  // ---- experiments ----
  const progressOf = (a) => ({ done: a.done, total: a.total, requests: a.requests, cost: a.cost });
  const listExperiments = () =>
    reply(200, {
      experiments: experiments.list(),
      running: active ? { id: active.id, dataset: active.dataset, ...progressOf(active) } : null,
      models: replay.models(),
      evaluators: EXPERIMENT_EVALUATORS,
    });
  function getExperiment(id) {
    if (!EXPERIMENT_ID.test(id)) throw fail(404, 'unknown experiment');
    if (active && active.id === id) return reply(200, { id, status: 'running', progress: progressOf(active) });
    const r = experiments.get(id);
    if (!r) throw fail(404, 'unknown experiment');
    return reply(200, recordOf(r));
  }

  // What a start request asks for, checked; nothing is sent anywhere before every check passed.
  function parseRun(body) {
    onlyKeys(body, ['dataset', 'examples', 'models', 'evaluators', 'maxCostUSD', 'maxRequests', 'preview', 'confirm']);
    if (typeof body.dataset !== 'string' || !body.dataset) throw fail(400, 'dataset required');
    const meta = datasets.get(body.dataset);
    if (!meta) throw fail(400, 'unknown dataset');
    const all = datasets.examples(meta.slug);
    let examples = all;
    if (body.examples !== undefined) {
      const ids = body.examples;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_RUN_EXAMPLES)
        throw fail(400, `examples must list 1 to ${MAX_RUN_EXAMPLES.toLocaleString('en-US')} example ids`);
      if (!distinctStrings(ids)) throw fail(400, 'example ids must be distinct');
      const byId = new Map(all.map((e) => [e.id, e]));
      examples = ids.map((id) => byId.get(id));
      if (examples.some((e) => !e)) throw fail(400, 'unknown example');
    }
    if (!examples.length) throw fail(400, 'the dataset has no examples');

    const models = body.models;
    if (!Array.isArray(models) || models.length < 1 || models.length > MAX_RUN_MODELS)
      throw fail(400, `models must list 1 to ${MAX_RUN_MODELS} models`);
    if (!distinctStrings(models)) throw fail(400, 'models must be distinct');
    models.forEach((m, i) => {
      const tier = replay.tierOf(m);
      if (!tier) throw fail(400, `models[${i}] is not a provider/model of the gateway`);
      if (tier === 'external' && !replay.priced(m))
        throw fail(400, `models[${i}] has no known price, so the cost cap cannot apply`);
    });

    const evaluators = body.evaluators;
    if (!Array.isArray(evaluators) || evaluators.length < 1 || evaluators.length > EXPERIMENT_EVALUATORS.length)
      throw fail(400, `evaluators must list 1 to ${EXPERIMENT_EVALUATORS.length} evaluators`);
    if (!distinctStrings(evaluators) || !evaluators.every((id) => getExperimentEvaluator(id)))
      throw fail(400, 'unknown or repeated evaluator');

    // R8: the replay caps.
    const maxCostUSD = body.maxCostUSD === undefined ? REPLAY_DEFAULTS.maxCostUSD : body.maxCostUSD;
    if (!(typeof maxCostUSD === 'number' && Number.isFinite(maxCostUSD) && maxCostUSD > 0 && maxCostUSD <= 10))
      throw fail(400, 'maxCostUSD must be more than 0 and at most 10');
    const maxRequests = body.maxRequests === undefined ? REPLAY_DEFAULTS.maxRequests : body.maxRequests;
    if (!(Number.isInteger(maxRequests) && maxRequests >= 1 && maxRequests <= 1000))
      throw fail(400, 'maxRequests must be a whole number from 1 to 1000');

    if (body.preview !== undefined && typeof body.preview !== 'boolean')
      throw fail(400, 'preview must be true or false');
    if (body.confirm !== undefined && typeof body.confirm !== 'string') throw fail(400, 'confirm must be text');
    return { meta, examples, models, evaluators, maxCostUSD, maxRequests };
  }

  function postExperiment(body) {
    const run = parseRun(body);
    const { meta, examples, models } = run;
    const external = models.filter((m) => replay.tierOf(m) === 'external');
    const token = confirmToken(secret, { dataset: meta.slug, exampleIds: examples.map((e) => e.id), models });
    // The preview is what an external provider would receive for the first example: the masked messages and the
    // declared tools ({ model, messages, tools }), so content.
    if (body.preview === true) {
      if (contentOff) throw contentOffError();
      return reply(200, {
        preview: external.map((m) => previewOf(examples[0], m, { external: true })),
        confirm: token,
      });
    }
    if (external.length && body.confirm !== token) {
      return reply(428, { error: 'preview what will be sent first', preview: true });
    }
    if (active) throw fail(409, 'another experiment is running');
    return reply(202, { id: start(run), status: 'running' });
  }

  // The run goes on after the reply. Its record is appended when it ends; a runner failure is logged (without its
  // message, which might name a path) and kept as a stopped record, so the page sees what happened.
  function start({ meta, examples, models, evaluators, maxCostUSD, maxRequests }) {
    const id = newId();
    const startedAt = now();
    const run = { id, dataset: meta.slug, done: 0, total: examples.length * models.length, requests: 0, cost: 0 };
    active = run;
    const onProgress = (p) => {
      if (!isObject(p)) return;
      for (const k of ['done', 'total', 'requests', 'cost']) if (Number.isFinite(p[k])) run[k] = p[k];
    };
    Promise.resolve()
      .then(() => runner.run({ id, dataset: meta, examples, models, evaluators, maxCostUSD, maxRequests, onProgress }))
      .catch((e) => {
        log(`datasets: an experiment run failed (status ${(e && e.status) || 'unknown'})`);
        const ordered = orderModels(models, replay.tierOf);
        return {
          id,
          dataset: meta.slug,
          datasetName: meta.name,
          models: ordered,
          evaluators,
          startedAt,
          endedAt: now(),
          status: 'stopped',
          stopped: 'error',
          caps: { maxCostUSD, maxRequests },
          usage: { requests: run.requests, cost: run.cost },
          perExample: [],
          summary: summarize([], { models: ordered, evaluators, examples }),
        };
      })
      .then((record) => {
        try {
          experiments.append(record);
        } catch {
          log('datasets: could not store an experiment record');
        }
      })
      .finally(() => {
        if (active === run) active = null;
      });
    return id;
  }

  // ---- routing ----
  // The handlers for a path, by method, or null for a path under our prefixes that names nothing.
  function match(seg) {
    const [top, a, b, c, ...rest] = seg;
    if (rest.length || seg.some((x) => x === '')) return null;
    if (top === 'datasets') {
      if (a === undefined) return { GET: listDatasets, POST: createDataset };
      if (a === 'settings' && b === undefined) return { GET: () => reply(200, current()), POST: settingsPost };
      if (a === 'import' && b === undefined) return { POST: importDataset };
      if (b === undefined)
        return { GET: () => getDataset(a), PUT: (body) => renameDataset(a, body), DELETE: () => deleteDataset(a) };
      if (b === 'examples' && c === undefined) return { POST: (body) => addExamples(a, body) };
      if (b === 'examples') return { PATCH: (body) => patchExample(a, c, body), DELETE: () => deleteExample(a, c) };
      if (b === 'export' && c === undefined) return { GET: () => exportDataset(a) };
      return null;
    }
    if (a === undefined) return { GET: listExperiments, POST: postExperiment };
    if (b === undefined) return { GET: () => getExperiment(a) };
    return null;
  }

  // `req` is { method, path, query, contentType, readBody(max) }. Returns { status, body, type? }, or null when the
  // path is not ours, so server.js can go on to the next route.
  async function route(req) {
    const p = req.path;
    const ours = ['/api/datasets', '/api/experiments'].some((x) => p === x || p.startsWith(`${x}/`));
    if (!ours) return null;
    try {
      const seg = p.split('/').slice(2);
      if (seg.some((x) => x.length > MAX_VALUE)) throw fail(400, 'path value too long');
      for (const v of req.query ? req.query.values() : [])
        if (v.length > MAX_VALUE) throw fail(400, 'query value too long');
      const handlers = match(seg);
      if (!handlers) return reply(404, { error: 'unknown route' });
      const fn = Object.hasOwn(handlers, req.method) ? handlers[req.method] : null;
      if (!fn) return reply(405, { error: 'method not allowed' });
      if (!BODY_METHODS.has(req.method)) return await fn();
      // A state change needs JSON, so a simple cross-site form post cannot make one.
      if (!(req.contentType || '').startsWith('application/json')) return reply(415, { error: 'json only' });
      let body;
      try {
        body = JSON.parse(await req.readBody(p === '/api/datasets/import' ? limits.importBytes : undefined));
      } catch (e) {
        return reply(e && e.message === 'too large' ? 413 : 400, { error: 'bad request body' });
      }
      if (!isObject(body)) return reply(400, { error: 'bad request body' });
      if (hasLongString(body)) throw fail(400, 'a value is longer than 512 characters');
      return await fn(body);
    } catch (e) {
      const status = e && e.status;
      // A message with a status is ours, the store's or the trace registry's and holds no path; anything else is a
      // plain 500. An import's reasons name lines and fields, never their text.
      if (Number.isInteger(status) && status >= 400 && status <= 599) {
        return reply(status, { error: e.message, ...(Array.isArray(e.reasons) ? { reasons: e.reasons } : {}) });
      }
      return reply(500, { error: 'dataset request failed' });
    }
  }

  return { route, settings: current, running: () => (active ? active.id : null) };
}

module.exports = { createDatasetApi };
