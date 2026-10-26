// Add, edit, remove and dry-run integrations from the dashboard. Each type has a field schema the
// page builds its form from; a submitted form is validated into a config.json entry. Secret fields
// never hold values in config.json: the form either keeps the current reference, points at a
// secret-store item or environment variable, or pastes a value that is saved in this OS's secret
// store (macOS Keychain, Linux keyring or the encrypted secret file; never on a command line).
const fs = require('fs');
const crypto = require('crypto');
const { defaultStore } = require('./secret-store');
const { checkRef } = require('./secrets');
const { keepsSecret, secretMove, moveReason } = require('./secret-binding');
const { joinUrl, checkPath } = require('./connectors/base');
const { createIntegrations, DEFAULT_CONNECTORS } = require('./integrations');

const ID = /^[a-z0-9-]{1,32}$/;
const URL_RE = /^https?:\/\/[^\s]+$/;
const SECRET_REF = /^[\w.\-]{1,80}$/;

// kind: url | text | secret | select | json | list. `at` is the path inside the entry (auth.secret).
const TYPES = {
  dynatrace: {
    label: 'Dynatrace',
    hint: 'SaaS or Managed environment, API v2 and DQL',
    fields: [
      {
        key: 'baseUrl',
        label: 'Environment URL',
        kind: 'url',
        required: true,
        placeholder: 'https://abc12345.live.dynatrace.com',
      },
      {
        key: 'token',
        label: 'API token',
        kind: 'secret',
        required: true,
        help: 'Scopes: problems.read, entities.read, metrics.read, logs.read, securityProblems.read',
      },
      {
        key: 'platformUrl',
        label: 'Platform URL (SaaS, for DQL)',
        kind: 'url',
        placeholder: 'https://abc12345.apps.dynatrace.com',
      },
      { key: 'platformToken', label: 'Platform token (SaaS, for DQL)', kind: 'secret' },
    ],
  },
  arize: {
    label: 'Arize',
    hint: 'Phoenix (open source or cloud) or Arize AX',
    fields: [
      { key: 'flavor', label: 'Flavor', kind: 'select', options: ['phoenix', 'ax'], default: 'phoenix' },
      {
        key: 'baseUrl',
        label: 'Base URL',
        kind: 'url',
        placeholder: 'http://localhost:6006',
        help: 'Leave empty for the default of the flavor',
      },
      { key: 'apiKey', label: 'API key', kind: 'secret', help: 'Optional for a local Phoenix' },
    ],
  },
  n8n: {
    label: 'n8n',
    hint: 'Workflows and executions; webhooks when writes are on',
    fields: [
      { key: 'baseUrl', label: 'n8n URL', kind: 'url', required: true, placeholder: 'http://localhost:5678' },
      { key: 'apiKey', label: 'API key', kind: 'secret', required: true },
      {
        key: 'webhooks',
        label: 'Allowlisted webhooks',
        kind: 'json',
        shape: 'object',
        placeholder: '{ "daily-report": "http://localhost:5678/webhook/daily-report" }',
      },
    ],
  },
  router: {
    label: 'AI router',
    hint: 'OmniRoute or 9router',
    fields: [
      { key: 'flavor', label: 'Flavor', kind: 'select', options: ['omniroute', '9router'], default: 'omniroute' },
      { key: 'baseUrl', label: 'Router URL', kind: 'url', placeholder: 'http://localhost:20128' },
      { key: 'apiKey', label: 'API key (/v1)', kind: 'secret' },
      {
        key: 'managementToken',
        label: 'Management token (OmniRoute)',
        kind: 'secret',
        help: 'omniroute tokens create --scope read',
      },
    ],
  },
  http: {
    label: 'HTTP API',
    hint: 'Any REST API; one tool per endpoint',
    fields: [
      { key: 'baseUrl', label: 'Base URL', kind: 'url', required: true, placeholder: 'https://api.example.com' },
      { key: 'authHeader', at: 'auth.header', label: 'Auth header', kind: 'text', placeholder: 'Authorization' },
      { key: 'authPrefix', at: 'auth.prefix', label: 'Auth prefix', kind: 'text', placeholder: 'Bearer ' },
      { key: 'authSecret', at: 'auth.secret', label: 'Auth secret', kind: 'secret' },
      { key: 'healthPath', label: 'Health path', kind: 'text', placeholder: '/api/health' },
      { key: 'headers', label: 'Extra headers', kind: 'json', shape: 'object', placeholder: '{ "x-team": "ops" }' },
      {
        key: 'endpoints',
        label: 'Endpoints',
        kind: 'json',
        shape: 'array',
        required: true,
        placeholder: '[{ "name": "list_items", "method": "GET", "path": "/api/items", "description": "List items" }]',
      },
    ],
  },
  openrouter: {
    label: 'OpenRouter',
    hint: 'Model catalog, provider uptime and rankings; credits with a key',
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'secret',
        help: 'Optional. Only needed for credits and key limits; everything else is public.',
      },
    ],
  },
  mcp: {
    label: 'MCP server',
    hint: 'Any Streamable HTTP MCP server, tools proxied under a prefix',
    fields: [
      {
        key: 'url',
        label: 'MCP endpoint URL',
        kind: 'url',
        required: true,
        placeholder: 'http://localhost:20128/api/mcp/stream',
      },
      { key: 'authPrefix', at: 'auth.prefix', label: 'Auth prefix', kind: 'text', placeholder: 'Bearer ' },
      { key: 'authSecret', at: 'auth.secret', label: 'Auth secret', kind: 'secret' },
      { key: 'include', label: 'Include tools (globs)', kind: 'list', placeholder: '*health*, *usage*' },
      { key: 'exclude', label: 'Exclude tools (globs)', kind: 'list', placeholder: '*delete*' },
    ],
  },
};

