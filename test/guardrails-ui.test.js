// Gateway guardrails (AI Governance 1) in the dashboard (public/gatewayview.js): the Guardrails panel under Model
// router, the key form's selects and the key chip, a request row's chip, and the two submits. The page script runs in
// a vm context with stand-ins for the shared helpers (public/app.js, public/iso.js); nothing touches a DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

function load() {
  const listeners = {};
  const posts = [];
  const ctx = vm.createContext({
    document: { addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn) },
    matchMedia: () => ({ addEventListener() {} }),
    window: {},
    location: { origin: 'http://127.0.0.1:4777', hash: '' },
    state: { route: 'gateway' },
    esc,
    whole: new Intl.NumberFormat('en'),
    HOLO: { cyan: '#0ff', pink: '#f0f' },
    panel: (title, meta, body) => `<section><h3>${title}</h3><span>${meta}</span>${body}</section>`,
    metricTile: ({ label, value, sub }) =>
      `<div class="tile"><b>${label}</b><i>${value}</i><small>${sub}</small></div>`,
    api: (url, opts) => {
      posts.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return new Promise(() => {});
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'gatewayview.js'), 'utf8'), ctx);
  ctx.gwAct = (fn) => fn();
  const submit = (form) => {
    for (const fn of listeners.submit || []) fn({ target: form, preventDefault: () => {} });
  };
  return { ctx, posts, submit };
}

// A form with its id attribute and controls by name, as the browser gives them to the submit handler.
function form(id, controls, checks = {}) {
  const f = {
    getAttribute: (n) => (n === 'id' ? id : null),
    querySelectorAll: () => [],
    classList: { contains: () => false },
  };
  for (const [name, value] of Object.entries(controls)) f[name] = { value };
  for (const [name, checked] of Object.entries(checks)) f[name] = { checked };
  return f;
}

test('panel: scope and the three modes as selects with the saved values, Save, and this month’s tiles', () => {
  const { ctx } = load();
  const html = ctx.gwGuardPanel({
    settings: { guardrails: { scope: 'all', secrets: 'block', pii: 'redact', injection: 'off' } },
    usage: { totals: { guard: { redacted: 12, blocked: 3, logged: 1234 } } },
  });
  assert.match(html, /<h3>Guardrails<\/h3>/);
  assert.match(html, /<form class="gw-form" id="gw-guard-form">/);
  assert.ok(
    html.includes(
      '<select class="input" name="scope"><option value="external">External providers</option>' +
        '<option value="all" selected>Every provider</option></select>',
    ),
  );
  assert.match(html, /name="secrets">.*<option value="block" selected>block<\/option>/);
  assert.match(html, /name="pii">.*<option value="redact" selected>redact<\/option>/);
  assert.ok(
    html.includes(
      'name="injection"><option value="off" selected>off</option><option value="log">log</option>' +
        '<option value="block">block</option></select>',
    ),
    'injection has nothing to redact',
  );
  assert.match(html, /<b>Requests redacted<\/b><i>12<\/i><small>this month<\/small>/);
  assert.match(html, /<b>Requests blocked<\/b><i>3<\/i>/);
  assert.match(html, /<b>Requests flagged<\/b><i>1,234<\/i>/);
  assert.match(html, /<button class="btn" type="submit">Save<\/button>/);
  assert.match(html, /Home-folder paths are never touched\./);
  // An older server without the fields: the defaults and zeros.
  const empty = ctx.gwGuardPanel({ usage: { totals: {} } });
  assert.match(empty, /name="secrets">.*<option value="redact" selected>/);
  assert.match(empty, /<b>Requests blocked<\/b><i>0<\/i>/);
});

test('keys: three selects with default, a chip for a key with its own modes, and the create body', () => {
  const { ctx, posts, submit } = load();
  const sel = ctx.gwGuardKeySelects();
  for (const n of ['guard-secrets', 'guard-pii', 'guard-injection'])
    assert.match(sel, new RegExp(`name="${n}"><option value="" selected>default</option>`));
  assert.equal(ctx.gwGuardKeyChip({ guardrails: {} }), '');
  assert.equal(ctx.gwGuardKeyChip({}), '');
  assert.equal(
    ctx.gwGuardKeyChip({ guardrails: { secrets: 'block', pii: 'redact' } }),
    ' <span class="tag warn" title="Secrets: block · Personal data: redact">own guardrails</span>',
  );
  submit(
    form(
      'gw-key-form',
      { name: 'app', 'guard-secrets': 'block', 'guard-pii': '', 'guard-injection': 'log' },
      { approveOwnRuns: false, privateOnly: false },
    ),
  );
  assert.equal(posts[0].url, '/api/gateway/keys');
  assert.deepEqual(posts[0].body.guardrails, { secrets: 'block', pii: '', injection: 'log' });
});

test('request rows: a chip named after the action, the labels in its title, escaped', () => {
  const { ctx } = load();
  assert.equal(ctx.gwGuardChip(undefined), '');
  assert.equal(ctx.gwGuardChip({ action: 'weird' }), '');
  assert.equal(
    ctx.gwGuardChip({ action: 'redacted', hits: [{ check: 'secrets', label: 'GitHub token', count: 2 }] }),
    ' <span class="tag" title="Secrets: GitHub token ×2">redacted</span>',
  );
  assert.equal(
    ctx.gwGuardChip({ action: 'blocked', hits: [{ check: 'pii', label: '<b>email</b>', count: 1 }] }),
    ' <span class="tag warn" title="Personal data: &lt;b&gt;email&lt;/b&gt; ×1">blocked</span>',
  );
  assert.match(ctx.gwGuardChip({ action: 'logged', hits: [], error: true }), />flagged<\/span>$/);
});

test('save: the Guardrails form posts the four values to the settings route', () => {
  const { posts, submit } = load();
  submit(form('gw-guard-form', { scope: 'all', secrets: 'redact', pii: 'block', injection: 'log' }));
  assert.deepEqual(posts[0], {
    url: '/api/gateway/settings',
    body: { guardrails: { scope: 'all', secrets: 'redact', pii: 'block', injection: 'log' } },
  });
});

test('provider form: the tier shows Automatic unless the owner chose one, and says when guardrails count it external', () => {
  const { ctx } = load();
  const lite = { label: 'LiteLLM proxy', local: true, forwards: true };
  const auto = ctx.gwTierSelect({ originalId: 'lite', preset: 'litellm', tier: 'private', tierAuto: true }, lite);
  assert.ok(auto.includes('<option value="">Automatic (private; guardrails check it as external)</option>'));
  assert.ok(!auto.includes('selected'), 'Automatic, the first option');
  const mine = ctx.gwTierSelect({ originalId: 'lite', preset: 'litellm', tier: 'private', tierAuto: false }, lite);
  assert.ok(mine.includes('<option value="private" selected>'));
  const oll = ctx.gwTierSelect({ preset: 'ollama' }, { label: 'Ollama', local: true });
  assert.ok(oll.includes('<option value="">Automatic (private)</option>'));
  assert.ok(!oll.includes('selected'));
});
