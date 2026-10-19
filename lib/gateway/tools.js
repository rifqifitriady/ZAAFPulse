// Connect AI coding tools to the gateway. Each tool speaks one wire format (Anthropic Messages, OpenAI
// Responses, Gemini or OpenAI Chat) and reads its endpoint from its own config. For every tool there is a
// ready snippet; for tools configured by a file (Claude Code, Codex, Gemini CLI, OpenCode, Aider) the
// dashboard can also write that file, with a backup of the original that "Revert" restores. Tools that
// cannot reach a localhost endpoint say so instead of pretending. Writes use mode 0600 because the
// config then holds a ZAAFPulse key (one key per tool, so it can be revoked on its own).
const fs = require('fs');
const os = require('os');
const path = require('path');

const q = (s) => JSON.stringify(String(s));
const TOOLS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    format: 'anthropic',
    file: '.claude/settings.json',
    note: 'Writes ANTHROPIC_BASE_URL and a key into ~/.claude/settings.json. Every Claude Code session on this machine then goes through ZAAFPulse, including the one you may be using now. Anthropic does not support Claude Code with non-Claude models.',
    snippet: (b, k, m) =>
      `// ~/.claude/settings.json\n{\n  "env": {\n    "ANTHROPIC_BASE_URL": ${q(b)},\n    "ANTHROPIC_AUTH_TOKEN": ${q(k)},${m ? `\n    "ANTHROPIC_MODEL": ${q(m)},` : ''}\n    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1"\n  }\n}\n\n# or for one shell only\nANTHROPIC_BASE_URL=${b} ANTHROPIC_AUTH_TOKEN=${k} claude`,
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    vendor: 'OpenAI',
    format: 'responses',
    file: '.codex/config.toml',
    note: 'Adds a "zaafpulse" model provider (Responses API) to ~/.codex/config.toml and makes it the default.',
    snippet: (b, k, m) =>
      `# ~/.codex/config.toml\nmodel_provider = "zaafpulse"\nmodel = ${q(m || 'router/coding')}\n\n[model_providers.zaafpulse]\nname = "ZAAFPulse"\nbase_url = "${b}/v1"\nwire_api = "responses"\nexperimental_bearer_token = ${q(k)}`,
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    vendor: 'Google',
    format: 'gemini',
    file: '.gemini/.env',
    note: 'Sets GOOGLE_GEMINI_BASE_URL, GEMINI_API_KEY and GEMINI_MODEL in ~/.gemini/.env.',
    snippet: (b, k, m) =>
      `# ~/.gemini/.env\nGOOGLE_GEMINI_BASE_URL=${b}\nGEMINI_API_KEY=${k}\nGEMINI_MODEL=${m || 'router/coding'}`,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'SST',
    format: 'openai',
    file: '.config/opencode/opencode.json',
    note: 'Adds a "zaafpulse" provider to ~/.config/opencode/opencode.json and selects it.',
    snippet: (b, k, m) =>
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          model: `zaafpulse/${m || 'router/coding'}`,
          provider: {
            zaafpulse: {
              npm: '@ai-sdk/openai-compatible',
              name: 'ZAAFPulse',
              options: { baseURL: `${b}/v1`, apiKey: k },
              models: { [m || 'router/coding']: {} },
            },
          },
        },
        null,
        2,
      ),
  },
  {
    id: 'aider',
    name: 'Aider',
    vendor: 'Aider',
    format: 'openai',
    file: '.aider.conf.yml',
    note: 'Sets openai-api-base, openai-api-key and model in ~/.aider.conf.yml.',
    snippet: (b, k, m) =>
      `# ~/.aider.conf.yml\nopenai-api-base: ${b}/v1\nopenai-api-key: ${k}\nmodel: openai/${m || 'router/coding'}`,
  },
  {
    id: 'cline',
    name: 'Cline / Roo Code / Kilo Code',
    vendor: 'VS Code extensions',
    format: 'openai',
    snippet: (b, k, m) =>
      `API Provider:  OpenAI Compatible\nBase URL:      ${b}/v1\nAPI Key:       ${k}\nModel ID:      ${m || 'router/coding'}\n\n(or "Anthropic" provider with a custom base URL ${b} for the Messages API)`,
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot (VS Code)',
    vendor: 'GitHub',
    format: 'openai',
    snippet: (b, k, m) =>
      `Chat → Manage Models → Add models → Custom OpenAI-compatible endpoint\nEndpoint: ${b}/v1/chat/completions\nAPI key:  ${k}\nModel:    ${m || 'router/coding'}  (enable tool calling)`,
  },
  {
    id: 'continue',
    name: 'Continue',
    vendor: 'Continue',
    format: 'openai',
    snippet: (b, k, m) =>
      `# ~/.continue/config.yaml\nmodels:\n  - name: ZAAFPulse\n    provider: openai\n    model: ${m || 'router/coding'}\n    apiBase: ${b}/v1\n    apiKey: ${k}\n    roles: [chat, edit, apply]`,
  },
  {
    id: 'zed',
    name: 'Zed',
    vendor: 'Zed',
    format: 'openai',
    snippet: (b, k, m) =>
      `// Zed settings.json\n"language_models": {\n  "openai_compatible": {\n    "ZAAFPulse": {\n      "api_url": "${b}/v1",\n      "available_models": [{ "name": ${q(m || 'router/coding')}, "max_tokens": 128000, "capabilities": { "tools": true } }]\n    }\n  }\n}\n// API key: Agent panel → settings → ZAAFPulse → paste ${k}`,
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    vendor: 'Alibaba',
    format: 'openai',
    snippet: (b, k, m) =>
      `export OPENAI_BASE_URL=${b}/v1\nexport OPENAI_API_KEY=${k}\nexport OPENAI_MODEL=${m || 'router/coding'}\nqwen`,
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    vendor: 'OpenClaw',
    format: 'openai',
    snippet: (b, k, m) =>
      `// openclaw config: models.providers\n"zaafpulse": {\n  "baseUrl": "${b}/v1",\n  "apiKey": ${q(k)},\n  "api": "openai-completions",\n  "models": [{ "id": ${q(m || 'router/coding')}, "name": "ZAAFPulse" }]\n}`,
  },
  {
    id: 'droid',
    name: 'Factory Droid',
    vendor: 'Factory',
    format: 'openai',
    snippet: (b, k, m) =>
      `// ~/.factory/config.json\n{ "custom_models": [ { "model_display_name": "ZAAFPulse", "model": ${q(m || 'router/coding')}, "base_url": "${b}/v1", "api_key": ${q(k)}, "provider": "generic-chat-completion-api", "max_tokens": 16384 } ] }`,
  },
  {
    id: 'scripts',
    name: 'Any OpenAI SDK or script',
    vendor: 'OpenAI-compatible',
    format: 'openai',
    snippet: (b, k, m) =>
      `export OPENAI_BASE_URL=${b}/v1\nexport OPENAI_API_KEY=${k}\n# model: ${m || 'router/coding'}`,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    vendor: 'Anysphere',
    format: 'openai',
    unsupported:
      'Cursor sends custom-key requests from its own servers, so it cannot reach an endpoint on 127.0.0.1. It would need a public tunnel, which this gateway does not open.',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    vendor: 'Google',
    format: 'gemini',
    unsupported:
      'No documented setting for a custom endpoint. Tools that route it intercept its traffic with a root certificate, which ZAAFPulse will not do.',
  },
  {
    id: 'kiro',
    name: 'Kiro',
    vendor: 'AWS',
    format: 'anthropic',
    unsupported:
      'No documented setting for a custom model endpoint. It can still use the ZAAFPulse MCP server (Integrations).',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    vendor: 'Cognition',
    format: 'openai',
    unsupported: 'No documented setting for a custom model endpoint.',
  },
];

