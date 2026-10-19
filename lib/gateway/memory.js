// Session management and memory for the orchestrator.
// Sessions: a conversation (messages, agent, owning key) that expires after 24 h without use.
// Memory: long-term notes (global, per agent or per session) that agents save and that are
// retrieved by keyword overlap and injected into prompts. Stored locally in .data/.
const crypto = require('crypto');

const SESSION_TTL_MS = 24 * 3600 * 1000;
const MAX_MESSAGES = 40;
const MAX_MEMORY = 2000;
const words = (s) =>
  String(s || '')
    .toLowerCase()
    .match(/[a-z0-9À-ɏ]{3,}/g) || [];

function createSessions(store, { now = Date.now } = {}) {
  const data = () => store.get();
  const prune = () => {
    const t = now();
    const before = data().sessions.length;
    data().sessions = data().sessions.filter((s) => t - s.lastActive < SESSION_TTL_MS);
    if (before !== data().sessions.length) store.save();
  };
  const pub = (s) => ({
    id: s.id,
    keyId: s.keyId,
    agent: s.agent,
    title: s.title,
    createdAt: s.createdAt,
    lastActive: s.lastActive,
    messages: s.messages.length,
    expiresAt: s.lastActive + SESSION_TTL_MS,
  });
  return {
    list(keyId) {
      prune();
      return data()
        .sessions.filter((s) => !keyId || s.keyId === keyId)
        .map(pub)
        .sort((a, b) => b.lastActive - a.lastActive);
    },
    // An existing session owned by this key, or a new one.
    open(id, { keyId, agent, title }) {
      prune();
      let s = id ? data().sessions.find((x) => x.id === id) : null;
      if (s && s.keyId !== keyId) return { error: 'this session belongs to another key' };
      if (!s) {
        s = {
          id: `ses_${crypto.randomBytes(8).toString('hex')}`,
          keyId,
          agent: agent || null,
          title: String(title || '').slice(0, 80),
          createdAt: now(),
          lastActive: now(),
          messages: [],
        };
        data().sessions.push(s);
      }
      return { session: s };
    },
    append(s, ...messages) {
      s.messages.push(
        ...messages.map((m) => ({
          role: m.role,
          content: String(m.content || '').slice(0, 20000),
          ...(m.agent ? { agent: m.agent } : {}),
        })),
      );
      if (s.messages.length > MAX_MESSAGES) s.messages.splice(0, s.messages.length - MAX_MESSAGES);
      s.lastActive = now();
      store.save();
    },
    get(id, keyId) {
      const s = data().sessions.find((x) => x.id === id);
      return s && (!keyId || s.keyId === keyId) ? s : null;
    },
    remove(id, keyId) {
      const s = data().sessions.find((x) => x.id === id);
      if (!s || (keyId && s.keyId !== keyId)) return false;
      data().sessions = data().sessions.filter((x) => x.id !== id);
      store.save(true);
      return true;
    },
  };
}

function createMemory(store, { now = Date.now } = {}) {
  const data = () => store.get();
  return {
    list: ({ scope, q, limit = 200 } = {}) => {
      const ws = words(q);
      return data()
        .memory.filter(
          (m) => (!scope || m.scope === scope) && (!ws.length || ws.some((w) => m.text.toLowerCase().includes(w))),
        )
        .slice(-limit)
        .reverse();
    },
    save({ text, scope = 'global', tags = [], source = 'user' }) {
      const t = String(text || '')
        .trim()
        .slice(0, 2000);
      if (!t) return { error: 'text is required' };
      const m = {
        id: `mem_${crypto.randomBytes(6).toString('hex')}`,
        text: t,
        scope: String(scope).slice(0, 80),
        tags: tags.slice(0, 10).map(String),
        source,
        ts: now(),
      };
      data().memory.push(m);
      if (data().memory.length > MAX_MEMORY) data().memory.shift();
      store.save(true);
      return { memory: m };
    },
    remove(id) {
      const before = data().memory.length;
      data().memory = data().memory.filter((m) => m.id !== id);
      store.save(true);
      return before !== data().memory.length;
    },
    // Notes for a prompt: global ones plus this agent's and this session's, ranked by word overlap.
    recall(query, scopes, limit = 6) {
      const qs = new Set(words(query));
      return data()
        .memory.filter((m) => scopes.includes(m.scope))
        .map((m) => ({
          m,
          score: words(m.text).filter((w) => qs.has(w)).length + (m.scope === scopes[scopes.length - 1] ? 0.5 : 0),
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || b.m.ts - a.m.ts)
        .slice(0, limit)
        .map((x) => x.m);
    },
  };
}

module.exports = { createSessions, createMemory, words, SESSION_TTL_MS };
