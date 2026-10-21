// Where the agent logs live. Shared by the Claude Code and Codex readers, the dashboard diagnostics and
// `zaafpulse doctor`, so they all agree on the folders.
const fs = require('fs');
const path = require('path');

// "~" and "~/x" mean the given home; the result is absolute.
const expand = (p, home) => path.resolve(String(p).trim().replace(/^~(?=$|[\\/])/, home));

// Each folder once, in the order given.
function dedupe(list) {
  const seen = new Set();
  return list.filter((p) => {
    const k = process.platform === 'win32' ? p.toLowerCase() : p;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

// A comma-separated list of folders from an environment variable (empty entries dropped).
const listOf = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// The path with the home folder written as ~, and forward slashes, for showing to the owner.
function tilde(p, home) {
  const s = p === home ? '~' : p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
  return s.split(path.sep).join('/');
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const inside = (dir, p) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

// The deepest of `roots` that holds `file`, or null.
const rootOf = (roots, file) => roots.filter((r) => inside(r, file)).sort((a, b) => b.length - a.length)[0] || null;

// Every .jsonl file under dir, descending at most `maxDepth` folders. A missing folder gives nothing.
function walkJsonl(dir, maxDepth) {
  const out = [];
  const walk = (d, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < maxDepth) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

// What the dashboard shows about where it looked: { tool, path, exists, files } per root. `files` counts the
// indexer's current listing (a map of file path to entry) under that root.
function describeRoots(rootsByTool, files, home) {
  const out = [];
  for (const [tool, roots] of Object.entries(rootsByTool)) {
    const counts = new Map(roots.map((r) => [r, 0]));
    for (const [file, e] of Object.entries(files || {})) {
      if (e && e.source && e.source !== tool) continue;
      const r = rootOf(roots, file);
      if (r) counts.set(r, counts.get(r) + 1);
    }
    for (const r of roots) out.push({ tool, path: tilde(r, home), exists: isDir(r), files: counts.get(r) });
  }
  return out;
}

module.exports = { expand, dedupe, listOf, tilde, isDir, rootOf, walkJsonl, describeRoots };