function createTools({ home = os.homedir(), fsImpl = fs } = {}) {
  const file = (t) => path.join(home, t.file);
  const backup = (t) => `${file(t)}.zaafpulse-backup`;
  const read = (f) => {
    try {
      return fsImpl.readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  };
  const write = (f, text) => {
    fsImpl.mkdirSync(path.dirname(f), { recursive: true });
    fsImpl.writeFileSync(`${f}.tmp`, text, { mode: 0o600 });
    fsImpl.renameSync(`${f}.tmp`, f);
    try {
      fsImpl.chmodSync(f, 0o600);
    } catch {
      /* best effort */
    }
  };
  const lineSet = (text, key, value, sep) => {
    const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\s*${sep === '=' ? '=' : ':'}.*$`, 'm');
    const line = `${key}${sep === '=' ? '=' : ': '}${value}`;
    return re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, text ? '\n' : '')}${line}\n`;
  };

  // New file contents for a tool, given the current contents (or null).
  const WRITERS = {
    'claude-code': (cur, b, k, m) => {
      let j = {};
      if (cur) {
        try {
          j = JSON.parse(cur);
        } catch {
          throw new Error('~/.claude/settings.json is not valid JSON; fix it first');
        }
      }
      j.env = {
        ...(j.env || {}),
        ANTHROPIC_BASE_URL: b,
        ANTHROPIC_AUTH_TOKEN: k,
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        ...(m ? { ANTHROPIC_MODEL: m } : {}),
      };
      delete j.env.ANTHROPIC_API_KEY;
      return `${JSON.stringify(j, null, 2)}\n`;
    },
    codex: (cur, b, k, m) => {
      let t = cur || '';
      t = t.replace(/^\[model_providers\.zaafpulse\][\s\S]*?(?=^\[|$(?![\s\S]))/m, '');
      const firstTable = t.search(/^\[/m);
      let head = firstTable < 0 ? t : t.slice(0, firstTable);
      const rest = firstTable < 0 ? '' : t.slice(firstTable);
      head = head.replace(/^model_provider\s*=.*\n?/m, '').replace(/^model\s*=.*\n?/m, '');
      return `model_provider = "zaafpulse"\nmodel = ${q(m || 'router/coding')}\n${head.trim() ? `${head.trim()}\n` : ''}\n${rest.trim() ? `${rest.trim()}\n\n` : ''}[model_providers.zaafpulse]\nname = "ZAAFPulse"\nbase_url = "${b}/v1"\nwire_api = "responses"\nexperimental_bearer_token = ${q(k)}\n`;
    },
    'gemini-cli': (cur, b, k, m) =>
      ['GOOGLE_GEMINI_BASE_URL', b, 'GEMINI_API_KEY', k, 'GEMINI_MODEL', m || 'router/coding'].reduce(
        (t, v, i, a) => (i % 2 ? t : lineSet(t, v, a[i + 1], '=')),
        cur || '',
      ),
    opencode: (cur, b, k, m) => {
      let j = {};
      if (cur) {
        try {
          j = JSON.parse(cur);
        } catch {
          throw new Error('opencode.json is not valid JSON; fix it first');
        }
      }
      const model = m || 'router/coding';
      j.$schema ||= 'https://opencode.ai/config.json';
      j.model = `zaafpulse/${model}`;
      j.provider = {
        ...(j.provider || {}),
        zaafpulse: {
          npm: '@ai-sdk/openai-compatible',
          name: 'ZAAFPulse',
          options: { baseURL: `${b}/v1`, apiKey: k },
          models: { [model]: {} },
        },
      };
      return `${JSON.stringify(j, null, 2)}\n`;
    },
    aider: (cur, b, k, m) =>
      ['openai-api-base', `${b}/v1`, 'openai-api-key', k, 'model', `openai/${m || 'router/coding'}`].reduce(
        (t, v, i, a) => (i % 2 ? t : lineSet(t, v, a[i + 1], ':')),
        cur || '',
      ),
  };

  function status(t, base) {
    if (t.unsupported) return { state: 'unsupported' };
    if (!t.file) return { state: 'manual' };
    const cur = read(file(t));
    return {
      state: cur && cur.includes(base) ? 'connected' : 'not connected',
      path: `~/${t.file}`,
      hasBackup: !!read(backup(t)),
    };
  }
  return {
    TOOLS,
    list: (base) =>
      TOOLS.map((t) => ({
        id: t.id,
        name: t.name,
        vendor: t.vendor,
        format: t.format,
        unsupported: t.unsupported || null,
        note: t.note || null,
        canApply: !!WRITERS[t.id],
        ...status(t, base),
      })),
    snippet: (id, base, key, model) => {
      const t = TOOLS.find((x) => x.id === id);
      return t && t.snippet ? t.snippet(base, key, model) : null;
    },
    // Writes the tool's config; the first write keeps the original as a backup (or notes that there was none).
    apply(id, base, key, model) {
      const t = TOOLS.find((x) => x.id === id);
      if (!t || !WRITERS[id]) return { errors: ['this tool is configured by hand; copy the snippet'] };
      // These values land in .env, YAML, TOML and JSON files: one line, no quotes, no shell or YAML syntax,
      // so nothing can add a second setting to the file.
      if (model && !/^[A-Za-z0-9._:/@+-]{1,200}$/.test(String(model)))
        return { errors: ['model: letters, digits and ._:/@+- only'] };
      if (!/^https?:\/\/[A-Za-z0-9.\-[\]:]+(\/[A-Za-z0-9._~\/-]*)?$/.test(String(base)))
        return { errors: ['base URL: not a plain http(s) address'] };
      if (!/^zp_[A-Za-z0-9_-]{20,}$/.test(String(key))) return { errors: ['key: not a ZAAFPulse API key'] };
      const f = file(t);
      const cur = read(f);
      const next = WRITERS[id](cur, base, key, model);
      if (!read(backup(t))) write(backup(t), cur == null ? '\u0000ZAAFPULSE:NO-FILE\u0000' : cur);
      write(f, next);
      return { ok: true, path: `~/${t.file}` };
    },
    revert(id) {
      const t = TOOLS.find((x) => x.id === id);
      if (!t || !t.file) return { errors: ['nothing to revert'] };
      const b = read(backup(t));
      if (b == null) return { errors: ['no backup from ZAAFPulse for this tool'] };
      if (b === '\u0000ZAAFPULSE:NO-FILE\u0000') {
        try {
          fsImpl.unlinkSync(file(t));
        } catch {
          /* already gone */
        }
      } else write(file(t), b);
      fsImpl.unlinkSync(backup(t));
      return { ok: true, path: `~/${t.file}` };
    },
  };
}

module.exports = { createTools, TOOLS };
