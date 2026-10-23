// The dataset store: .data/datasets/index.json (the list) and one <slug>.jsonl per dataset (the examples), both
// 0600 in a 0700 folder. Reads go to disk each time (a CLI may run next to the dashboard); writes are small and
// synchronous. Every text in an example is masked on the way in (shape.cleanExample).
const fs = require('fs');
const path = require('path');
const { openJsonl, ensurePrivateDir } = require('../evals/store');
const { LIMITS, maskText, capField, slugify, validSlug, sourceKey, cleanTags, cleanExample } = require('./shape');

const err = (status, message, reasons) => Object.assign(new Error(message), reasons ? { status, reasons } : { status });
const num = (n) => n.toLocaleString('en-US');
const MAX_REASONS = 20;

function quiet(fn) {
  try {
    fn();
  } catch {
    /* best effort */
  }
}

function createDatasetStore({ dir, now = Date.now, limits = LIMITS, log = (m) => console.warn(m) }) {
  const indexFile = path.join(dir, 'index.json');
  const fileOf = (slug) => path.join(dir, `${slug}.jsonl`);

  const ensureDir = () => ensurePrivateDir(dir);

  // A missing index is an empty list. One that cannot be read or parsed is set aside as index.json.corrupt-<ts>
  // and rebuilt from the .jsonl files, never overwritten: that would orphan every dataset it listed.
  // Entries with a bad slug are dropped so no path is ever built from them.
  function readIndex() {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      return recoverIndex();
    }
    if (!parsed || !Array.isArray(parsed.datasets)) return recoverIndex();
    return parsed.datasets
      .filter((d) => d && validSlug(d.slug))
      .map((d) => ({
        slug: d.slug,
        name: typeof d.name === 'string' ? d.name : d.slug,
        createdAt: Number.isFinite(d.createdAt) ? d.createdAt : 0,
        updatedAt: Number.isFinite(d.updatedAt) ? d.updatedAt : 0,
        count: Number.isInteger(d.count) ? d.count : 0,
      }));
  }

  function recoverIndex() {
    try {
      fs.renameSync(indexFile, `${indexFile}.corrupt-${now()}`);
    } catch {
      // Cannot move it aside, so nothing may be written over it.
      throw err(500, 'dataset index is unreadable');
    }
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      /* no folder: nothing to rebuild from */
    }
    const rebuilt = [];
    for (const f of names) {
      const slug = f.endsWith('.jsonl') ? f.slice(0, -6) : '';
      if (!validSlug(slug)) continue;
      let t = now();
      quiet(() => {
        t = Math.round(fs.statSync(path.join(dir, f)).mtimeMs);
      });
      rebuilt.push({ slug, name: slug, createdAt: t, updatedAt: t, count: rowsOf(slug).length });
    }
    log(
      `datasets: index.json was unreadable; kept it as index.json.corrupt-* and rebuilt ${rebuilt.length} dataset(s)`,
    );
    writeIndex(rebuilt);
    return rebuilt;
  }

  // Temp file + rename: a crash mid-write leaves the old index intact.
  function writeIndex(datasets) {
    ensureDir();
    const tmp = `${indexFile}.tmp`;
    quiet(() => fs.unlinkSync(tmp)); // writeFileSync keeps the mode of a file that already exists
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, datasets }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, indexFile);
    } catch (e) {
      quiet(() => fs.unlinkSync(tmp));
      throw e;
    }
  }

  const find = (datasets, slug) => datasets.find((d) => d.slug === slug) || null;
  function need(slug) {
    const datasets = readIndex();
    const meta = typeof slug === 'string' ? find(datasets, slug) : null;
    if (!meta) throw err(404, 'unknown dataset');
    return { datasets, meta };
  }
  // Index entry after a write: count and updatedAt change every time.
  function touch(datasets, meta, count) {
    meta.count = count;
    meta.updatedAt = now();
    writeIndex(datasets);
    return { ...meta };
  }

  function cleanName(name) {
    const n = maskText(typeof name === 'string' ? name : '').trim();
    if (!n || n.length > limits.name) throw err(400, `name must be 1 to ${limits.name} characters`);
    return n;
  }

  function create({ name, slug } = {}) {
    const clean = cleanName(name);
    const chosen = slug == null || slug === '' ? slugify(clean) : slug;
    if (!validSlug(chosen))
      throw err(400, 'slug must be lowercase letters, numbers and dashes (and not a reserved word)');
    const datasets = readIndex();
    if (find(datasets, chosen)) throw err(409, 'a dataset with this slug already exists');
    if (datasets.length >= limits.datasets) throw err(400, `at most ${num(limits.datasets)} datasets`);
    const t = now();
    // A .jsonl left without an index entry (a crash, or a lost index) is adopted, not hidden behind count 0.
    const meta = { slug: chosen, name: clean, createdAt: t, updatedAt: t, count: rowsOf(chosen).length };
    datasets.push(meta);
    writeIndex(datasets);
    return { ...meta };
  }

  // Function declarations hoist, so readIndex can use it too.
  function rowsOf(slug) {
    return openJsonl(fileOf(slug)).read().rows;
  }

  // A rewrite drops rows that do not parse (a torn line, a hand edit). They are moved to <slug>.jsonl.bad first
  // so a rewrite never destroys them.
  function rewrite(slug, rows) {
    const file = fileOf(slug);
    let text = '';
    quiet(() => {
      text = fs.readFileSync(file, 'utf8');
    });
    const bad = text.split('\n').filter((line) => {
      if (!line.trim()) return false;
      try {
        const row = JSON.parse(line);
        return !(row && typeof row === 'object' && !Array.isArray(row));
      } catch {
        return true;
      }
    });
    if (bad.length) fs.appendFileSync(`${file}.bad`, bad.join('\n') + '\n', { mode: 0o600 });
    openJsonl(file).rewrite(rows);
  }

  // Every non-blank line parsed and checked strictly; at most 20 reasons are collected.
  function importRows(jsonl) {
    const parsed = [];
    const reasons = [];
    const lines = String(jsonl ?? '').split(/\r?\n/);
    for (let i = 0; i < lines.length && reasons.length < MAX_REASONS; i++) {
      if (!lines[i].trim()) continue;
      let raw;
      try {
        raw = JSON.parse(lines[i]);
      } catch {
        reasons.push(`line ${i + 1}: not valid JSON`);
        continue;
      }
      const r = cleanExample(raw, { strict: true, now, limits });
      if (r.ok) parsed.push(r.example);
      else reasons.push(`line ${i + 1}: ${r.reason}`);
    }
    return { parsed, reasons };
  }

  return {
    list: () =>
      readIndex()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((d) => ({ ...d })),

    get(slug) {
      const meta = typeof slug === 'string' ? find(readIndex(), slug) : null;
      return meta ? { ...meta } : null;
    },

    create,

    rename(slug, name) {
      const { datasets, meta } = need(slug);
      meta.name = cleanName(name);
      return touch(datasets, meta, meta.count);
    },

    remove(slug) {
      const datasets = readIndex();
      if (typeof slug !== 'string' || !find(datasets, slug)) return false;
      writeIndex(datasets.filter((d) => d.slug !== slug));
      quiet(() => fs.unlinkSync(fileOf(slug)));
      quiet(() => fs.unlinkSync(`${fileOf(slug)}.tmp`));
      quiet(() => fs.unlinkSync(`${fileOf(slug)}.bad`));
      return true;
    },

    examples(slug) {
      need(slug);
      return rowsOf(slug);
    },

    hasSource(slug, source) {
      need(slug);
      const key = sourceKey(source);
      return key !== null && rowsOf(slug).some((e) => sourceKey(e.source) === key);
    },

    add(slug, raws, { strict = false } = {}) {
      const { datasets, meta } = need(slug);
      if (!Array.isArray(raws)) throw err(400, 'examples must be a list');
      const io = openJsonl(fileOf(slug));
      const rows = io.read().rows; // also settles a torn last line before the append
      const seen = new Set(rows.map((e) => sourceKey(e.source)).filter(Boolean));
      const added = [];
      const skipped = [];
      raws.forEach((raw, index) => {
        const r = cleanExample(raw, { strict, now, limits });
        if (!r.ok) return skipped.push({ index, reason: r.reason });
        const key = sourceKey(r.example.source);
        if (key && seen.has(key)) return skipped.push({ index, reason: 'already in this dataset' });
        if (rows.length + added.length >= limits.examples) {
          return skipped.push({ index, reason: `dataset is full (${num(limits.examples)} examples)` });
        }
        io.append(r.example);
        if (key) seen.add(key);
        added.push(r.example);
      });
      if (added.length) touch(datasets, meta, rows.length + added.length);
      return { added, skipped };
    },

    // Only the fields being changed are checked, so an example whose stored evals names an evaluator that is
    // gone from the registry can still be edited.
    update(slug, id, { reference, tags } = {}) {
      const { datasets, meta } = need(slug);
      const rows = rowsOf(slug);
      const at = rows.findIndex((e) => e.id === id);
      if (at < 0) throw err(404, 'unknown example');
      const next = { ...rows[at], updatedAt: now() };
      if (reference !== undefined) {
        if (reference !== null && typeof reference !== 'string') throw err(400, 'reference must be text or null');
        next.reference = reference ? { text: capField(maskText(reference), limits.field) } : null;
      }
      if (tags !== undefined) {
        const t = cleanTags(tags, limits);
        if (!t.ok) throw err(400, t.reason);
        next.tags = t.tags;
      }
      if (Buffer.byteLength(JSON.stringify(next)) > limits.exampleBytes) throw err(400, 'example is too large');
      rows[at] = next;
      rewrite(slug, rows);
      touch(datasets, meta, rows.length);
      return next;
    },

    removeExample(slug, id) {
      const { datasets, meta } = need(slug);
      const rows = rowsOf(slug);
      const kept = rows.filter((e) => e.id !== id);
      if (kept.length === rows.length) return false;
      rewrite(slug, kept);
      touch(datasets, meta, kept.length);
      return true;
    },

    exportJsonl(slug) {
      need(slug);
      return rowsOf(slug)
        .map((e) => JSON.stringify(e) + '\n')
        .join('');
    },

    // All or nothing: every line is checked first, and nothing is written when one fails.
    importJsonl({ slug, name, jsonl } = {}) {
      if (typeof jsonl !== 'string') throw err(400, 'jsonl must be text');
      const chosen = slug == null || slug === '' ? slugify(name) : slug;
      if (!validSlug(chosen))
        throw err(400, 'slug must be lowercase letters, numbers and dashes (and not a reserved word)');
      const datasets = readIndex();
      const meta = find(datasets, chosen);
      const display = meta ? meta.name : name == null || name === '' ? chosen : cleanName(name);
      if (!meta && datasets.length >= limits.datasets) throw err(400, `at most ${num(limits.datasets)} datasets`);

      const { parsed, reasons } = importRows(jsonl);
      if (reasons.length) throw err(400, 'the file has lines that cannot be imported', reasons);
      if (!parsed.length) throw err(400, 'the file has no examples', ['no examples found']);
      const have = rowsOf(chosen); // also the rows of an orphan file, which are adopted
      if (have.length + parsed.length > limits.examples) {
        throw err(400, `a dataset holds at most ${num(limits.examples)} examples`, [
          `${num(have.length + parsed.length)} examples would not fit`,
        ]);
      }

      // Into an existing dataset, an id it already holds gets a new one.
      const ids = new Set(have.map((e) => e.id));
      for (const e of parsed) {
        if (ids.has(e.id)) {
          const fresh = cleanExample({ ...e, id: undefined }, { now, limits }).example;
          e.id = fresh.id;
        }
        ids.add(e.id);
      }
      rewrite(chosen, [...have, ...parsed]);
      if (meta) return { dataset: touch(datasets, meta, have.length + parsed.length), added: parsed.length };
      const t = now();
      const created = { slug: chosen, name: display, createdAt: t, updatedAt: t, count: have.length + parsed.length };
      datasets.push(created);
      writeIndex(datasets);
      return { dataset: { ...created }, added: parsed.length };
    },
  };
}

module.exports = { createDatasetStore };
