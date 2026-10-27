// Detectors for quality and safety signals in agent logs. These are heuristics over
// what the logs record, not ground-truth accuracy: each one names what it matched.
// Measured precision and recall, and how they were measured: docs/quality-metrics.md.

/* ---------- Prompt injection ---------- */

// Supporting categories only count together with another one: a repository's own AGENTS.md or
// CLAUDE.md legitimately addresses AI assistants, so "addressed to the AI" alone is not an attack.
const INJECTION = [
  {
    id: 'exfil',
    label: 'Exfiltration request',
    res: [
      /(?<!(?:not|n't|never|jangan) |\.)\b(?:send|post|upload|exfiltrate|forward|e-?mail|transmit|leak|paste|curl|wget|push|sync|commit|publish)\b[^.\n]{0,50}?(?:api[ _-]?keys?|credentials?|secrets?|tokens?|passwords?|env(?:ironment)? (?:variables|vars)|\.env\b|ssh keys?|id_rsa|id_ed25519|private keys?|cookies|~\/\.ssh|~\/\.aws|keychain)[^.\n]{0,60}?(?:\bto\b|\binto\b|\bvia\b|https?:\/\/|@[\w-]+\.)/i,
      /(?<!(?:not|n't|never) |\.)\b(?:print|reveal|output|dump|display|show|append|include|leak|tell me|attach)\b[^.\n]{0,30}?(?:(?:hidden|system|secret|original|internal) (?:instructions|prompt)|system prompt|api[ _-]?keys?|credentials|secrets|env(?:ironment)? variables|\.env file|ssh keys?|private keys?|~\/\.aws\/credentials|~\/\.ssh\/id_\w+|aws credentials|\.env\b)/i,
      /(?:~\/\.aws\/credentials|~\/\.ssh\/id_\w+|\.env\b|id_rsa|\/etc\/passwd)[^\n]{0,80}?\|\s*(?:base64\s*\|\s*)?(?:curl|wget|nc|ncat)\b/i,
      /\b(?:cat|type|less|base64|print|open|read)\s+(?:~\/\.ssh\/id_\w+|~\/\.aws\/credentials|~?\/?\.env\b|id_rsa)[^\n]{0,120}?\b(?:curl|wget|nc|fetch|url|webhook|query string|request|send|post|upload|reply|response|answer|code block)\b/i,
      /(?<!jangan )\b(?:kirim(?:kan|in)?|unggah|upload|bocorkan|teruskan|salin|tempel(?:kan)?|post)\b[^.\n]{0,40}?(?:token|kunci api|api key|kredensial|kata sandi|password|rahasia|secret|\.env|kunci ssh|ssh key|kunci privat|cookie)[^.\n]{0,60}?(?:\bke\b|https?:\/\/|\bvia\b|\bmelalui\b)/i,
      /\b(?:tampilkan|tunjukkan|bocorkan|cetak|tuliskan)\b[^.\n]{0,30}?(?:system prompt|prompt sistem|kredensial|kunci api|api key|rahasia|isi file \.env)/i,
    ],
  },
  {
    id: 'command',
    label: 'Command injection',
    res: [
      /\b(?:run|execute|exec|type|paste|enter)\b (?:the following|this|these|that) (?:commands?|scripts?|code)\b[^.\n]{0,40}?\b(?:immediately|now|right away|without (?:asking|confirmation|confirming|prompting|approval|checking))\b/i,
      /\bthe (?:assistant|agent|model|ai) (?:must|should|is required to|has to) (?:also )?(?:call|use|invoke|run|execute|send)\b|\b(?:run|execute)\b[^.\n]{0,80}?\b(?:and )?(?:do not|don'?t|never) ask\b/i,
      /\b(?:run|execute)\b[^.\n]{0,60}?\bwithout (?:asking|confirmation|confirming|prompting|approval|permission|checking with)\b/i,
      /\b(?:jalankan|eksekusi)\b[^.\n]{0,60}?\b(?:tanpa (?:bertanya|konfirmasi|izin|persetujuan)|sekarang juga)\b/i,
    ],
  },
  {
    id: 'override',
    label: 'Instruction override',
    res: [
      /\b(?:ignore|disregard|forget|override|bypass|discard|abandon|neglect)\b(?:\s+(?:all|any|every|each|the|your|my|of|these|those|everything|previous|prior|above|earlier|preceding|foregoing|original|initial|system|existing|old|current|other|developer'?s?|user'?s?))*\s+(?:instructions?|prompts?|guidance|guidelines|directions|directives|rules|context|constraints|programming|orders|policies|policy|safety (?:checks|rules|guidelines)|restrictions|guardrails|messages)\b/i,
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:user'?s?|human'?s?|previous|prior|original|earlier|your|their|operator'?s?)\s+(?:requests?|tasks?|commands?|wishes|questions?)\b|\bstop what you(?:'re| are) doing\b|\b(?:ignore|disregard|forget)\s+(?:the|your|this)\s+(?:task|request|instructions?|prompt)s?\s+(?:above|before|so far)\b|\b(?:skip|bypass|ignore|disable) (?:the |all |any )?(?:permission|confirmation|approval|safety) (?:prompts?|checks?|requests?|dialogs?)\b|\bfollow only the instructions (?:on|in) this (?:page|document|file)\b/i,
      /\blupakan (?:semua|segala|apa)\b[^.\n]{0,30}?\b(?:sebelumnya|dikatakan|diberitahu|diperintahkan)\b|\b(?:turuti|menuruti|ikuti|mengikuti) (?:hanya )?perintah (?:di|dari) (?:halaman|dokumen|situs|file) ini\b/i,
      /\bforget (?:everything|all|what)\b[^.\n]{0,25}?\b(?:told|above|before|so far|said)\b/i,
      /\b(?:abaikan(?:lah)?|lupakan|acuhkan|hiraukan|langgar|jangan (?:ikuti|hiraukan|pedulikan))\b(?:\s+(?:semua|seluruh|segala|setiap|tiap|itu|ini))*\s+(?:instruksi|perintah|aturan|arahan|petunjuk|pedoman|prompt|konteks|batasan|kebijakan)\b/i,
      /\bignora(?:r)? (?:todas? )?(?:las |los )?(?:instrucciones|reglas|indicaciones)\b/i,
      /\bignore[zr]? (?:toutes? )?(?:les )?(?:instructions|règles|consignes) (?:précédentes|antérieures)/i,
      /\bignorier(?:e|en)? (?:alle )?(?:vorherigen |bisherigen )?(?:anweisungen|regeln|instruktionen)/i,
      /\bignore (?:todas )?as instruções/i,
      /忽略(?:之前|以上|先前|上面)?(?:的)?(?:所有)?(?:指令|指示|说明|规则)/,
    ],
  },
  {
    id: 'hidden',
    label: 'Hide-from-user instruction',
    res: [
      /\b(?:don'?t|do not|never) (?:tell|inform|mention|reveal|show|notify|alert|let) (?:this |it |that )?(?:to )?(?:the )?(?:user|human|operator)\b|\bwithout (?:telling|informing|alerting|notifying|asking) the (?:user|human)\b|\bkeep (?:this|it) (?:secret|hidden) from (?:the )?(?:user|human)/i,
      /\b(?:don'?t|do not|never) (?:mention|include|report|note|disclose) (?:this|it|that)\b[^.\n]{0,20}?\b(?:summary|report|reply|response|answer|output)\b|\b(?:do (?:this|it)|proceed) (?:silently|quietly|secretly)\b|\b(?:then )?(?:say|claim|report) (?:that )?(?:the task|it|everything) (?:is|was) (?:complete|done|finished|successful)\b|\b(?:should|must|will) not be (?:shown|mentioned|revealed|disclosed|reported) to the (?:user|human)\b|\bwhen you summari[sz]e\b[^.\n]{0,40}?\b(?:omit|hide|leave out|skip)\b|\b(?:omit|hide|leave out) (?:this|it|that)(?: line| part| section| step)?\b[^.\n]{0,30}?\b(?:summar\w*|report|reply|response|the user)\b|\btell the user (?:that )?(?:it|this|the (?:page|site|file|script)) is safe\b/i,
      /(?:^|[.!?:]\s+|\n)\s*(?:quietly|silently|secretly|covertly)\b[^.\n]{0,20}?\b(?:add|run|execute|install|modify|send|upload|change|delete|append|insert)\b/i,
      /\bjangan (?:beri ?tahu|kasih ?tahu|bilang|beritahukan|laporkan|tunjukkan)(?: (?:hal )?(?:ini|itu))?(?: (?:ke|kepada))? (?:pengguna|user|pemakai)\b|\btanpa (?:memberi ?tahu|sepengetahuan|bilang ke) (?:pengguna|user)\b|\bjangan (?:sebutkan|sebut|ceritakan)\b[^.\n;]{0,30}?\b(?:tersembunyi|ini|itu|skrip|perintah)\b|\b(?:balas|bilang|katakan) (?:ke |kepada )?pengguna bahwa\b|\b(?:secara )?diam-diam\b[^.\n]{0,20}?\b(?:tambahkan|jalankan|kirim\w*|unggah|ubah|hapus|install|pasang|masukkan)\b/i,
    ],
  },
  {
    id: 'persona',
    label: 'Persona hijack',
    res: [
      /\byou are no longer (?:a|an|the|just)\b|\byou are now (?:DAN|in (?:developer|god|admin|maintenance|debug|jailbreak|unrestricted) mode|an? (?:unrestricted|unfiltered|jailbroken|uncensored|evil)\b)|\b(?:enable|enter|activate|switch to) (?:developer|god|admin|jailbreak|DAN|unrestricted) mode\b|\bact as (?:DAN|an? (?:unrestricted|unfiltered|uncensored|jailbroken))|\b(?:from now on|henceforth),? you (?:are|will be|act as|must act as)\b|\bpretend (?:to be|you are) (?:an? )?(?:unrestricted|unfiltered|DAN|evil|jailbroken)|\b(?:AI|assistant|model) (?:without|with no) (?:restrictions|limits|filters|rules|guidelines)\b/i,
      /\b(?:mulai )?sekarang (?:kamu|anda) (?:adalah|menjadi|berperan sebagai)\b|\bmulai sekarang (?:kamu|anda) (?:harus|wajib)\b|\b(?:kamu|anda) (?:sekarang )?(?:adalah|menjadi) (?:asisten|AI|model) (?:tanpa|yang tidak punya) (?:batasan|aturan|filter)/i,
    ],
  },
  {
    id: 'authority',
    label: 'Fake authority',
    res: [
      /\bnew (?:instructions?|task|request) from (?:the )?(?:user|developer|admin|administrator|system|operator|openai|anthropic|owner)\b|\b(?:important|attention|urgent|system|admin)\s*[:!-]\s*(?:the )?(?:new|updated) (?:instructions?|rules?|directives?)\b|\b(?:your|the) (?:new|real|actual|true) (?:instructions|directive|objective) (?:is|are)\b|\bI (?:hereby )?authori[sz]e you to\b|\b(?:has|have|had|is|was|are|were|been|already) pre-?approved\b|\bpre-?approved (?:this|it|all|every|the following)\b|\b(?:the )?(?:admin|administrator|developer|maintainers?|owner|operator) (?:said|says|has said|confirmed) (?:that )?you (?:may|can|are allowed|should|must)\b|\b(?:the )?user (?:has )?(?:already )?(?:pre-?)?approved (?:all|every|this|it)\b/i,
      /\binstruksi baru dari (?:developer|admin|sistem|pengembang)\b|\bpengguna sudah (?:menyetujui|mengizinkan) semua\b/i,
    ],
  },
  {
    id: 'roletag',
    label: 'Fake role tags',
    // Only a tag that carries instructions counts; chat-template docs show the bare tags.
    res: [
      /<\/?(?:system|im_start|im_end)>|\[\/?INST\]|<\|im_start\|>|<\|im_end\|>|<\|(?:system|user|assistant)\|>|\[(?:SYSTEM|ADMIN|DEVELOPER)(?: (?:MESSAGE|PROMPT|OVERRIDE|NOTE))?\]|BEGIN SYSTEM PROMPT|<<SYS>>|### (?:System|Instruction):|(?:^|\n)\s*(?:system|assistant|developer)\s*:(?!\s*['"`{\[])/i,
    ],
    carries: true,
  },
  {
    id: 'pipeshell',
    label: 'Download piped to a shell',
    res: [/\b(?:curl|wget)\b[^\n|`']{0,150}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i],
    supporting: true,
  },
  {
    id: 'addressed',
    label: 'Addressed to the AI',
    res: [
      /\b(?:note|message|attention|instructions?|notice|important) (?:to|for) (?:any |all )?(?:the )?(?:ai|llm|language model|assistant|agent|chatbot|claude|chatgpt|gpt|copilot|codex|gemini)s?\b|\b(?:attention|hey|dear|hello),? (?:ai|llm|claude|chatgpt|gpt|copilot|codex|gemini)(?: agents?| assistants?| models?)?\s*[:!,]|\b(?:ai|llm) (?:coding )?(?:agents?|assistants?|models?)\b[^.\n]{0,10}?(?:reading|processing|parsing|working in|:)|\bif you are an? (?:ai|llm|language model|assistant|agent|bot)\b|(?:^|\n)\s*(?:claude|chatgpt|codex|copilot|gemini)\s*,/i,
      /\bcatatan (?:untuk|bagi) (?:ai|asisten|agen|llm)\b|\b(?:halo|hai|hei),? (?:ai|claude|asisten)\b|\b(?:jika|kalau) (?:kamu|anda) (?:membaca ini|adalah ai)\b|\b(?:untuk|bagi|kepada) (?:para )?(?:ai|agen ai|asisten ai|llm)\s*[:,]/i,
    ],
    supporting: true,
  },
];
const INJ_CARRIES =
  /\b(?:you (?:are|must|will|should|have to|may)|ignore|disregard|override|from now on|reveal|bypass|disable|comply|do not|don'?t|always|never|mode|execute|kamu|abaikan|pre-?approved|instead)\b/i;
// Every pattern above contains at least one of these anchors. One pass finds them; the patterns
// then run only on windows around them, which keeps the scan near the speed of this one regex on
// long tool output (a code file that says "token" no longer pays for the whole pattern set).
const INJ_ANCHOR =
  /\b(?:ignor|disregard|forget|overrid|bypass|discard|abandon|neglect|abaikan|lupakan|hiraukan|acuhkan|langgar|jangan|you are (?:now|no longer)|(?:developer|god|admin|jailbreak|dan|unrestricted|maintenance|debug) mode|act as|from now on|henceforth|pretend|without|exfil|credential|secret|token|passw|api[ _-]?key|ssh key|id_rsa|id_ed25519|private key|env(?:ironment)? (?:variables|vars)|system prompt|prompt sistem|(?:hidden|original|internal) prompt|kredensial|kunci|rahasia|kata sandi|quietly|silently|secretly|covertly|diam-diam|im_start|im_end|immediately|right away|tanpa|sekarang|instruction|instruksi|perintah (?:di|dari)|directive|objective|(?:new|updated) rules?|(?:task|request) from|said you|says you|confirmed (?:that )?you|authori[sz]e|approved|pre-approved|menyetujui|mengizinkan|attention|note (?:to|for)|if you are an?|catatan|halo|hai|hei|(?:kalau|jika) (?:kamu|anda)|ai|llm|claude|chatgpt|codex|copilot|gemini|cookie|keychain|(?:following|this|these|that) (?:commands?|scripts?|code)|(?:assistant|agent|model) (?:must|should|is required|has to)|(?:not|never) ask|n't ask|stop what you|(?:permission|confirmation|approval|safety) (?:prompts?|checks?|requests?|dialogs?)|(?:mention|tell|inform|notify|alert|reveal|show|let) (?:this |it |that )?(?:to )?(?:the )?(?:user|human|operator)|hidden from|the task (?:is|was) (?:complete|done|finished|successful)|not be (?:shown|mentioned|revealed|disclosed|reported)|when you summari|(?:omit|hide|leave out) (?:this|it|that)|pengguna bahwa|curl|wget|(?:system|assistant|developer)[ \t]*:)/gi;
// Anchors that do not start at a word boundary.
const INJ_ANCHOR_MARK =
  /<\/?system>|\[\/?inst\]|<\||<<sys>>|### (?:system|instruction)|\.env|\.ssh|\.aws|\[(?:system|admin|developer)|忽略/gi;
const WINDOW_BEFORE = 260;
const WINDOW_AFTER = 320;
// Text that talks about attacks (security docs, red-team suites) or holds them as data (detector
// source, tests) quotes the same phrases. Matches in that context are not counted.
const DOC_CONTEXT =
  /\b(?:attack(?:er|ers|s)?|for example|e\.g\.|for instance|such as|prompt injections?|injection(?: attacks?)?|jailbreaks?|red[- ]team(?:ing)?|detect(?:ion|or|s|ed)?|regex|owasp|mitigat\w*|defen[cs]es?|defend|classifier|malicious|adversarial|well-known|known (?:prompt|attack)s?|contoh|serangan|penyerang|misalnya|deteksi)\b/i;
const CODE_LINE =
  /\bre:\s*\/|new RegExp|\.test\(|\.match\(|\bexpect\(|\bassert\w*\(|\b(?:it|test|describe)\(\s*['"`]|=>|^\s*(?:\d+[\t→]\s*)?(?:const|let|var|def|return)\b|=\s*\/[^/\n]+\/[gimsuy]*|^\s*\/.+\/[gimsuy]*[,;]?\s*$|^\s*(?:\d+[\t→]\s*)?[A-Za-z_$][\w$]*:\s*['"`]/;
// A line that is only a quoted string (an item in a list of test samples).
const STRING_ITEM = /^\s*(?:\d+[\t→]\s*)?(['"`]).*\1,?\s*$/;
const QUOTE_BEFORE = /["'“‘`«]\s*$/;
// Spelled-out (i-g-n-o-r-e) or zero-width-split words, undone for a second pass.
const ZERO_WIDTH = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;
const SPLIT_LETTERS = /\b(?:[a-z][-_.*·•\s]){3,}[a-z]\b/gi;
const HAS_ZERO_WIDTH = new RegExp(ZERO_WIDTH.source);
const HAS_SPLIT = new RegExp(SPLIT_LETTERS.source, 'i');
const HAS_LEET = /\b[a-z]+[0134][a-z]+[0134]?[a-z]*\b/i;
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

function inDocContext(text, at, len) {
  if (QUOTE_BEFORE.test(text.slice(Math.max(0, at - 2), at))) return true;
  const ls = text.lastIndexOf('\n', at) + 1;
  const le = text.indexOf('\n', at + len);
  const line = text.slice(ls, le < 0 ? text.length : le);
  const prev = ls > 1 ? text.slice(text.lastIndexOf('\n', ls - 2) + 1, ls - 1) : '';
  const around = `${prev}\n${line}`.slice(-(len + 400)).replace(/\S+@\S+|https?:\/\/\S+/g, ' ');
  if (DOC_CONTEXT.test(around)) return true;
  return CODE_LINE.test(line) || STRING_ITEM.test(line);
}

// Spans of `text` worth matching: windows around each anchor, widened to line starts (patterns
// anchor on ^ and \n) and merged when they overlap.
function anchorWindows(text) {
  const spans = [];
  for (const re of [INJ_ANCHOR, INJ_ANCHOR_MARK]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const nl = text.lastIndexOf('\n', Math.max(0, m.index - WINDOW_BEFORE));
      const from = nl < 0 || m.index - nl > WINDOW_BEFORE + 200 ? Math.max(0, m.index - WINDOW_BEFORE) : nl;
      const to = Math.min(text.length, m.index + m[0].length + WINDOW_AFTER);
      spans.push([from, to]);
      // Anchors well inside a window already covered are skipped; one near its end still gets its
      // own window, since a pattern reaches up to ~150 characters past its anchor.
      re.lastIndex = Math.max(re.lastIndex, to - 200);
    }
  }
  spans.sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const sp of spans) {
    const last = out[out.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else out.push(sp);
  }
  return out;
}

function matchInjection(text, offsetOf = (i) => i, windows = anchorWindows(text)) {
  if (!windows.length) return [];
  const hits = [];
  for (const p of INJECTION) {
    let hit = null;
    for (const [from, to] of windows) {
      const part = from === 0 && to === text.length ? text : text.slice(from, to);
      for (const re of p.res) {
        const m = re.exec(part);
        if (!m) continue;
        const at = from + m.index;
        if (p.carries && !INJ_CARRIES.test(text.slice(at + m[0].length, at + 200))) continue;
        if (inDocContext(text, at, m[0].length)) continue;
        hit = { id: p.id, label: p.label, at: offsetOf(at), match: m[0], supporting: !!p.supporting };
        break;
      }
      if (hit) break;
    }
    if (hit) hits.push(hit);
  }
  return hits.some((h) => !h.supporting) ? hits : [];
}

// Called only when the plain text had anchors but no match, or holds zero-width characters. The
// split-letter and leetspeak checks look only at the anchor windows: an obfuscated attack still
// sits next to plain words ("previous instructions", "~/.ssh").
function deobfuscate(text, windows) {
  const near = windows.map(([a, b]) => text.slice(a, b)).join('\n');
  const leet = HAS_LEET.test(near);
  if (!HAS_ZERO_WIDTH.test(text) && !leet && !HAS_SPLIT.test(near)) return null;
  const drop = new Uint8Array(text.length);
  for (const m of text.matchAll(ZERO_WIDTH)) drop[m.index] = 1;
  for (const m of text.matchAll(SPLIT_LETTERS))
    for (let i = 0; i < m[0].length; i++) if (!/[a-z]/i.test(m[0][i])) drop[m.index + i] = 1;
  let s = '';
  const map = [];
  for (let i = 0; i < text.length; i++)
    if (!drop[i]) {
      s += text[i];
      map.push(i);
    }
  // 1gn0re → ignore: digits inside words become the letters they stand for (length is kept).
  if (leet)
    s = s.replace(/\b[a-z0-9@$]*[a-z][a-z0-9@$]*\b/gi, (w) =>
      /\d/.test(w) ? w.replace(/[013457@$]/g, (ch) => LEET[ch]) : w,
    );
  return { s, map };
}

// Returns null, or the matched categories: { id, label, at, match } of the most severe one (as
// before), plus `categories` and `labels` with every category that matched. `label` joins them
// ("Exfiltration request + Instruction override") so a parser that stores only the label keeps all.
function scanInjection(text) {
  const s = String(text || '');
  if (s.length < 8) return null;
  const windows = anchorWindows(s);
  let hits = matchInjection(s, undefined, windows);
  if (!hits.length && (windows.length || HAS_ZERO_WIDTH.test(s))) {
    const d = deobfuscate(s, windows);
    if (d) hits = matchInjection(d.s, (i) => d.map[i] ?? 0);
  }
  if (!hits.length) return null;
  const [top] = hits;
  return {
    id: top.id,
    label: hits.map((h) => h.label).join(' + '),
    at: top.at,
    match: top.match,
    categories: hits.map((h) => h.id),
    labels: hits.map((h) => h.label),
  };
}

/* ---------- Secrets ---------- */

// Each pattern has its own prefix, so one key gets one label (an Anthropic key is not also OpenAI).
const SECRETS = [
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenRouter API key', /\bsk-or-v1-[A-Fa-f0-9]{32,}/g],
  ['OpenAI API key', /\bsk-(?!ant-|or-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Stripe secret key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/g],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{34,}\b/g],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  [
    'Database URL with password',
    /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver|cockroachdb)(?:\+\w+)?:\/\/[^\s:/@'"`]*:([^\s@'"`/]{3,})@[\w.-]+/gi,
  ],
];
const SECRET_HINT = /sk-|AKIA|ASIA|gh[pousr]_|github_pat_|xox|AIza|k_live_|k_test_|hf_|eyJ|PRIVATE KEY|:\/\//;
const PLACEHOLDER = /your|example|placeholder|dummy|sample|xxxx|replace|redacted|\.\.\.|[<>]|\*\*|••/i;
const PLACEHOLDER_PASSWORD =
  /^(?:password|passwd|pass|pwd|secret|changeme|example|test|root|admin|user|x{3,}|\*+|•+|<[^>]*>|\$\{?[A-Za-z_]\w*\}?|\{\{.*\}\}|%[A-Z_]+%|\[.*\])$/i;

// Documentation placeholders and low-variety strings ("sk-xxxx…") are not live keys.
function isLiveSecret(label, m) {
  if (label === 'Private key') return true;
  if (label === 'Database URL with password') return !PLACEHOLDER_PASSWORD.test(m[1]) && !/[•*]{3}/.test(m[1]);
  const v = m[0];
  if (PLACEHOLDER.test(v)) return false;
  if (label === 'AWS access key' && /EXAMPLE$/.test(v)) return false;
  return new Set(v.slice(Math.min(8, Math.max(0, v.length - 16)))).size >= 10;
}

// Labels of the secret types present. The value itself is never returned or stored.
function scanSecrets(text) {
  const s = String(text || '');
  if (!SECRET_HINT.test(s)) return [];
  const found = [];
  for (const [label, re] of SECRETS) {
    re.lastIndex = 0;
    for (let m = re.exec(s), n = 0; m && n < 20; m = re.exec(s), n++)
      if (isLiveSecret(label, m)) {
        found.push(label);
        break;
      }
    re.lastIndex = 0;
  }
  return found;
}

// Where each live secret sits in the text, for masking. Same patterns and placeholder checks as
// scanSecrets. For a database URL only the password is masked, so the host stays readable; `matchStart`
// is where the whole pattern match begins (the URL), so a page cut can avoid splitting it.
function secretSpans(text) {
  const s = String(text || '');
  if (!SECRET_HINT.test(s)) return [];
  const found = [];
  for (const [label, re] of SECRETS) {
    re.lastIndex = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      if (!isLiveSecret(label, m)) continue;
      if (label === 'Database URL with password') {
        const at = m.index + m[0].indexOf(`:${m[1]}@`, m[0].indexOf('://') + 3) + 1;
        found.push({ start: at, end: at + m[1].length, label, matchStart: m.index });
      } else found.push({ start: m.index, end: m.index + m[0].length, label, matchStart: m.index });
    }
    re.lastIndex = 0;
  }
  // Patterns can overlap (a JWT tail after a key): merge into the union, keeping the first label.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const f of found) {
    const last = out[out.length - 1];
    if (last && f.start < last.end) {
      last.end = Math.max(last.end, f.end);
      last.matchStart = Math.min(last.matchStart, f.matchStart);
    } else out.push(f);
  }
  return out;
}

/* ---------- Risky commands ---------- */

const RISKY_ORDER = [
  'Recursive force delete',
  'Find and delete',
  'Delete untracked files',
  'Force push',
  'Hard reset',
  'Pipe to shell',
  'sudo',
  'World-writable permissions',
  'Kill processes',
  'Drop database objects',
  'Raw disk write',
];
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash']);
const INTERPRETERS = new Set(['python', 'python3', 'perl', 'ruby', 'node']);
const DB_CLIENTS = new Set([
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'sqlcmd',
  'mongo',
  'mongosh',
  'clickhouse-client',
  'cockroach',
  'duckdb',
  'snowsql',
  'bq',
  'redis-cli',
]);
const WRAPPERS = new Set(['time', 'nohup', 'command', 'exec', 'builtin', 'caffeinate', 'stdbuf', 'unbuffer']);
const DROP_SQL = /\bdrop\s+(?:table|database|schema|collection)\b|\.dropDatabase\(|\.drop\(\)/i;
const DOWNLOAD = /^(?:curl|wget|fetch|http|iwr|invoke-webrequest)$/i;
const SHELL_C = /^-[a-z]*c[a-z]*$/;

// Index of the ")" (or "`") that closes a body starting at `from`, honouring quotes and nesting.
function closingAt(src, from, open) {
  let depth = 1;
  let q = null;
  let j = from;
  for (; j < src.length; j++) {
    const c = src[j];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"') j++;
    } else if (open === '`') {
      if (c === '`') break;
    } else if (c === "'" || c === '"') q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) break;
  }
  return j;
}

// Splits a shell command into simple commands ({ words, pipe }), where commands sharing `pipe`
// form one pipeline. Quotes are honoured and comments dropped; the bodies of $(…), `…` and <(…)
// come back in `nested` so they are checked as commands too.
function shellParse(src) {
  const cmds = [];
  const nested = [];
  let words = [];
  let w = null;
  let pipe = 0;
  let i = 0;
  const end = () => {
    if (w !== null) words.push(w);
    w = null;
  };
  const finish = (sep) => {
    end();
    if (words.length) cmds.push({ words, pipe });
    words = [];
    if (sep !== '|') pipe++;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const stop = j < 0 ? src.length : j;
      w = (w || '') + src.slice(i + 1, stop);
      i = stop + 1;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\' && j + 1 < src.length) s += src[++j];
        else if (src[j] === '$' && src[j + 1] === '(') {
          const k = closingAt(src, j + 2, '(');
          nested.push(src.slice(j + 2, k));
          s += src.slice(j, k + 1);
          j = k;
        } else s += src[j];
      }
      w = (w || '') + s;
      i = j + 1;
    } else if (c === '\\') {
      w = (w || '') + (src[i + 1] || '');
      i += 2;
    } else if ((c === '$' || c === '<' || c === '>') && src[i + 1] === '(') {
      const j = closingAt(src, i + 2, '(');
      const body = src.slice(i + 2, j);
      nested.push(body);
      w = (w || '') + `${c}(${body})`;
      i = j + 1;
    } else if (c === '`') {
      const j = closingAt(src, i + 1, '`');
      const body = src.slice(i + 1, j);
      nested.push(body);
      w = (w || '') + `\`${body}\``;
      i = j + 1;
    } else if (c === '#' && w === null) {
      const j = src.indexOf('\n', i);
      i = j < 0 ? src.length : j;
    } else if (c === '\n' || c === ';' || c === '(' || c === ')') {
      finish(c);
      i++;
    } else if (c === '&' || c === '|') {
      const two = src[i + 1] === c;
      finish(two ? c + c : c);
      i += two ? 2 : 1;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      end();
      i++;
    } else {
      w = (w || '') + c;
      i++;
    }
  }
  finish(';');
  return { cmds, nested };
}

const base = (w) => String(w || '').replace(/^.*\//, '');
const shortFlags = (args, ch) => args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(ch));
const isAssign = (x) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(x);

// The words of the command that actually runs, past env assignments and wrappers (sudo, env,
// nice, timeout, xargs, nohup…). `found` gets 'sudo' when sudo or doas is one of the wrappers.
function unwrap(words, found) {
  let ws = words.filter((x) => x !== '');
  for (let guard = 0; guard < 8 && ws.length; guard++) {
    while (ws.length && isAssign(ws[0])) ws = ws.slice(1);
    const c = base(ws[0]);
    if (c === 'sudo' || c === 'doas') {
      found.add('sudo');
      ws = ws.slice(1);
      while (ws.length && ws[0].startsWith('-')) ws = ws.slice(/^-[ugChpD]$/.test(ws[0]) ? 2 : 1);
    } else if (c === 'env') {
      ws = ws.slice(1);
      while (ws.length && ws[0].startsWith('-')) ws = ws.slice(/^-[uSC]$/.test(ws[0]) ? 2 : 1);
    } else if (c === 'nice' || c === 'timeout' || c === 'watch') {
      ws = ws.slice(1);
      while (ws.length && (ws[0].startsWith('-') || /^\d/.test(ws[0]))) ws = ws.slice(/^-[nsk]$/.test(ws[0]) ? 2 : 1);
    } else if (c === 'xargs') {
      ws = ws.slice(1);
      while (ws.length && ws[0].startsWith('-')) ws = ws.slice(/^-[IdEnLPsa]$/.test(ws[0]) ? 2 : 1);
    } else if (WRAPPERS.has(c)) ws = ws.slice(1);
    else break;
  }
  return ws;
}

// Adds the risky labels of one simple command to `found`; scripts it runs (bash -c "…") go to `more`.
function riskyWords(words, found, more) {
  const ws = unwrap(words, found);
  if (!ws.length) return;
  const cmd = base(ws[0]);
  const args = ws.slice(1);
  // Running the output of a download: sh -c "$(curl …)" or eval "$(wget …)".
  if (/^(?:[$<]\(|`)\s*(?:curl|wget)\b/.test(ws[0])) found.add('Pipe to shell');
  if (SHELLS.has(cmd) || cmd === 'eval' || cmd === 'source' || cmd === '.') {
    const ci = args.findIndex((a) => SHELL_C.test(a));
    if (cmd === 'eval') more.push(args.join(' '));
    else if (ci >= 0 && args[ci + 1] != null) more.push(args[ci + 1]);
    if (args.some((a) => /^<\(\s*(?:curl|wget)\b/.test(a))) found.add('Pipe to shell');
    return;
  }
  if (cmd === 'rm') {
    const flags = [];
    for (const a of args) {
      if (a === '--') break;
      if (a.startsWith('-')) flags.push(a);
    }
    const short = (ch) => flags.some((f) => /^-[A-Za-z]+$/.test(f) && ch.test(f));
    if ((flags.includes('--recursive') || short(/[rR]/)) && (flags.includes('--force') || short(/f/)))
      found.add('Recursive force delete');
  } else if (cmd === 'find') {
    if (args.includes('-delete')) found.add('Find and delete');
    const ei = args.findIndex((a) => a === '-exec' || a === '-execdir' || a === '-ok');
    if (ei >= 0) {
      const sub = [];
      for (const a of args.slice(ei + 1)) {
        if (a === ';' || a === '+') break;
        sub.push(a);
      }
      if (/^(?:rm|unlink|shred)$/.test(base(sub[0]))) found.add('Find and delete');
      riskyWords(sub, found, more);
    }
  } else if (cmd === 'git') {
    let k = 0;
    while (k < args.length && args[k].startsWith('-'))
      k += /^-(?:C|c)$|^--(?:git-dir|work-tree|namespace)$/.test(args[k]) ? 2 : 1;
    const sub = args[k];
    const rest = args.slice(k + 1);
    if (sub === 'push') {
      if (
        rest.some((a) => /^--force(?:-with-lease)?(?:=|$)|^--mirror$/.test(a)) ||
        shortFlags(rest, 'f') ||
        rest.some((a) => /^\+\S/.test(a))
      )
        found.add('Force push');
    } else if (sub === 'reset' && rest.includes('--hard')) found.add('Hard reset');
    else if (
      sub === 'clean' &&
      (rest.includes('--force') || shortFlags(rest, 'f')) &&
      !rest.includes('--dry-run') &&
      !shortFlags(rest, 'n')
    )
      found.add('Delete untracked files');
  } else if (cmd === 'chmod') {
    if (args.some((a) => /^0?777$|^(?:a|ugo)\+rwx$/.test(a))) found.add('World-writable permissions');
  } else if (cmd === 'kill' || cmd === 'killall') {
    if (args.some((a) => /^-(?:9|KILL|SIGKILL)$/i.test(a)) || /-s (?:9|KILL|SIGKILL)\b/i.test(args.join(' ')))
      found.add('Kill processes');
  } else if (cmd === 'pkill') found.add('Kill processes');
  else if (cmd === 'dd') {
    if (args.some((a) => /^of=\/dev\/(?!null$|zero$|stdout$|stderr$|tty)/.test(a))) found.add('Raw disk write');
  } else if (
    /^mkfs(?:\.\w+)?$/.test(cmd) ||
    (cmd === 'diskutil' && /^(?:erase\w*|partitionDisk|zeroDisk)$/i.test(args[0] || ''))
  )
    found.add('Raw disk write');
  else if (cmd === 'dropdb') found.add('Drop database objects');
  else if ((cmd === 'rails' || cmd === 'rake') && args.includes('db:drop')) found.add('Drop database objects');
  else if (cmd === 'prisma' && /\bmigrate reset\b|--force-reset\b/.test(args.join(' ')))
    found.add('Drop database objects');
}

// Codex sends argv as JSON ({"command":["bash","-lc","…"]}); take the script out of it.
function commandText(cmd) {
  if (Array.isArray(cmd)) return commandText(JSON.stringify(cmd));
  if (typeof cmd !== 'string') return '';
  const t = cmd.trim();
  if (t[0] !== '{' && t[0] !== '[') return cmd;
  try {
    const o = JSON.parse(t);
    const v = Array.isArray(o) ? o : o && (o.command ?? o.cmd ?? o.script ?? o.input);
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
      const ci = v.findIndex((a) => SHELL_C.test(a));
      if (SHELLS.has(base(v[0])) && ci > 0 && typeof v[ci + 1] === 'string') return v[ci + 1];
      return v.map((a) => (/[\s'"|;&]/.test(a) ? `'${String(a).replace(/'/g, `'\\''`)}'` : a)).join(' ');
    }
  } catch {
    /* not JSON after all */
  }
  return cmd;
}

// Labels of the risky operations a shell command performs. Text that only mentions them (an
// echo, a grep pattern, a comment) does not count: the command words are parsed, not the string.
function scanRisky(cmd) {
  const src = commandText(cmd).slice(0, 20000);
  if (!src.trim() || /^\s*\*\*\* Begin Patch/.test(src)) return [];
  const found = new Set();
  const queue = [src];
  let dbClient = false;
  for (let n = 0; n < queue.length && n < 16; n++) {
    const { cmds, nested } = shellParse(queue[n]);
    queue.push(...nested);
    for (let k = 0; k < cmds.length; k++) {
      riskyWords(cmds[k].words, found, queue);
      const ws = unwrap(cmds[k].words, new Set());
      const name = base(ws[0]);
      if (DB_CLIENTS.has(name) || (name === 'supabase' && ws[1] === 'db')) dbClient = true;
      // A download piped into a shell, or into an interpreter reading the script from stdin.
      const runsStdin =
        SHELLS.has(name) || (INTERPRETERS.has(name) && ws.length <= 2 && !ws.slice(1).some((a) => /^-[mc]$/.test(a)));
      if (k > 0 && runsStdin && cmds[k - 1].pipe === cmds[k].pipe) {
        const upstream = cmds.slice(0, k).filter((c) => c.pipe === cmds[k].pipe);
        if (upstream.some((c) => DOWNLOAD.test(base(unwrap(c.words, new Set())[0])))) found.add('Pipe to shell');
      }
    }
  }
  // SQL that drops objects counts when a database client runs it, not when it is grepped or echoed.
  if (dbClient && DROP_SQL.test(src)) found.add('Drop database objects');
  return RISKY_ORDER.filter((l) => found.has(l));
}

/* ---------- Corrections ---------- */

// Prompts that tell the model its own previous output or action was wrong, unwanted or must be
// undone (English and Indonesian). A task that happens to say "fix", "wrong", "perbaiki" or
// "seharusnya" is not a correction; neither is a prompt where the person corrects their own input.
const CORRECTION = [
  /^\s*(?:no|nope|nah|not quite)\b[\s,.!:;-]*(?:that|this|it|you|not|wrong|again|stop|i (?:said|meant|asked|wanted)|the other|don'?t (?:do|change|touch|add|remove|use)|put it back|undo|revert)\b/i,
  /\b(?:that|this|it)(?:'?s| is| was)(?: still| all)? (?:wrong|incorrect|not (?:right|correct|it|what i (?:asked|wanted|meant)))\b/i,
  /\bnot what i (?:asked|wanted|meant|said|want|mean|need)\b/i,
  /\bstill (?:not|isn'?t|doesn'?t|don'?t|won'?t|can'?t|broken|failing|fails|failed|wrong|the same|getting|seeing|shows?|showing|happening|crash(?:es|ing)?|errors?|empty|blank)\b/i,
  /\b(?:failed|fails|failing|broken|broke|wrong|crash(?:ed|es)?|same (?:error|problem|issue|result|thing))(?: once)? again\b/i,
  /\b(?:it|this|that|nothing)(?: still)? (?:doesn'?t|didn'?t|does not|did not|isn'?t|is not) (?:work|working|change|fix|help|compile|build|run|load)/i,
  /^\s*(?:doesn'?t|didn'?t|does not|did not) work\b/i,
  /\byou(?:'ve| have)? (?:forgot|forgotten|missed|broke|broken|ignored|misunderstood|misread|deleted|removed|overwrote|reverted|skipped|didn'?t|did not|haven'?t|have not|should have|were supposed to|ruined|messed up)\b|\byou keep \w+ing\b|\byou (?:used|edited|changed|picked|chose|put|opened|modified) the wrong\b/i,
  /\b(?:undo|revert|roll ?back|restore) (?:that|this|it|those|these|everything|your|the (?:last|previous|change|changes|edit|edits|commit))\b|\bput (?:it|that|this|them|everything) back\b/i,
  /\bwhy (?:did|would|are|do) you\b/i,
  /\bi (?:already )?(?:said|told you)\b|\bi asked (?:you )?(?:for|to|not)\b/i,
  /\b(?:try|do it|start) (?:again|over)\b|\bredo\b/i,
  /\b(?:that|this|your|the) (?:fix|change|edit|commit|update|patch)\b[^.\n]{0,20}?\b(?:introduced|caused|created|broke|breaks)\b/i,
  /\b(?:made|making) (?:it|things|this) worse\b|\b(?:that|this|it) (?:broke|didn'?t help|made it worse)\b|^\s*stop(?:\s+stop)*\s*[,.!]/i,
  /\bi (?:never|didn'?t|did not) (?:ask(?:ed)?|tell you|say|said|want(?:ed)?)\b|\b(?:roll|put|change|set|turn|switch) (?:it|that|this|them|everything) back\b|\brewrite (?:it|them|this|that)\b/i,
  /\b(?:you|u) (?:wrote|made|added|created|generated)\b[^.\n]{0,20}?\b(?:don'?t|dont|doesn'?t|doesnt|do not|does not|isn'?t|aren'?t|is wrong|are wrong|is broken|are broken|never|fails?)\b|\bu (?:forgot|missed|broke|changed|deleted|removed|ignored|didn'?t)\b/i,
  // Indonesian
  /\b(?:kamu|anda|km|kau|lu|lo|elu)\s+(?:salah|keliru|lupa|melupakan|tidak|nggak|ngga|gak|ga|enggak|belum|malah|menghapus|hapus|merusak|ngawur|asal)\b(?!\s+(?:perlu|usah|harus))/i,
  /^\s*(?:salah|keliru)\b\s*[,.!]|\bbukan\b[^.\n]{0,25}?\byang (?:aku|saya|ku|gue|gw) (?:maksud|mau|minta)\b|\bpadahal (?:sudah|udah) (?:kamu|km|lu|lo)\b|\bpadahal (?:aku|saya|gue|gw) (?:sudah |udah )?(?:bilang|minta)\b|\bkembalikan\s*[.!]*$/i,
  /\bbukan (?:begitu|begini|gitu|gini|itu|ini|seperti itu|kayak gitu|yang (?:aku|saya|ku|gue|gw) (?:maksud|mau|minta)|maksud(?:ku|nya| saya| aku))\b/i,
  /\b(?:tidak|nggak|gak|ga|enggak|ngga) (?:seperti|sesuai|sama dengan) (?:yang )?(?:aku|saya|ku|gue|gw) (?:minta|mau|maksud|inginkan|harapkan)/i,
  /\bmasih (?:salah|keliru|error|eror|gagal|belum|sama|rusak|tidak|nggak|gak|ga|enggak|muncul (?:error|eror)|blank|kosong|crash|jelek|berantakan|bug|ada (?:error|bug|masalah))\b|\btet[ae]p (?:salah|error|gagal|sama|tidak|nggak|gak|rusak)\b/i,
  /\bkok (?:malah|masih|jadi|tidak|nggak|gak|ga|belum|dihapus|hilang|berubah|rusak|error|berhenti|gitu|begitu)\b|\b(?:kenapa|mengapa|knp|napa) (?:malah|masih|kamu|dihapus|hilang|berubah|jadi rusak|jadi error)\b/i,
  /\b(?:ini|itu|hasilnya|hasil|outputnya|jawabanmu|jawabannya|kodenya|kodemu|tampilannya) (?:salah(?! satu)|keliru|belum benar|kurang tepat|(?:tidak|nggak|gak) (?:benar|tepat|sesuai|jalan|berfungsi)|rusak|ngaco|ngawur)\b/i,
  /\b(?:tolong )?coba (?:lagi|ulang|sekali lagi)\b|\bulangi\b|\b(?:buat|bikin|kerjakan|tulis|gambar) ulang\b/i,
  /\bkembalikan (?:seperti (?:semula|sebelumnya|tadi)|ke (?:semula|sebelumnya|versi sebelumnya)|perubahan|yang tadi)\b|\bbalikin(?: (?:lagi|kayak tadi|seperti semula))?\b|\b(?:batalkan|batalin) (?:perubahan|yang tadi|itu|commit|edit)\b/i,
  /\bsalah (?:paham|tangkap|file|tempat|ambil|mengambil|folder|baris|fungsi|halaman)\b|\b(?:sudah|udah|kan) (?:aku|saya|gue|gw) (?:bilang|bilangin|katakan|minta)\b|\bmelenceng\b|\bngawur\b/i,
  /\bperbaiki (?:lagi|yang tadi|kesalahan(?:mu|nya)?|hasilnya)\b|\b(?:jadi|malah) (?:rusak|error|eror|hilang|berantakan|gagal|tambah parah)\b|\bbelum (?:sesuai|benar|berhasil|jalan|berjalan|muncul|berubah|beres)\b|\b(?:seharusnya|harusnya|mestinya) (?:kamu|bukan|jangan)\b/i,
];
const SELF_CORRECTION =
  /\b(?:saya|aku|gue|gw) (?:yang )?(?:salah|keliru|typo|lupa)\b|\bsalah ketik\b|\bmy (?:mistake|bad|fault)\b|\bi (?:made a )?(?:typo|mistake)\b|\b(?:sorry|oops),? i meant\b|\bmaaf,? (?:maksud|saya|aku)\b/i;

// opts.afterAssistant === false (a session's first prompt, before the model did anything) is never
// a correction: there is no output yet to correct. Without opts it judges the text alone.
function isCorrection(text, opts) {
  if (opts && opts.afterAssistant === false) return false;
  const t = String(text || '')
    .trim()
    .slice(0, 400);
  return CORRECTION.some((re) => re.test(t)) && !SELF_CORRECTION.test(t);
}

/* ---------- Failed tool calls ---------- */

// Display labels. The ids are stable: they are stored in the index cache and used by the UI.
const CATEGORY = {
  hallucination: 'Acted on a non-existent target',
  process: 'Misused a tool or skipped a step',
  execution: 'Command or test failed',
  environment: 'Network, timeout or environment',
  rejection: 'Rejected by you or a guardrail',
  other: 'Other tool error',
};

const SHELL_TOOL = /^(?:Bash|shell|local_shell|exec_command|container\.exec|unified_exec|run_command|terminal)$/i;
// Probing for something that may be missing (ls dist, cat .env.local, which docker) is normal
// exploration, not acting on a made-up target.
const PROBE =
  /(?:^|\n)\s*(?:(?:\/bin\/|\/usr\/bin\/)?(?:ba|z)?sh: (?:line \d+: )?)?(?:ls|cat|stat|head|tail|find|du|wc|file|readlink|realpath|test|cd|less|more|tree|diff|grep|egrep|rg|ag|source|bat|xxd|od|md5|shasum|sha256sum|type)(?::| )[^\n]*(?:No such file or directory|Tidak ada berkas atau direktori|cannot access|cannot stat|tidak dapat mengakses|no such file)|(?:^|\n)\s*which: no \S+ in|(?:^|\n)\s*cd: no such file or directory/i;
const MISSING_PATH =
  /File does not exist|No such file or directory|Tidak ada berkas atau direktori|ENOENT|path does not exist|does not exist\. Note: your current working directory|Not a directory|Cannot find module ['"](?:[A-Za-z]:)?[/\\][^'"]*\.[cm]?[jt]sx?['"]/i;
const MISSING_PACKAGE =
  /npm (?:ERR!|error) (?:code )?E404|npm (?:ERR!|error) 404|404 Not Found - GET https?:\/\/registry\.|No matching distribution found for|Could not find a version that satisfies the requirement|no matching package named|ERR_PNPM_FETCH_404|Couldn't find package|E: Unable to locate package|No available formula with the name|could not find `[^`]+` in registry|is not in (?:the|this) registry/i;
const MISSING_COMMAND =
  /command not found|perintah tidak ditemukan|is not recognized as an internal or external command|is not recognized as the name of a cmdlet|Missing script:|npm (?:ERR!|error) missing script|error: unknown (?:option|command|flag|argument)|unknown (?:option|flag|command|shorthand flag)[: ]|unrecognized (?:option|arguments?)|invalid option --|is not an? [\w-]+ command|No such command|Unknown command:|unknown options?:|(?:unrecognized|unknown|invalid|no such) subcommand/i;

// Returns [category, kind] for a failed tool result.
function classifyError(text, tool) {
  text = String(text || '');
  if (
    /doesn'?t want to proceed|was rejected|denied by|Permission for this|permission request failed|user (declined|rejected)|blocked by (a )?hook/i.test(
      text,
    )
  )
    return ['rejection', 'Rejected by you or a guardrail'];
  if (/has not been read yet|Read it first|modified since (it was )?(last )?read/i.test(text))
    return ['process', 'Edited without reading first'];
  if (/Found \d+ matches of the string to replace/i.test(text)) return ['process', 'Edit text matched more than once'];
  if (/String to replace not found|old_string (was )?not found|no match(es)? for old_string/i.test(text))
    return ['hallucination', 'Edit text not in the file'];
  if (
    /InputValidationError|Invalid arguments|Input validation error|-32602|No such tool|Unknown tool|unexpected (parameter|argument|property)|is not a valid (enum|option)/i.test(
      text,
    )
  )
    return ['hallucination', 'Invalid tool arguments'];
  if (MISSING_PACKAGE.test(text)) return ['hallucination', 'Package that does not exist'];
  if (MISSING_COMMAND.test(text)) return ['hallucination', 'Command or option that does not exist'];
  if (/^(WebFetch|web_fetch|fetch|browser)/i.test(tool || '') && /\b404\b|Not Found|ENOTFOUND|getaddrinfo/i.test(text))
    return ['hallucination', 'URL that does not exist'];
  // A host that does not resolve is treated like a 404: the name was made up or mistyped. A
  // temporary DNS failure (EAI_AGAIN) stays an environment error below.
  if (
    /The requested URL returned error: 404|ERROR 404: Not Found|Could not resolve host|unable to resolve host address|getaddrinfo ENOTFOUND/.test(
      text,
    )
  )
    return ['hallucination', 'URL that does not exist'];
  if ((!tool || SHELL_TOOL.test(tool)) && PROBE.test(text)) return ['execution', 'Path check found nothing'];
  if (MISSING_PATH.test(text)) return ['hallucination', 'Path that does not exist'];
  if (
    /timed? ?out|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Could not resolve host|certificate|socket hang up|rate.?limit|\b(429|502|503|529)\b|overloaded|AbortError|interrupted|no verdict|maxContentLength|Browser pane|No site is open|session ended/i.test(
      text,
    )
  )
    return ['environment', 'Network, timeout or environment'];
  if (/Exit code [1-9]|Traceback|exit_code":\s*[1-9]|Script failed|\bFAIL\b|Error:/i.test(text))
    return ['execution', 'Command or test failed'];
  return ['other', 'Other tool error'];
}

const isExternalTool = (name) =>
  /^(WebFetch|WebSearch|web_search|web_fetch|browser)/i.test(name || '') || /^mcp__/.test(name || '');

// Masks anything secret-shaped and trims to a short single line.
function snippet(text, at = 0, len = 160) {
  let s = String(text || '');
  if (at > 60) s = '…' + s.slice(at - 60);
  s = s.replace(/\s+/g, ' ').trim();
  for (const [label, re] of SECRETS)
    s = s.replace(new RegExp(re.source, re.flags), (m, pw) =>
      label === 'Database URL with password' && pw ? m.replace(`:${pw}@`, ':•••@') : m.slice(0, 6) + '•••',
    );
  return s.length > len ? s.slice(0, len - 1) + '…' : s;
}

// Model names that would reach Object.prototype as a key of `models`.
const MODEL_RESERVED = ['__proto__', 'constructor', 'prototype'];
// Collects counts per local day and a capped list of notable events for one log file.
class SignalSink {
  constructor(tool) {
    this.tool = tool;
    this.days = {};
    this.events = [];
    this.perKind = {};
    // Set by TurnGrader.prompt(): the current prompt came before any model output in its session.
    // Both parsers record a correction right after grader.prompt(), so it is dropped here.
    this.firstPrompt = false;
  }

  day(ts) {
    const d = new Date(ts);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return (this.days[k] ||= { calls: 0, results: 0, failures: 0, cats: {}, kinds: {} });
  }

  // Any numeric counter (calls, results, external, injExternal, secrets, risky, ...).
  count(ts, field, n = 1) {
    if (!Number.isFinite(ts)) return;
    if (field === 'corrections' && this.firstPrompt) return;
    const d = this.day(ts);
    d[field] = (d[field] || 0) + n;
  }

  failure(ts, category, kind) {
    if (!Number.isFinite(ts)) return;
    const d = this.day(ts);
    d.failures++;
    d.cats[category] = (d.cats[category] || 0) + 1;
    d.kinds[kind] = (d.kinds[kind] || 0) + 1;
  }

  // A tool result counted for the model that made the call (Cost Control: tool-call accuracy per model). The name is
  // kept as the log writes it; readers normalize it (lib/quality.js accuracyByModel). `category` is the failure's.
  modelResult(ts, model, category = null) {
    if (!Number.isFinite(ts) || typeof model !== 'string' || !model || model.length > 200) return;
    if (MODEL_RESERVED.includes(model)) return;
    const d = this.day(ts);
    const models = (d.models ||= {});
    const m = (models[model] ||= { results: 0, cats: {} });
    m.results++;
    if (category) m.cats[category] = (m.cats[category] || 0) + 1;
  }

  event(ev) {
    if (ev.kind === 'correction' && this.firstPrompt) return;
    const cap = ev.kind === 'error' ? 150 : 60;
    const n = (this.perKind[ev.kind] = (this.perKind[ev.kind] || 0) + 1);
    if (n <= cap) this.events.push({ ...ev, tool: ev.tool || this.tool });
  }

  result() {
    return { days: this.days, events: this.events };
  }
}

// Answer relevance and faithfulness per turn (a typed prompt and everything the model did until the
// next one), computed locally without a judge model and without keeping any text:
//  - relevance: the share of the prompt's key terms (words minus stop words, plus paths, identifiers
//    and numbers) that the reply and the turn's tool calls address; half of the terms counts as fully
//    relevant, because a good answer never repeats every word of the question.
//  - faithfulness: of the checkable references in the reply (file names, `identifiers`, URLs and
//    numbers with three or more digits, decimals or %), the share that appeared in the session's
//    context: your prompts, tool inputs and tool results. A reference seen nowhere is unsupported.
const STOP = new Set(
  (
    'the and for are but not you your with this that from have has had was were will would could should can what when where which who how why ' +
    "all any into onto out over under than then them they their there these those its it's our ours his her him she was been being does did done doing just only also very more most " +
    'please make sure need want like use using used let lets about again still yes yeah okay one two get got put see show tell give take try ' +
    'yang dan di ke dari untuk dengan ini itu ada atau juga sudah belum akan bisa harus agar supaya pada dalam sebagai karena jadi saja lagi tidak bukan kalau jika maka ' +
    'saya aku kamu anda kita kami mereka dia nya lah kah pun ya oke tolong buat buatkan lakukan coba mau ingin sekarang nanti semua setiap tersebut seperti sama lebih ' +
    'apa apakah bagaimana kenapa mengapa dimana kapan siapa berapa mana bagian hal cara'
  ).split(' '),
);
// File names are found per token: a run of path characters that starts at a token boundary and
// contains a dot; only its last segment is checked against the extensions. The single regex used
// before backtracked quadratically on long identifier runs (37% of indexing CPU on code-heavy logs).
const PATH_TOKEN = /(?<![\w./-])[\w/-]*\.[\w./-]*/g;
const FILE_NAME =
  /^[\w-][\w.-]*\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|swift|rb|php|c|h|cpp|cs|json|md|yml|yaml|toml|ini|css|scss|html|sh|sql|txt|csv|png|svg)$/i;
const URL_RE = /https?:\/\/[^\s)<>"'`\]]+/gi;
const TICK_RE = /`([^`\n]{3,60})`/g;
const NUM_RE = /(?<![\w.])\d[\d,]*(?:\.\d+)?%?(?![\w])/g;
const WORD_RE = /[\w.$@-]{3,}/g;
const termsOf = (text) => [
  ...new Set(
    (
      String(text)
        .toLowerCase()
        .match(/[a-z0-9À-ɏ_]{3,}/g) || []
    ).filter((w) => !STOP.has(w) && !/^\d+$/.test(w)),
  ),
];
const normNum = (n) => n.replace(/,/g, '').replace(/\.0+%?$/, (m) => (m.endsWith('%') ? '%' : ''));
function fileNames(s, out) {
  for (const m of s.matchAll(PATH_TOKEN)) {
    let t = m[0];
    while (t.endsWith('.')) t = t.slice(0, -1);
    const name = t.slice(t.lastIndexOf('/') + 1);
    if (FILE_NAME.test(name)) out.add(`file:${name.toLowerCase()}`);
  }
}
// Checkable references in a piece of text, normalised so a full path and its file name match.
function references(text) {
  const s = String(text || '');
  const out = new Set();
  const hasUrl = s.includes('://');
  if (hasUrl)
    for (const m of s.match(URL_RE) || [])
      out.add(
        `url:${m
          .replace(/[.,;:!?]+$/, '')
          .replace(/\/$/, '')
          .toLowerCase()}`,
      );
  const noUrl = hasUrl ? s.replace(URL_RE, ' ') : s;
  fileNames(noUrl, out);
  if (noUrl.includes('`'))
    for (const m of noUrl.matchAll(TICK_RE)) {
      const t = m[1].trim();
      if (/^[\w.$:/@-]+$/.test(t) && !/^\d/.test(t))
        out.add(`id:${t.split('/').pop().replace(/\(\)$/, '').toLowerCase()}`);
    }
  for (const m of noUrl.match(NUM_RE) || []) {
    if (m.length < 3 && !m.endsWith('%')) continue; // "42" never qualifies, "5%" does
    const n = normNum(m);
    if (n.replace(/[^\d]/g, '').length >= 3 || /[.%]/.test(n)) out.add(`num:${n}`);
  }
  return out;
}
// FNV-1a over the length, head and tail: enough to recognise the same tool output seen again.
function textKey(s) {
  let h = 0x811c9dc5 ^ s.length;
  const mix = (i) => {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  };
  for (let i = 0; i < 256; i++) mix(i);
  for (let i = Math.max(256, s.length - 256); i < s.length; i++) mix(i);
  return h >>> 0;
}
const CONTEXT_CAP = 60000;
const TEXT_CAP = 40000;
// Tool results are the bulk of the context; the head of a long result holds what replies cite.
const RESULT_CAP = 16000;
class TurnGrader {
  constructor(sink) {
    this.sink = sink;
    this.ctx = new Map();
    this.turn = null;
    this.acted = new Set(); // sessions where the model has replied or called a tool
  }
  context(sid) {
    let c = this.ctx.get(sid);
    if (!c) {
      c = { refs: new Set(), words: new Set(), seen: new Set(), urls: [] };
      this.ctx.set(sid, c);
    }
    return c;
  }
  // Whether the model has replied or acted in this session yet (a correction needs something to correct).
  hasActed(sid) {
    return this.acted.has(sid);
  }
  // Everything the model could ground a reply in: prompts, tool inputs and tool results.
  // Bounded: an identical text (the same file read again) is learned once, and nothing more is
  // scanned once both sets are full.
  learn(sid, text, cap = TEXT_CAP) {
    const c = this.context(sid);
    const refsFull = c.refs.size >= CONTEXT_CAP;
    const wordsFull = c.words.size >= CONTEXT_CAP;
    if (refsFull && wordsFull) return;
    const s = String(text || '').slice(0, cap);
    if (s.length > 256) {
      const key = textKey(s);
      if (c.seen.has(key)) return;
      if (c.seen.size < 20000) c.seen.add(key);
    }
    if (!refsFull)
      for (const r of references(s)) {
        if (r.startsWith('url:') && !c.refs.has(r)) c.urls.push(r);
        c.refs.add(r);
      }
    if (!wordsFull)
      for (const w of s.toLowerCase().match(WORD_RE) || [])
        c.words.add(w.charCodeAt(w.length - 1) === 46 ? w.replace(/[.]+$/, '') : w);
  }
  prompt(ts, sid, text) {
    this.close();
    this.learn(sid, text);
    if (this.sink) this.sink.firstPrompt = !this.acted.has(sid);
    this.turn = { ts, sid, prompt: String(text || '').slice(0, TEXT_CAP), reply: '', work: '' };
  }
  reply(text) {
    if (!this.turn) return;
    const t = String(text || '');
    if (t.trim()) this.acted.add(this.turn.sid);
    this.turn.reply += `\n${t.slice(0, TEXT_CAP)}`;
  }
  toolInput(sid, text) {
    this.acted.add(sid);
    this.learn(sid, text);
    if (this.turn) this.turn.work += `\n${String(text || '').slice(0, 4000)}`;
  }
  toolResult(sid, text) {
    this.learn(sid, text, RESULT_CAP);
  }
  close() {
    const t = this.turn;
    this.turn = null;
    if (!t || !t.reply.trim()) return;
    const c = this.context(t.sid);
    // Relevance: prompts with fewer than 3 key terms ("ok", "lanjut") are not graded.
    const terms = [
      ...termsOf(t.prompt),
      ...[...references(t.prompt)].map((r) => r.split(':').slice(1).join(':')),
    ].slice(0, 40);
    if (terms.length >= 3) {
      const corpus = `${t.reply}\n${t.work}`.toLowerCase();
      const hit = terms.filter((w) => corpus.includes(w)).length;
      const score = Math.min(1, (hit / terms.length) * 2);
      this.sink.count(t.ts, 'relTurns');
      this.sink.count(t.ts, 'relSum', score);
      if (score < 0.3)
        this.sink.event({
          ts: t.ts,
          sid: t.sid,
          kind: 'relevance',
          label: `Low relevance · ${Math.round(score * 100)}%`,
          text: snippet(t.prompt, 0, 140),
        });
    }
    // Faithfulness: references in the reply that the context never showed.
    const claims = [...references(t.reply)];
    if (claims.length) {
      const grounded = (r) => {
        const v = r.slice(r.indexOf(':') + 1);
        return (
          c.refs.has(r) ||
          c.words.has(v) ||
          (r.startsWith('num:') && c.words.has(v.replace('%', ''))) ||
          (r.startsWith('url:') && c.urls.some((x) => x.startsWith(r) || r.startsWith(x)))
        );
      };
      const missing = claims.filter((r) => !grounded(r));
      this.sink.count(t.ts, 'faithClaims', claims.length);
      this.sink.count(t.ts, 'faithGrounded', claims.length - missing.length);
      if (missing.length)
        this.sink.event({
          ts: t.ts,
          sid: t.sid,
          kind: 'unsupported',
          label: `${missing.length} of ${claims.length} references unsupported`,
          text: snippet(missing.map((r) => r.slice(r.indexOf(':') + 1)).join(' · '), 0, 160),
        });
    }
  }
}

module.exports = {
  INJECTION,
  CATEGORY,
  classifyError,
  isExternalTool,
  scanInjection,
  scanSecrets,
  secretSpans,
  scanRisky,
  isCorrection,
  snippet,
  SignalSink,
  TurnGrader,
  references,
  termsOf,
};
