// Governance inventory (AI Governance 3): the first and last day each inventory item was seen (spec I2), in
// .data/governance/seen.json as { baselineDone, baselineSince?, items: { id: { first, last, state?, baseline? } } } and
// nothing else.
// read() -> { exists, baselineDone, baselineSince?, map } (baselineSince: the time of the first write, ms, kept while
// the baseline is not done so that it can end 24 h later even if a source keeps failing):
//   - no file (ENOENT): exists false, baselineDone false: the first build after install or upgrade, whose items are the
//     baseline (never counted as new);
//   - a file that is there but unreadable or not the expected shape: exists true, baselineDone true, map {}. This is
//     deliberately loud: every item then counts as new, so that damaging or emptying the file cannot silence the alert;
//   - the older flat shape { id: { first, last } } reads as a finished baseline.
// A write is atomic and synced (private file, temp file of its own, rename), and only happens when the state changed;
// the first build writes even an empty map. write() never throws: it returns true when the file was written, false
// when nothing changed and 'failed' when the file could not be written.
const fs = require('fs');
const { writePrivate } = require('../cost/files');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const textOf = (state) =>
  JSON.stringify({
    baselineDone: state.baselineDone === true,
    ...(Number.isFinite(state.baselineSince) ? { baselineSince: state.baselineSince } : {}),
    items: state.map,
  });

function createSeenStore({ file }) {
  let last = null; // the state as last read or written, as text
  return {
    read() {
      let raw;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (e) {
        if (e && e.code === 'ENOENT') {
          last = null;
          return { exists: false, baselineDone: false, map: {} };
        }
        last = null;
        return { exists: true, baselineDone: true, map: {} };
      }
      let v;
      try {
        v = JSON.parse(raw);
      } catch {
        v = null;
      }
      last = null;
      if (!isObj(v)) return { exists: true, baselineDone: true, map: {} };
      const flat = !Object.hasOwn(v, 'items');
      const map = flat ? v : isObj(v.items) ? v.items : {};
      const state = {
        exists: true,
        baselineDone: flat ? true : v.baselineDone === true,
        ...(!flat && Number.isFinite(v.baselineSince) ? { baselineSince: v.baselineSince } : {}),
        map,
      };
      last = textOf(state);
      return state;
    },
    // Takes { baselineDone, map }; returns true (written), false (unchanged) or 'failed'.
    write(state) {
      const s = isObj(state) && isObj(state.map) ? state : { baselineDone: true, map: {} };
      const text = textOf(s);
      if (text === last) return false;
      try {
        writePrivate(file, text);
      } catch {
        return 'failed';
      }
      last = text;
      return true;
    },
  };
}

module.exports = { createSeenStore };
