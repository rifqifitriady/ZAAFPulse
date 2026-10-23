// The Agent Gateway and Brain pages route form submits by the form's id. A form control named "id" shadows
// form.id in the DOM (form.id is then that input, not the attribute), so these tests load the page scripts in a
// vm context and submit stand-in forms that behave the same way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(file, globals = {}) {
  const listeners = {};
  const ctx = vm.createContext({
    document: { addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn) },
    matchMedia: () => ({ addEventListener() {} }),
    window: {},
    location: { origin: 'http://127.0.0.1:4777', hash: '' },
    ...globals,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), ctx);
  const submit = (form) => {
    let prevented = false;
    for (const fn of listeners.submit || []) fn({ target: form, preventDefault: () => (prevented = true) });
    return prevented;
  };
  return { ctx, submit };
}

// A form whose id attribute is `id`, with controls by name; a control named "id" or "name" shadows the property.
function form(id, controls) {
  const f = { getAttribute: (n) => (n === 'id' ? id : null), classList: { contains: () => false } };
  for (const [name, value] of Object.entries(controls)) f[name] = { value };
  if (!('id' in controls)) f.id = id;
  return f;
}

test('gateway: a form with an "id" field (providers, agents, knowledge bases, workflows) is still handled', () => {
  const { ctx, submit } = load('gatewayview.js', { state: { route: 'gateway' } });
  const acts = [];
  ctx.gwAct = (fn) => acts.push(fn);
  for (const id of ['gw-prov-form', 'gw-agent-form', 'gw-kb-form', 'gw-wf-form']) {
    acts.length = 0;
    const prevented = submit(form(id, { id: 'ollama', name: 'Ollama' }));
    assert.equal(prevented, true, id);
    assert.equal(acts.length, 1, `${id} reaches its handler`);
  }
  // A form without such a field keeps working too.
  acts.length = 0;
  submit(form('gw-key-form', { name: 'app' }));
  assert.equal(acts.length, 1, 'gw-key-form');
});

test('brain: the source form with an "id" field is handled, not submitted by the browser', () => {
  const calls = [];
  const { ctx, submit } = load('brainview.js', {
    state: {},
    api: (url, opts) => {
      calls.push({ url, opts });
      return new Promise(() => {});
    },
  });
  vm.runInContext("brainUi.editing = { type: 'obsidian', originalId: null }; brainUi.types = { obsidian: { fields: [] } };", ctx);
  const prevented = submit(form('brain-src-form', { id: 'notes', name: 'Notes' }));
  assert.equal(prevented, true, 'the browser does not submit the form itself');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/brain/sources');
  assert.equal(JSON.parse(calls[0].opts.body).id, 'notes');
});
