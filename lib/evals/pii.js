// Personal data masking for the external judge path only (rule S4). The masked reader already replaced secrets;
// this pass also hides emails, IP addresses, phone numbers and the user name in home-folder paths before text
// leaves the machine. A local judge reads the full text. The patterns are conservative: a port, a hash, a date, a
// time, a grouped number and a version after a letter or a slash are left as they are. A bare four-part version
// (26.2.4.2) still looks like an IPv4 address and is masked.

// The user name in /Users/<name>, /home/<name> and C:\Users\<name> (any case, a JSON-escaped \\ too). A path inside
// a URL (example.com/users/42) is not a home folder. A Windows name may hold spaces when a backslash follows it.
const NAME = '[^/\\\\\\s"\'`<>|:]+';
const POSIX_HOME = new RegExp(`((?<![\\w.-])/(?:users|home)/)(${NAME})`, 'gi');
const WIN_HOME = new RegExp(
  `(\\b[a-z]:(?:\\\\{1,2}|/)users(?:\\\\{1,2}|/))(${NAME}(?: ${NAME})*(?=\\\\)|${NAME})`,
  'gi',
);
// The lookbehind starts a match only at the start of a local part, so a long run without an @ is scanned once. The
// last label is a top-level domain, not an image extension (icon@2x.png), and no further label follows it.
const IMAGE = '(?:png|jpe?g|svg|webp|gif|ico|bmp|avif|tiff?)';
const EMAIL = new RegExp(
  `(?<![a-z0-9._%+-])[a-z0-9._%+-]+@[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?!${IMAGE}\\b)[a-z]{2,}\\b(?!\\.[a-z0-9])`,
  'gi',
);
// Four dotted parts of 0-255 that are not part of a longer dotted run, and not right after a letter, an @ or a
// single slash (openjdk@21/21.0.12.1 is a version); after "//" it is a URL host and still masked.
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`(?<![\\w.@]|(?<!/)/)${OCTET}(?:\\.${OCTET}){3}(?!\\w|\\.\\d)`, 'g');
// Eight full groups, or a "::" form (checked further in ipv6()). Clock times (10:00:00) have no "::".
const H = '[0-9a-f]{1,4}';
const IPV6 = new RegExp(`(?<![\\w:.])(?:(?:${H}:){7}${H}|(?:${H}(?::${H})*)?::(?:${H}(?::${H})*)?)(?![\\w:])`, 'gi');
// 9 to 15 digits: after a leading + in any grouping, else with an area code in brackets or in 3 to 5 groups
// split by dashes. Groups split only by dots or spaces are amounts, scores and sizes (11.927.074.289, 1080 1080 24),
// not phone numbers. No letter, digit, dot, dash, colon or slash next to it, so times, versions, ports, hashes and
// plain long numbers (ids, timestamps) are left alone; a date is left out in phone().
const PHONE = new RegExp(
  '(?<![\\w.:/+-])(?:\\+\\d[\\d ().-]{7,20}\\d|\\(\\d{2,4}\\)[ -]?\\d{2,4}(?:[ -]\\d{2,4}){1,3}|' +
    '\\d{2,4}(?:-\\d{2,4}){2,4})(?![\\w:/-]|\\.\\d)',
  'g',
);
const KEEP_IP = new Set(['127.0.0.1', '0.0.0.0', '::1', '::']);

// A "::" form needs a digit and either three groups or one long group: fe80::1 is an address, a[1::2] is not.
function ipv6(m) {
  if (KEEP_IP.has(m.toLowerCase()) || !/\d/.test(m)) return m;
  if (!m.includes('::')) return '‹ip›';
  const groups = m.split(':').filter(Boolean);
  return groups.length >= 3 || groups.some((g) => g.length >= 3) ? '‹ip›' : m;
}
function phone(m) {
  if (/^\d{4}-\d{2}-\d{2}\b/.test(m)) return m; // 2026-10-21 and what follows it
  const n = m.replace(/\D/g, '').length;
  return n >= 9 && n <= 15 ? '‹phone›' : m;
}

function maskPii(text) {
  return String(text ?? '')
    .replace(EMAIL, '‹email›')
    .replace(POSIX_HOME, '$1‹user›')
    .replace(WIN_HOME, '$1‹user›')
    .replace(IPV4, (m) => (KEEP_IP.has(m) ? m : '‹ip›'))
    .replace(IPV6, ipv6)
    .replace(PHONE, phone);
}

module.exports = { maskPii };
