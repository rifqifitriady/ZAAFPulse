// Where the agent logs live. Shared by the Claude Code and Codex readers, the dashboard diagnostics and
// `zaafpulse doctor`, so they all agree on the folders.
const fs = require('fs');
const path = require('path');

// "~" and "~/x" mean the given home; the result is absolute.
const expand = (p, home) => path.resolve(String(p).trim().replace(/^~(?=$|[\\/])/, home));

// The folder or file a path really is (links resolved); the path itself when it does not exist.
function real(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

// Each folder once by where it really is, keeping the first spelling: ~/.config/claude may be a link to ~/.claude.
function dedupe(list) {
  const seen = new Set();
  return list.filter((p) => {
    const r = real(p);
    const k = process.platform === 'win32' ? r.toLowerCase() : r;
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

// The real path of p, or of its folder with p's name when p itself does not exist yet.
function realish(p) {
  const r = real(p);
  return r !== p ? r : path.join(real(path.dirname(p)), path.basename(p));
}

// Why a root is not used, or null. Roots are always <config dir>/<projects|sessions>, absolute, and never one
// that sits directly in the home folder or at the top of a drive: a mistyped CLAUDE_CONFIG_DIR=~ or =/ must
// not turn into a walk of the whole disk. The folder a link really is counts too: a config folder that is a link to ~,
// or a root that is one, is as broad as ~. A root that is a link to a folder in ~ (~/.claude/projects ->
// ~/claude-logs) is fine, so the parent of the real root is not checked.
function problem(root, home) {
  if (!path.isAbsolute(root)) return 'not absolute';
  const homes = new Set([path.resolve(home), real(path.resolve(home))]);
  const top = (p) => p === path.parse(p).root || homes.has(p);
  const broad = (p) => top(p) || top(path.dirname(p));
  return broad(root) || top(real(path.dirname(root))) || top(realish(root)) ? 'too broad' : null;
}

// The candidate roots for config-dir values (`~` allowed): <dir>/<leaf> each, with the reason it is ignored if
// it is. A relative value is never resolved against the working folder.
function fromDirs(dirs, leaf, home) {
  return dirs.map((d) => {
    const given = String(d).trim().replace(/^~(?=$|[\\/])/, home);
    if (!path.isAbsolute(given)) return { path: given, ignored: 'not absolute' };
    const root = path.join(path.resolve(given), leaf);
    return { path: root, ignored: problem(root, home) };
  });
}

// Candidates in order, with link-duplicates of an earlier root left out: [{ path, ignored }].
function classify(cands) {
  const keep = new Set(dedupe(cands.filter((c) => !c.ignored).map((c) => c.path)));
  return cands.filter((c) => c.ignored || keep.delete(c.path)).map((c) => (c.ignored ? c : { path: c.path }));
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
  for (const [tool, entries] of Object.entries(rootsByTool)) {
    const all = entries.map((r) => (typeof r === 'string' ? { path: r } : r));
    const roots = all.filter((r) => !r.ignored).map((r) => r.path);
    const counts = new Map(roots.map((r) => [r, 0]));
    for (const [file, e] of Object.entries(files || {})) {
      if (e && e.source && e.source !== tool) continue;
      const r = rootOf(roots, file);
      if (r) counts.set(r, counts.get(r) + 1);
    }
    for (const r of all)
      out.push(
        r.ignored
          ? { tool, path: tilde(r.path, home), exists: false, files: 0, ignored: r.ignored }
          : { tool, path: tilde(r.path, home), exists: isDir(r.path), files: counts.get(r.path) },
      );
  }
  return out;
}

// Files of several roots, each file once by its real path (a link into another root, or roots that overlap).
function uniqueFiles(roots, maxDepth) {
  const all = roots.flatMap((r) => walkJsonl(r, maxDepth));
  return roots.length > 1 ? dedupe(all) : all;
}

module.exports = {
  expand,
  dedupe,
  listOf,
  tilde,
  isDir,
  rootOf,
  walkJsonl,
  uniqueFiles,
  fromDirs,
  classify,
  describeRoots,
};