// Where each type sends its secrets when no URL is set: the connectors' own defaults (lib/connectors).
const DEFAULT_URLS = {
  arize: (e) => ((e.flavor || 'phoenix') === 'ax' ? 'https://api.arize.com' : 'http://localhost:6006'),
  router: () => 'http://localhost:20128',
  openrouter: () => 'https://openrouter.ai',
};
const FLAVORS = { arize: 'phoenix', router: 'omniroute' };

// Every address an entry calls with its secrets, defaults applied: its URL fields, the built-in URL
// when none is set, and for the HTTP type each health and endpoint path resolved against baseUrl.
// n8n webhooks are left out: they are called without the API key.
function entryAddresses(entry) {
  const t = TYPES[entry.type];
  const urls = (t ? t.fields : []).filter((f) => f.kind === 'url').map((f) => getAt(entry, f.at || f.key));
  if (DEFAULT_URLS[entry.type] && !entry.baseUrl) urls.push(DEFAULT_URLS[entry.type](entry));
  if (entry.type === 'http' && typeof entry.baseUrl === 'string') {
    const paths = [
      entry.healthPath,
      ...(Array.isArray(entry.endpoints) ? entry.endpoints : []).map((e) => e && e.path),
    ];
    for (const p of paths.filter((x) => x !== undefined)) {
      try {
        urls.push(joinUrl(entry.baseUrl, p));
      } catch {
        urls.push(`invalid:${p}`);
      }
    }
  }
  const flavor = FLAVORS[entry.type] ? entry.flavor || FLAVORS[entry.type] : '';
  return { kind: `${entry.type}:${flavor}`, urls };
}

const getAt = (obj, at) => at.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setAt(obj, at, value) {
  const keys = at.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {};
  o[keys[keys.length - 1]] = value;
}

// The schema the page renders, plus each entry's current values with secrets shown as references.
function describe(integrations) {
  const entries = Object.entries(integrations || {}).map(([id, cfg]) => {
    const t = TYPES[cfg.type];
    const values = {};
    for (const f of t ? t.fields : []) {
      const v = getAt(cfg, f.at || f.key);
      if (v === undefined) continue;
      values[f.key] =
        f.kind === 'secret'
          ? v && typeof v === 'object'
            ? v.keychain
              ? { keychain: v.keychain }
              : v.env
                ? { env: v.env }
                : null
            : null
          : f.kind === 'json'
            ? JSON.stringify(v, null, 2)
            : f.kind === 'list'
              ? Array.isArray(v)
                ? v.join(', ')
                : ''
              : v;
    }
    return {
      id,
      type: cfg.type,
      enabled: cfg.enabled !== false,
      allowWrite: cfg.allowWrite === true,
      editable: !!t,
      values,
    };
  });
  return { types: TYPES, entries };
}

