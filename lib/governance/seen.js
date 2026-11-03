// Governance inventory (AI Governance 3): the first and last day each inventory item was seen (spec I2), in
// .data/governance/seen.json as { id: { first, last } } and nothing else. A file that is missing or unreadable reads as
// {}, so the dates start again from today and the page never fails on it. A write is atomic and synced (private file,
// temp file of its own, rename), and only happens when the map changed.
const { writePrivate, readJson } = require('../cost/files');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function createSeenStore({ file }) {
  let last = null; // the map as last read or written, as text
  return {
    read() {
      const v = readJson(file, {});
      const map = isObj(v) ? v : {};
      last = JSON.stringify(map);
      return map;
    },
    // Returns true when the file was written.
    write(map) {
      const text = JSON.stringify(isObj(map) ? map : {});
      if (text === last) return false;
      writePrivate(file, text);
      last = text;
      return true;
    },
  };
}

module.exports = { createSeenStore };
