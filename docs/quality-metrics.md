# Quality and safety metrics: how they are measured

The Quality & safety page counts signals that ZAAFPulse finds in your local Claude Code and Codex
logs. Every one comes from a heuristic detector (`lib/signals.js`): a set of patterns and small
parsers, with no model judging the logs and nothing sent anywhere. Heuristics make mistakes. This
page shows how often, measured on a labelled corpus, and how the numbers were obtained.

**The corpus is synthetic.** It was written by hand and by AI agents for this purpose, not taken
from anyone's real logs (we have none and want none). It contains realistic phrasing, English and
Indonesian, and deliberate hard cases, but real logs will contain patterns it does not. Read the
numbers below as "how the detectors behave on the cases we thought of", not as a guarantee.

## The detectors

| Detector | What counts | What does not count |
|---|---|---|
| Corrections | A prompt telling the model that its own previous output was wrong, unwanted or must be undone: "that's not what I asked", "undo that", "still failing", "masih error", "bukan begitu maksudku" | A new task that mentions a bug ("fix the failing test", "perbaiki bug login"), an answer to the model's question ("no, just the backend"), correcting your own message ("sorry, I meant…", "saya salah ketik"), and **any prompt before the model has replied or acted in that session** |
| Prompt injection | Tool output that tries to steer the model: override instructions (English, Indonesian, Spanish, French, German, Portuguese, Chinese; paraphrases; spelled out or hidden with zero-width characters or digits), persona change, requests to send or reveal secrets, hide-from-user instructions, fake role tags or authority ("new task from the user", "pre-approved"), commands to run without asking | Text that quotes attacks (security docs, red-team suites, detector code, test samples), chat-template docs (`[INST]`, `<\|im_start\|>`), XML `<system>` elements, an AGENTS.md telling assistants to run the tests |
| Secrets | Anthropic, OpenAI, OpenRouter, AWS, GitHub (classic and fine-grained), Slack, Google, Stripe, Hugging Face keys, JSON Web Tokens, private keys, database URLs with a password | Placeholders (`sk-xxxx…`, `YOUR_KEY`, `${DB_PASSWORD}`, `user:password@`), AWS documentation keys ending in `EXAMPLE`, masked values, low-variety strings |
| Risky commands | Recursive force delete (any flag spelling), find with `-delete`/`-exec rm`, `git clean -f`, force push (`-f`, `--force`, `--force-with-lease`, `+refspec`), hard reset, a download piped into a shell, `sudo` anywhere in the command (also inside `bash -c "…"` and Codex argv JSON), `chmod 777`, `kill -9`, dropping database objects through a database client, writing to a disk device | The same words in an `echo`, a `grep` pattern, a comment or a dry run. The command is parsed into words, not searched as a string |
| Non-existent target (id `hallucination`) | A failed call that acted on something that does not exist: a file path, edit text, a tool argument or tool name, a URL or host, a package, a command, subcommand, flag or npm script | Probes that were allowed to find nothing (`ls dist`, `cat .env.local`, `which docker`), failing tests, type and lint errors, network errors, rejections |

Each detector records what it matched, so the lists on the page can be checked by eye. Secrets
are stored by type only; the value never leaves the parser, and snippets mask anything secret-shaped.

## Accuracy: which failures count against the model

Accuracy is the share of tool calls that did not fail because of the model. Only two categories
count against it:

| Category id | Shown as | Counted | Why |
|---|---|---|---|
| `hallucination` | Acted on a non-existent target | yes | The model named something that is not there |
| `process` | Misused a tool or skipped a step | yes | Editing a file it had not read; an edit whose text matched more than once |
| `execution` | Command or test failed | **no** (counted in 1.0.3 and earlier) | Tests are often run to watch them fail (TDD red runs, a check before a fix), and a build or test failure usually lives in the code being worked on, not in the call. Checks that found nothing (`ls dist`) land here too |
| `other` | Other tool error | **no** (counted in 1.0.3 and earlier) | Not classified, so it cannot be pinned on the model |
| `environment` | Network, timeout or environment | no | Not the model's doing |
| `rejection` | Rejected by you or a guardrail | no | Your decision |

Some failed commands are the model's fault: a made-up npm script or flag. Those are classified as
`hallucination` ("Command or option that does not exist"), not `execution`, so they still count.
Expect accuracy to read higher than in 1.0.3: failing test runs no longer pull it down.

Accuracy is also counted per model: each tool result belongs to the model that made the call (in Claude Code logs the
model of the assistant message holding the `tool_use`, in Codex logs the model of the turn). Cost Control's Value page
sets it against spend per request. The index is rebuilt once after the update that added these counts.