// Form → config.json entry. `secret(id, field, input, current)` turns one secret input into a reference.
function buildEntry(form, current, secret) {
  const errors = [];
  const id = String(form.id || '').trim();
  if (!ID.test(id)) errors.push('id: use 1-32 lowercase letters, digits or dashes');
  if (id === 'acc') errors.push('id: "acc" is reserved for the dashboard itself');
  const t = TYPES[form.type];
  if (!t) return { errors: [...errors, `type: must be one of ${Object.keys(TYPES).join(', ')}`] };
  const entry = { type: form.type };
  if (form.enabled === false) entry.enabled = false;
  if (form.allowWrite === true) entry.allowWrite = true;
  const values = form.values || {};
  for (const f of t.fields) {
    const raw = values[f.key];
    let v;
    if (f.kind === 'secret') {
      try {
        v = secret(id, f, raw, current ? getAt(current, f.at || f.key) : undefined);
      } catch (err) {
        errors.push(`${f.label}: ${err.message}`);
        continue;
      }
    } else if (f.kind === 'json') {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text) {
        try {
          v = JSON.parse(text);
        } catch {
          errors.push(`${f.label}: not valid JSON`);
          continue;
        }
        if (f.shape === 'array' ? !Array.isArray(v) : typeof v !== 'object' || Array.isArray(v) || v === null) {
          errors.push(`${f.label}: must be a JSON ${f.shape}`);
          continue;
        }
      }
    } else if (f.kind === 'list') {
      const list = String(raw || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      if (list.length) v = list;
    } else {
      const text = typeof raw === 'string' ? raw.trim() : raw;
      if (text !== '' && text != null) v = f.kind === 'text' && f.key === 'authPrefix' ? raw : text; // keep the space in "Bearer "
      if (v !== undefined && f.kind === 'url' && !URL_RE.test(v)) {
        errors.push(`${f.label}: must start with http:// or https://`);
        continue;
      }
      if (v !== undefined && f.kind === 'select' && !f.options.includes(v)) {
        errors.push(`${f.label}: must be one of ${f.options.join(', ')}`);
        continue;
      }
      if (v === undefined && f.default !== undefined) v = f.default;
    }
    if (v === undefined || v === null) {
      if (f.required) errors.push(`${f.label}: required`);
      continue;
    }
    setAt(entry, f.at || f.key, v);
  }
  // Settings the form does not show (e.g. hand-written ones) survive an edit.
  if (current && current.type === form.type) {
    for (const [k, v] of Object.entries(current))
      if (
        !(k in entry) &&
        !['enabled', 'allowWrite'].includes(k) &&
        !t.fields.some((f) => (f.at || f.key).split('.')[0] === k)
      )
        entry[k] = v;
  }
  // Paths of the HTTP type stay under baseUrl (lib/connectors/base.js refuses the others at run time too).
  if (form.type === 'http') {
    const eps = Array.isArray(entry.endpoints) ? entry.endpoints : [];
    for (const [label, p] of [
      ['Health path', entry.healthPath],
      ...eps.map((e, i) => [`Endpoints[${i}].path`, e && e.path]),
    ])
      if (typeof p === 'string')
        try {
          checkPath(p);
        } catch (err) {
          errors.push(`${label}: ${err.message}`);
        }
  }
  // A kept secret must not follow the integration anywhere new: re-enter it when the type or flavor
  // changes, or when any address it is sent to (defaults included) is not one it was saved for.
  if (current) {
    const move = secretMove(entryAddresses(current), entryAddresses(entry));
    if (move)
      for (const f of t.fields) {
        if (f.kind === 'secret' && keepsSecret(values[f.key], getAt(current, f.at || f.key)))
          errors.push(
            `${f.label}: ${moveReason(move)}, so enter the secret again (a stored secret only goes to its own address)`,
          );
      }
  }
  return { id, entry, errors };
}

// Secret input modes: keep | none | keychain {service} | env {name} | store {value}.
function secretResolver({ store, draft = false }) {
  return (id, f, input, current) => {
    const mode = input && input.mode ? input.mode : current ? 'keep' : 'none';
    if (mode === 'keep') {
      if (!current) return undefined;
      return current;
    }
    if (mode === 'none') return undefined;
    if (mode === 'keychain' || mode === 'env') {
      const bad = checkRef(mode === 'keychain' ? { keychain: input.service || '' } : { env: input.name || '' });
      if (bad && (input.service || input.name)) throw new Error(bad);
      // Through the dashboard a reference can only stay what it is. Pointing an entry (perhaps a new one,
      // at a new address) at a secret saved for something else, or at an environment variable, would send
      // that secret wherever the entry points; such references are written in config.json by hand.
      const same =
        current &&
        (mode === 'keychain' ? current.keychain === input.service : current.env === input.name) &&
        (input.service || input.name);
      if (!same)
        throw new Error(
          'to use an existing secret item or an environment variable, add the reference to config.json by hand; here, paste the secret instead',
        );
    }
    if (mode === 'keychain') {
      if (!SECRET_REF.test(input.service || '')) throw new Error('Keychain service name is missing or invalid');
      return { keychain: input.service };
    }
    if (mode === 'env') {
      if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(input.name || '')) throw new Error('environment variable name is invalid');
      return { env: input.name };
    }
    if (mode === 'store') {
      const value = String(input.value || '');
      if (!value) {
        if (f.required) throw new Error('paste the secret to store it');
        return undefined;
      }
      if (draft) return { draft: value }; // dry run: used in memory, never stored
      const service = `acc.${id}${f.key === 'token' || f.key === 'apiKey' || f.key === 'authSecret' ? '' : `-${f.key}`}`;
      store(service, value);
      return { keychain: service };
    }
    throw new Error(`unknown secret mode "${mode}"`);
  };
}

