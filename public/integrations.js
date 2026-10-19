'use strict';
/* Integrations: what the MCP server offers to AI clients, whether each connection is healthy,
   which clients have it registered, and the most recent tool calls (argument names only). */

const INTEG_TYPES = {
  acc: ['AI Command Center', 'pulse', 'blue'],
  dynatrace: ['Dynatrace', 'zap', 'violet'],
  arize: ['Arize', 'sparkle', 'green'],
  n8n: ['n8n', 'layers', 'amber'],
  router: ['AI router', 'cube', 'blue'],
  http: ['HTTP API', 'code', 'violet'],
  mcp: ['MCP proxy', 'plug', 'green'],
};
const INTEG_STATE = {
  ok: ['running', 'Connected'],
  error: ['error', 'Error'],
  disabled: ['off', 'Disabled'],
  unchecked: ['idle', 'Not checked'],
};
const integ = { data: null, at: 0, loading: false, filter: 'all', testing: null };

async function loadIntegrations() {
  if (integ.loading) return;
  integ.loading = true;
  try {
    integ.data = await api('/api/integrations');
  } catch (err) {
    integ.data = { error: err.message, integrations: [], clients: [], calls: [] };
  }
  integ.at = Date.now();
  integ.loading = false;
  if (state.route === 'integrations') render(false);
}

function integCard(i) {
  const [label, ic, chip] = INTEG_TYPES[i.type] || [i.type || 'Unknown', 'plug', 'blue'];
  const [cls, text] = INTEG_STATE[i.state] || INTEG_STATE.unchecked;
  return `<div class="card integ-card">
    <div class="card-head"><span class="chip ${chip}">${icon(ic, 16)}</span>
      <div><h3>${esc(i.id)}</h3><div class="meta">${esc(label)}${i.flavor ? ` · ${esc(i.flavor)}` : ''}</div></div>
      <div class="right"><span class="status ${cls}" style="width:auto"><i></i>${text}</span></div></div>
    <div class="integ-stats"><span><b class="num">${i.tools || 0}</b> tools</span>
      ${i.latencyMs != null ? `<span><b class="num">${whole.format(i.latencyMs)}</b> ms</span>` : ''}
      ${i.writeTools ? `<span class="pill integ-write">write on · ${i.writeTools}</span>` : ''}</div>
    ${i.error ? `<p class="integ-error">${esc(i.error)}</p>` : i.detail ? `<p class="kpi-sub">${esc(i.detail)}</p>` : ''}
    <div class="integ-actions"><button class="btn ghost" type="button" data-integ-test="${esc(i.id)}" ${i.state === 'disabled' || integ.testing === i.id ? 'disabled' : ''}>${integ.testing === i.id ? 'Testing…' : 'Test'}</button>
      ${i.id !== 'acc' ? `<button class="btn ghost" type="button" data-integ-edit="${esc(i.id)}">Configure</button>` : ''}</div>
  </div>`;
}

function viewIntegrations() {
  if (!integ.data || Date.now() - integ.at > 60000) loadIntegrations();
  if (!integ.data) return '<div class="skeleton" style="height:260px"></div>';
  const d = integ.data;
  const list = d.integrations || [];
  const okCount = list.filter((i) => i.state === 'ok').length;
  const calls = (d.calls || []).filter((c) => integ.filter === 'all' || c.integration === integ.filter);
  const ids = [...new Set((d.calls || []).map((c) => c.integration))];
  return `<div class="hero"><div><div class="eyebrow">INTEGRATIONS</div><h1>MCP connections</h1>
      <p>${okCount} of ${list.length} connected. AI clients reach these through <code>ai-command-center</code>; edit them in config.json.</p></div>
    <div class="hero-actions"><span class="pill">${icon('refresh', 14)}Checked ${ago(integ.at)}</span></div></div>
    ${d.error ? `<div class="card empty">Could not load integrations: ${esc(d.error)}</div>` : ''}
    <div class="grid integrations">${list.map(integCard).join('')}</div>
    <div class="section-head"><h2>Clients</h2><span class="meta">Where the MCP server is registered</span></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Client</th><th>Status</th><th>Config file</th><th>Register with</th></tr></thead><tbody>
      ${(d.clients || [])
        .map(
          (c) => `<tr><td><b>${esc(c.name)}</b></td>
        <td><span class="status ${c.registered ? 'running' : 'off'}" style="width:auto"><i></i>${c.registered ? 'Registered' : 'Not registered'}</span></td>
        <td class="muted">${esc(c.file)}</td><td><code>${esc(c.command)}</code></td></tr>`,
        )
        .join('')}
    </tbody></table></div>
    ${d.mcpCommand ? `<p class="kpi-sub integ-cmd">Server command: <code>${esc(d.mcpCommand)}</code></p>` : ''}</div>
    <div class="section-head"><h2>Recent tool calls</h2><span class="meta">Argument names only, never values</span>
      <label class="link"><select class="input" data-integ-filter aria-label="Filter by integration"><option value="all">All integrations</option>
        ${ids.map((id) => `<option ${id === integ.filter ? 'selected' : ''}>${esc(id)}</option>`).join('')}</select></label></div>
    <div class="card">${
      calls.length
        ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Tool</th><th>Result</th><th class="r">Duration</th><th>Arguments</th></tr></thead><tbody>
      ${calls
        .slice(0, 100)
        .map(
          (c) => `<tr><td class="num">${fmtDate(c.ts)}</td><td><code>${esc(c.tool)}</code></td>
        <td><span class="status ${c.ok ? 'running' : 'error'}" style="width:auto"><i></i>${c.ok ? 'OK' : 'Error'}</span></td>
        <td class="r num">${whole.format(c.ms)} ms</td><td class="muted">${esc((c.args || []).join(', ') || '–')}</td></tr>`,
        )
        .join('')}
    </tbody></table></div>`
        : '<div class="empty">No tool calls yet. Register a client, then ask it to use an ai-command-center tool.</div>'
    }</div>`;
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-integ-test]');
  if (!b) return;
  const id = b.dataset.integTest;
  integ.testing = id;
  render(false);
  try {
    const s = await api('/api/integrations/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    integ.data.integrations = integ.data.integrations.map((i) => (i.id === id ? s : i));
  } catch (err) {
    integ.data.integrations = integ.data.integrations.map((i) =>
      i.id === id ? { ...i, state: 'error', error: err.message } : i,
    );
  }
  integ.testing = null;
  render(false);
});
document.addEventListener('change', (e) => {
  const s = e.target.closest('[data-integ-filter]');
  if (!s) return;
  integ.filter = s.value;
  render(false);
});
