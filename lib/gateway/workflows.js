// Workflow automation: saved multi-agent pipelines. Each step names an agent and a prompt template
// ({{input}} is the run input, {{stepN}} the output of step N, {{approval}} the approver's note) and may
// ask for approval first (approve: true). The ready-to-use catalog (workflow-catalog.js) is added on
// start: new catalog workflows appear, unedited built-ins follow catalog updates, and a built-in you
// delete stays deleted until you restore it.
const { CATALOG, CATALOG_VERSION } = require('./workflow-catalog');

const ID = /^[a-z0-9-]{1,40}$/;
const TIERS = ['R0', 'R1', 'R2', 'R3'];

function cleanWorkflow(input = {}, existing = null) {
  const errors = [];
  const id = String(input.id || '').trim();
  if (!ID.test(id)) errors.push('id: 1-40 lowercase letters, digits or dashes');
  const name = String(input.name || '')
    .trim()
    .slice(0, 80);
  if (!name) errors.push('name is required');
  // approve: the run pauses before this step (input-required) until someone approves or rejects it.
  const steps = (Array.isArray(input.steps) ? input.steps : [])
    .map((s) => ({
      agent: String(s.agent || '').trim(),
      prompt: String(s.prompt || '').slice(0, 4000),
      ...(s.approve === true || s.approve === 'true' || s.approve === 'on' ? { approve: true } : {}),
    }))
    .filter((s) => s.agent)
    .slice(0, 10);
  if (!steps.length) errors.push('add at least one step');
  const str = (v, n) =>
    String(v || '')
      .trim()
      .slice(0, n);
  return {
    errors,
    value: {
      id,
      name,
      description: str(input.description, 300),
      steps,
      category: str(input.category, 40) || 'Custom',
      tier: TIERS.includes(input.tier) ? input.tier : steps.some((s) => s.approve) ? 'R2' : 'R1',
      sampleInput: str(input.sampleInput, 1000),
      kpi: str(input.kpi, 200),
      // Catalog fields are kept from the stored workflow; an edit marks a built-in as edited (it stops following catalog updates).
      ...(existing && existing.builtin
        ? { builtin: true, status: existing.status, catalogVersion: existing.catalogVersion, edited: true }
        : {}),
    },
  };
}

function createWorkflows(store) {
  const data = () => store.get();
  const fromCatalog = (c) => ({ ...structuredClone(c), builtin: true, catalogVersion: CATALOG_VERSION });
  // Catalog sync: add new built-ins, update unedited ones, never bring back a deleted one.
  const d = data();
  d.dismissed ||= [];
  if (d.catalogVersion !== CATALOG_VERSION) {
    for (const c of CATALOG) {
      const i = d.workflows.findIndex((w) => w.id === c.id);
      if (i < 0 && !d.dismissed.includes(c.id)) d.workflows.push(fromCatalog(c));
      else if (i >= 0 && d.workflows[i].builtin && !d.workflows[i].edited) d.workflows[i] = fromCatalog(c);
    }
    d.catalogVersion = CATALOG_VERSION;
    d.seeded = true;
    store.save(true);
  }
  return {
    list: () => data().workflows,
    get: (id) => data().workflows.find((w) => w.id === id),
    catalog: () =>
      CATALOG.map((c) => ({
        id: c.id,
        name: c.name,
        category: c.category,
        status: c.status,
        installed: data().workflows.some((w) => w.id === c.id),
      })),
    save(input) {
      const existing = data().workflows.find((w) => w.id === (input.originalId || input.id));
      const { errors, value } = cleanWorkflow(input, existing);
      if (errors.length) return { errors };
      if (!existing && data().workflows.some((w) => w.id === value.id))
        return { errors: [`a workflow called "${value.id}" already exists`] };
      if (existing) {
        for (const k of Object.keys(existing)) delete existing[k];
        Object.assign(existing, value);
      } else data().workflows.push(value);
      store.save(true);
      return { workflow: existing || value };
    },
    remove(id) {
      const w = data().workflows.find((x) => x.id === id);
      if (!w) return false;
      data().workflows = data().workflows.filter((x) => x.id !== id);
      if (w.builtin && !data().dismissed.includes(id)) data().dismissed.push(id);
      store.save(true);
      return true;
    },
    // Back to the catalog version (also brings back a deleted built-in).
    restore(id) {
      const c = CATALOG.find((x) => x.id === id);
      if (!c) return null;
      data().dismissed = data().dismissed.filter((x) => x !== id);
      const i = data().workflows.findIndex((w) => w.id === id);
      if (i >= 0) data().workflows[i] = fromCatalog(c);
      else data().workflows.push(fromCatalog(c));
      store.save(true);
      return data().workflows.find((w) => w.id === id);
    },
  };
}

module.exports = { createWorkflows, cleanWorkflow, CATALOG };