// Saves a pasted secret in this OS's secret store (Keychain, keyring or encrypted file; lib/secret-store.js).
function keychainStore(service, value) {
  defaultStore().set(service, value);
}

// For the page: a file that does not read lists no integrations.
function readConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
// For a change: config.json holds every other section too (the budgets, the cost centers), so a file that is there but
// does not parse as an object (a hand edit gone wrong) is refused with 409, never written over. An absent or empty
// file starts empty. Messages hold no path.
const CONFIG_BROKEN = 'config.json could not be read; fix it first';
function readForChange(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw Object.assign(new Error(CONFIG_BROKEN), { status: 409 });
  }
  if (!text.trim()) return {};
  let v = null;
  try {
    v = JSON.parse(text);
  } catch {
    v = null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Object.assign(new Error(CONFIG_BROKEN), { status: 409 });
  return v;
}
// As saveConfigSections in server.js: a temp file of its own (two saves never share one), created 0600 and never an
// existing file ('wx'), synced, then a rename.
function writeConfig(file, cfg) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(cfg, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch {
    if (fd !== null)
      try {
        fs.closeSync(fd);
      } catch {
        /* already failing */
      }
    fs.rmSync(tmp, { force: true });
    throw Object.assign(new Error('the settings could not be saved'), { status: 500 });
  }
}

function createIntegrationConfig({ file, secrets, store = keychainStore, connectors = DEFAULT_CONNECTORS }) {
  return {
    describe: () => describe(readConfig(file).integrations),
    save(form) {
      const cfg = readForChange(file);
      const all = cfg.integrations && typeof cfg.integrations === 'object' ? cfg.integrations : {};
      const originalId = form.originalId && all[form.originalId] ? form.originalId : null;
      if (!originalId && all[form.id]) return { errors: [`id: an integration called "${form.id}" already exists`] };
      if (originalId && form.id !== originalId && all[form.id]) return { errors: [`id: "${form.id}" is already used`] };
      const built = buildEntry(form, originalId ? all[originalId] : null, secretResolver({ store }));
      if (built.errors.length) return { errors: built.errors };
      const next = {};
      for (const [k, v] of Object.entries(all))
        next[k === originalId ? built.id : k] = k === originalId ? built.entry : v; // keep order on rename
      if (!originalId) next[built.id] = built.entry;
      writeConfig(file, { ...cfg, integrations: next });
      return { id: built.id, entry: built.entry };
    },
    remove(id) {
      const cfg = readForChange(file);
      if (!cfg.integrations || !cfg.integrations[id]) return { errors: [`no integration called "${id}"`] };
      delete cfg.integrations[id];
      writeConfig(file, cfg);
      return { id };
    },
    // Dry run of a form: builds just this connector with draft secrets kept in memory, then checks health.
    async test(form) {
      const cfg = readConfig(file);
      const all = cfg.integrations || {};
      const current = form.originalId ? all[form.originalId] : null;
      const built = buildEntry({ ...form, enabled: true }, current, secretResolver({ store: () => {}, draft: true }));
      if (built.errors.length) return { errors: built.errors };
      const drafts = new Set();
      const draftSecrets = {
        resolve(ref, field) {
          if (ref && typeof ref === 'object' && 'draft' in ref) {
            drafts.add(ref.draft);
            return ref.draft;
          }
          return secrets.resolve(ref, field);
        },
        mask(text) {
          let s = secrets.mask(text);
          for (const v of drafts) if (v.length >= 4) s = s.split(v).join('***');
          return s;
        },
      };
      const reg = createIntegrations({
        config: { integrations: { [built.id]: built.entry } },
        secrets: draftSecrets,
        connectors,
      });
      const [status] = await reg.status({ fresh: true, only: built.id });
      const tools =
        status.state === 'ok' || status.state === 'unchecked'
          ? (await reg.listTools()).filter((t) => t.name.startsWith(built.id)).map((t) => t.name)
          : [];
      return { status, tools };
    },
  };
}

module.exports = {
  createIntegrationConfig,
  buildEntry,
  entryAddresses,
  secretResolver,
  keychainStore,
  describe,
  TYPES,
};