## Method

- **Three sets per detector**, all in `test/fixtures/signals/`:
  - `dev` (`<detector>.json`, 233 items) was written together with the detectors. It also holds every
    case from the code review that prompted this work. Scores on it say little about unseen text.
  - `holdout` (`holdout.json`, 198 items) was written by a separate agent that never saw the detector
    code and was told only what each detector should and should not flag. It was scored once, then
    used to fix gaps, so it is no longer unseen either.
  - `blind` (`blind.json`, 153 items) was written the same way after that round, asked to avoid textbook
    phrasing. It was scored once ("first look" below), then used for one more round of general fixes.
- Secrets are written as `<<SECRET:type>>` and filled with seeded random values when the corpus loads,
  so no secret-shaped string sits in the repository.
- A correction example carries `after`: whether the model had acted before the prompt.
- Precision = flagged and labelled positive ÷ everything flagged. Recall = flagged ÷ everything labelled
  positive. "Labels" is the share of true positives that got exactly the expected type (secrets, risky
  commands, hallucination kinds) or every expected category (injection).
- Run it yourself: `node scripts/eval-signals.js --compare f2b198d` (before = the detectors at commit
  `f2b198d`, release 1.0.3). `--set dev|holdout|blind`, `--misses` lists every wrong verdict.
- `test/signals.test.js` fails if precision or recall on any set drops below a floor (dev 95%,
  holdout 90%, blind 90% precision and 85% recall).

## Results

All 584 items, before (1.0.3) → after:

| Detector | Items (pos/neg, Indonesian) | Precision | Recall | F1 | Labels |
|---|---|---|---|---|---|
| Corrections | 123 (64/59, 56 id) | 52% → 100% | 38% → 100% | 44% → 100% | — |
| Prompt injection | 109 (58/51, 25 id) | 41% → 100% | 22% → 100% | 29% → 100% | 75% → 100% |
| Secrets | 106 (56/50, 16 id) | 82% → 100% | 57% → 100% | 67% → 100% | 69% → 100% |
| Risky commands | 133 (75/58, 12 id) | 82% → 100% | 72% → 100% | 77% → 100% | 94% → 99% |
| Non-existent target | 113 (55/58, 14 id) | 75% → 98% | 49% → 100% | 59% → 99% | 100% → 100% |

These "after" numbers are on text the detectors were tuned against. **The honest estimate for unseen
text is the first look at each held-out set**, scored before any tuning on it:

| Detector | Holdout, first look (P / R) | Blind, first look (P / R) | Blind, before (1.0.3) |
|---|---|---|---|
| Corrections | 100% / 85% | 100% / 60% | 17% / 7% |
| Prompt injection | 93% / 65% | 88% / 47% | 67% / 27% |
| Secrets | 100% / 100% | 100% / 100% | 90% / 56% |
| Risky commands | 100% / 100% | 100% / 100% | 87% / 87% |
| Non-existent target | 95% / 95% | 100% / 80% | 80% / 53% |

The blind first look was measured on the version before the last round of fixes, so the current
version should do somewhat better on unseen text, but not 100%.

What this means in practice:

- **Secrets and risky commands** are pattern-shaped problems and generalise well.
- **Corrections** are precise (a flagged prompt is very likely a real correction) but miss many:
  people complain in endless ways ("that refactor was way too aggressive"). Read the correction rate as
  a lower bound.
- **Prompt injection** is the weakest. Pattern matching catches the known shapes and their paraphrases,
  but an attacker who writes something new will get through. Treat a zero as "nothing known was found",
  not as "nothing was there". Matches in obvious documentation or code are suppressed, which also means
  an attack phrased as an example ("for example, ignore all previous instructions…") is not counted.
- Remaining known misses: an injection asking the assistant to call a tool "for compliance" without
  any of the known phrases (blind set). One labelling disagreement is left as is: the holdout labels
  `zsh: command not found: yarn` as an environment gap; the detector reports it as a command that does
  not exist, since the logs cannot tell the two apart.

## Extra checks

- Running the injection detector over this repository's own 154 source, test and doc files, in chunks
  of about 4,000 characters cut at line ends (as a Read result shows them), gives no match. The repo
  holds this detector's own patterns, its tests and a security policy. The secret detector flags one
  item: a test database URL with the password `s3cret`, which is a fair flag.
- `node scripts/eval-signals.js --misses` after a change shows exactly which cases moved.
