# Local evals & feedback

ZAAFPulse can grade what your agents did. Two kinds of evaluator look at each finished turn: **code checks**
that reuse the detectors behind the Quality page (free, on all data), and **judge evaluators** where a model
reads the masked text of the turn and answers with one label from a fixed list. The judge is **local first**:
Ollama or LM Studio on this machine. Nothing is sent to an external provider unless you choose one, look at the
exact text it would receive, and confirm. One external choice is built in: [Claude Code](#claude-code), which judges
with your own Claude login through the Claude Code CLI.

You also rate turns yourself (Good or Bad, with an optional note), and the Quality page shows how often the
judges agree with you.

Results show in the **Trace explorer** (badges on the turn, an **Evals** tab and a **Notes** tab), in the **Evals**
card on the Quality overview, and in **Settings → Evals**.

## The evaluators

Each evaluator has a list of labels. The first label is the passing one; the score runs from 1 (the passing label)
down to 0 (the last label), evenly spaced.

| Evaluator | Kind | Scope | Labels | What it reads |
|---|---|---|---|---|
| `secret_leak` | code | turn | `clean`, `leaked` | the secret detector's events for the turn |
| `risky_command` | code | turn | `safe`, `risky` | the risky-command detector's events |
| `prompt_injection` | code | turn | `none`, `local`, `external` | the injection detector's events (`external` when the text came from the web or a fetched file) |
| `non_existent_target` | code | turn | `none`, `hallucinated` | the non-existent-target detector's events |
| `tool_loop` | code | turn | `none`, `loop` | the loop detector's events |
| `correction` | code | turn | `accepted`, `corrected` | the correction detector: your next prompt corrected this turn |
| `faithfulness` | judge | turn | `faithful`, `unfaithful` | the final answer and the tool results of the turn |
| `task_completion` | judge | turn | `complete`, `partial`, `incomplete` | the prompt, the final answer and the tool results |
| `tool_selection` | judge | turn | `appropriate`, `questionable`, `wrong` | the prompt, the tool calls (name, target, status; no outputs) and the names of the other tools used in the turn |
| `relevance` | judge | turn | `relevant`, `partly`, `off-topic` | the prompt and the final answer |
| `user_frustration` | judge | session | `none`, `some`, `high` | your prompts of the session (the latest 30, 1,000 characters each) |

- **Code checks** are computed on demand from the signal events the index already holds. They are not stored, run
  for every session, and cost nothing. Each result carries evidence as a tool name and a detector label, never
  event text. A code check always runs; only the five judge evaluators can be switched off in Settings → Evals.
- **Judge evaluators** are stored with the label, the score, a short explanation (at most 300 characters), the
  judge's kind, model and provider, and whether the input had to be trimmed.

## Which model judges

The judge is resolved in this order, and the first that works is used:

1. **The model in Settings → Evals.** With the provider set to Ollama or LM Studio and a model name, that choice is
   used as given. With a gateway provider selected, that provider and model are used (see
   [External providers](#external-providers)). With **Claude Code** selected, your Claude Code CLI judges (see
   [Claude Code](#claude-code)).
2. **Ollama**, asked at `http://127.0.0.1:11434/api/tags`.
3. **LM Studio**, asked at `http://127.0.0.1:1234/v1/models`.
4. **Wait.** There is no judge yet.

Claude Code and the gateway providers are used only when you select them. **Automatic** never picks one, not even
when Claude Code is installed and no local model runs.

With the provider on **Automatic**, the model you typed is used when the server lists it. Otherwise the first
listed model that matches this order is picked: `qwen3`, `qwen2.5`, `llama3.3`, `llama3.2`, `llama3.1`, `mistral`,
`gemma3`, `gemma2`, `phi4`. Embedding and rerank models are ignored. The answer is cached for 30 seconds.

- **Light models first.** The pick prefers a model of at most 14B parameters: the size comes from Ollama's
  `details.parameter_size`, else from the name (`llama3.3:70b`). With `llama3.3:70b` and `qwen3:8b` listed,
  `qwen3:8b` judges. A larger model is used only when no ranked family has a lighter one. A model you name in
  Settings is used whatever its size.
- **The first judging loads the model.** Ollama loads a model into memory on its first call, which can take a while
  and use a lot of memory for a large one. The Evals card on the Quality overview and the status line in Settings →
  Evals show which model is judging; in the Trace explorer each result names the model that gave it.
- **Ollama cloud models are never used.** Ollama 0.12 and later list cloud models (`gpt-oss:120b-cloud`,
  `glm-4.6:cloud`) next to the local ones, and a request to one is forwarded to ollama.com. The automatic pick
  leaves out every model that `/api/tags` marks with `remote_host` or `remote_model`, or whose name ends in `cloud`.
  A cloud model named in Settings is refused with "Ollama cloud models send text off this machine; choose an
  external provider in the gateway instead", and nothing is sent. To judge with a hosted model, add it as a provider
  in the Agent Gateway and choose it as an [external provider](#external-providers): the preview, the masking and the
  cost cap then apply.
- **LM Studio** lists only the models on this machine, so it has no such filter.

To get a judge, install [Ollama](https://ollama.com) and pull a model:

```bash
ollama pull qwen3:8b
```

Start Ollama (the desktop app or `ollama serve`); ZAAFPulse finds it within a minute. Calls use temperature 0 and
the model is asked for JSON in the shape of the evaluator's schema.

- **Ollama context window.** Ollama's default context (2,048 or 4,096 tokens) is smaller than the judge's input,
  and Ollama drops the start of the context, where the instructions are, without saying so. Each call therefore
  sets `num_ctx` from the prompt size (about 3 characters a token, plus 1,024 for the answer), rounded up to 8,192,
  16,384 or 32,768 tokens so Ollama does not load the model again for every new size, and sends `think: false` so a
  thinking model answers directly.
- **LM Studio context window.** LM Studio takes no context size per request: the loaded model's context length
  applies. Load the judge model with a context of **at least 8k tokens** (8,192), or the start of the prompt is cut.
  ZAAFPulse cannot read the loaded context length from the OpenAI-compatible `/v1/models` it asks, so it does not
  shrink the input for LM Studio.

### Network

For tests and unusual setups, two environment variables move the local servers. They hold the base address, and
the full turn text (secrets masked, personal data not) is sent there, wherever they point. Point them only at a
machine you trust: an address on another machine is not a local judge, and none of the external-provider safeguards
(preview, personal-data masking, cost cap) apply to it. With the defaults, and Ollama cloud models left out (see
above), turn text leaves this machine only through an external provider you chose.

| Variable | Default |
|---|---|
| `ZAAFPULSE_OLLAMA_URL` | `http://127.0.0.1:11434` |
| `ZAAFPULSE_LMSTUDIO_URL` | `http://127.0.0.1:1234` |

## Waiting, caps and limits

- **Waiting.** With no judge the queue holds, nothing is sent anywhere, and the Evals card and Settings say why
  ("Install or start Ollama, or choose a provider"). Code checks still show. Judging starts by itself when a model
  appears.
- **One queue, concurrency 1.** One judge call runs at a time. The queue holds up to 2,000 jobs; the oldest are
  dropped beyond that.
- **Daily count.** At most 500 judgments a day by default (`dailyCap`, 1 to 10,000). At the cap, judging pauses until
  the next local day.
- **External cost cap.** At most $1 a day by default (`costCapUSD`, 0 to 100) for an external provider. Each call is
  estimated from its input size before it is made; one that would pass the day's budget waits for the next day. The
  call that crosses the cap finishes, so a day can overshoot by one call. A reply that reports no usage, or a cost
  below what its input alone costs, is counted at its estimate. Local models cost nothing and are not counted
  against this cap.
- **Unpriced external models are refused.** The cost cap needs a price. If the gateway has no price for the chosen
  model, nothing is sent and Settings says so. Claude Code is not refused: it reports the cost of each call.
- **Per-provider backoff.** A provider that keeps failing (three tries in a row) is left alone for 1, 2, 4 … up to 30
  minutes, then probed with a single job.
- **Input budget.** A judge reads about 6,000 tokens (24,000 characters). Longer material is trimmed to its head and
  its tail, and the result is marked as trimmed.
- **Idempotency.** A result is keyed by the target, the evaluator, its version and the judge model, so a turn is
  never judged twice by the same model. The automatic pass skips a turn that any model has judged at the current
  evaluator version, so switching the model judges only new turns. **Judge this session** judges the session again
  with the current model, and its verdict replaces the older one in the views. A new evaluator version (a changed
  judge prompt) is judged again.
- **Invalid answers are dropped.** A reply that is not exactly the JSON object, or whose label is not in the
  evaluator's list, is discarded and not retried.

## When turns are judged

- **Only new turns.** The first time a judge is available, ZAAFPulse records that moment. Only turns that started
  after it are judged on their own. Your history is never judged unless you ask.
- **Finished turns.** A turn counts as finished when a later turn exists, or the session has been quiet for 2
  minutes. A turn still running is skipped.
- **Whole-session verdict.** `user_frustration` is given after the session has been quiet for 30 minutes, and is
  refreshed when the session has grown by 5 turns or by half of what the last verdict covered, whichever is larger.
- **Agent Gateway runs.** A collaboration run is judged as one turn once it has ended and gone quiet. Plain gateway
  requests have no text to judge.
- **Judge this session.** The button in the Trace explorer (`POST /api/evals/run`, `zaafpulse eval`) queues every
  finished turn of that session, history included, even when it is older than the judge. It still obeys the caps.
  On a session that is still running (active in the last 30 minutes) the whole-session verdict waits.
- The scheduler runs after each index refresh, which is about once a minute.

## Privacy

- **Masked input.** A judge reads text only through the same masked reader as the Trace explorer. Secrets are
  replaced by labels before the text is cut to size, and transcript files are never read directly by the evals.
  Text for an external provider also has personal data masked (see [External providers](#external-providers)).
- **Untrusted wrapper.** The text is copied from agent sessions, so it may try to steer the judge. Every piece is
  sent inside a block tagged `untrusted-<hash>`; the tag is derived from a hash of the material, so it differs for each
  judgment and the material cannot contain it. Invisible format characters are stripped, a look-alike tag in the
  material is broken, and the system message says that everything inside the blocks is data to judge, not
  instructions.
- **No tools.** A judge call carries no tools. The model reads and answers; it cannot act.
- **Forced answer.** The reply must be JSON with a `label` taken exactly from the evaluator's list and a short
  `explanation`. Anything else is dropped.
- **External providers need a preview.** See below.
- **Notes are never sent.** Your notes live only in `feedback.jsonl`. No judge sees them, and neither does any
  provider.
- **Explanations follow the content switch.** An explanation comes from a model reading your text, so when content
  viewing is off (`ZAAFPULSE_CONTENT=off`, or the default in server mode) the API returns `explanation: null`.
  Labels and scores are still shown. A local judge still works with content off; only its explanations are hidden.
- **No prompt text is stored** in the results file.

### External providers

An external judge is a provider from the Agent Gateway that you pick under **Settings → Evals**. It is never chosen
for you, and it is never a fallback for a missing local model. The model must belong to that provider: a route
(`router/…`), an alias, or a name of another provider is refused, also for a provider whose id is `router`.

**What is masked.** On top of the secret masking every judge gets, text for an external provider has personal data
replaced, in both the system and the user message:

| Found | Replaced by |
|---|---|
| email addresses (not image names such as `icon@2x.png`) | `‹email›` |
| IPv4 and IPv6 addresses (not `127.0.0.1`, `0.0.0.0` or `::1`, and not right after a letter, an `@` or a single `/`) | `‹ip›` |
| phone numbers: 9 to 15 digits with a leading `+`, or with an area code in brackets, or in groups split by dashes | `‹phone›` |
| the user name in `/Users/<name>/`, `/home/<name>/` and `C:\Users\<name>\` (any case) | `‹user›` |

The patterns are conservative. Kept as they are: ports, hashes, dates, times, long plain numbers (ids,
timestamps), numbers grouped only by dots or spaces (`11.927.074.289`, `1080 1080 24`), and versions right after a
letter, an `@` or a slash (`v1.2.3.4`, `openjdk@21/21.0.12.1`). A bare four-part version such as `26.2.4.2` looks
like an IPv4 address and is masked as `‹ip›`. Not caught: a phone number without a `+` that uses only spaces or
dots, or none at all, and a name in free text. A local judge reads the text with secrets masked only, since it
never leaves the machine.

1. Choose the provider and a model. The model must have a price in the gateway (see the cost cap above). For Claude
   Code the model is optional.
2. Open the **preview**. It shows the exact masked text that would be sent for the latest finished turn of a session,
   including the system message and the personal-data masking above. Showing it is what confirms the provider.
3. Only then does the first call go out. Changing the provider asks for a new preview.

The preview is text from a transcript, so it is refused (`403`, "content viewing is off") while content viewing is
off. In server mode, set `ZAAFPULSE_CONTENT=on` to use an external judge.

### Claude Code

**Claude Code (your Claude login)** in Settings → Evals judges with the Claude Code CLI you already use, signed in
with your Claude account. No API key is needed, and nothing is set up in the gateway.

- **What is sent, and to whom.** The same masked text as for any external provider (secrets and personal data
  masked, the [preview](#external-providers) shows it exactly). It goes where your Claude Code sends its requests,
  which ZAAFPulse reads from the environment the CLI gets. The first switch that is on wins, in this order (a switch
  is on for `1`, `true`, `yes` or `on`, off for `0`, `false`, `no`, `off` or empty, as Claude Code reads it):

  | Set in that environment | The text goes to | Billed to |
  |---|---|---|
  | `CLAUDE_CODE_USE_BEDROCK` | AWS Bedrock (`via <host>` with `ANTHROPIC_BEDROCK_BASE_URL`) | your cloud account (AWS) |
  | `CLAUDE_CODE_USE_MANTLE` | AWS Bedrock (Mantle) (`ANTHROPIC_BEDROCK_MANTLE_BASE_URL`) | your cloud account (AWS) |
  | `CLAUDE_CODE_USE_VERTEX` | Google Vertex AI (`ANTHROPIC_VERTEX_BASE_URL`) | your cloud account (GCP) |
  | `CLAUDE_CODE_USE_FOUNDRY` | Microsoft Foundry (`ANTHROPIC_FOUNDRY_BASE_URL`) | your cloud account (Azure) |
  | `CLAUDE_CODE_USE_ANTHROPIC_AWS` | Claude Platform on AWS (`ANTHROPIC_AWS_BASE_URL`) | your cloud account (AWS) |
  | `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` | Claude on Google Cloud (`ANTHROPIC_GOOGLE_CLOUD_BASE_URL`) | your cloud account (GCP) |
  | `ANTHROPIC_BASE_URL` (with or without `CLAUDE_CODE_USE_GATEWAY`) | that host, shown as `<host> (ANTHROPIC_BASE_URL)` | API billing with a key or token, else your Claude login |
  | none of these | Anthropic | API billing with `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, else your Claude login |

  A switch with any other value is shown as `<VAR>=<value>?` and counts as a destination of its own. Settings →
  Evals (the provider list and its hint), the preview ("Sent to …") and the judge status show the result, for example
  "Anthropic, through your Claude login". The environment is kept as it is, so an API-key, router or cloud setup
  goes on working; only hosts are shown, never a key or a full address. Managed or policy settings of Claude Code
  can route it as well; those are not detected.
- **The preview confirms one destination.** Choose Claude Code, save, open the preview. What is stored
  (`externalConfirmed`) is `claude-code@<hash>`, a short hash of every `CLAUDE_CODE_USE_*` switch (on, or its
  odd value), the host of every `ANTHROPIC_*_BASE_URL`, and which of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_FOUNDRY_API_KEY` and `ANTHROPIC_FOUNDRY_AUTH_TOKEN` are set (never their values), the Foundry host
  (from `ANTHROPIC_FOUNDRY_RESOURCE` as `<resource>.services.ai.azure.com` when no base URL is set, also shown in the
  destination), and the cloud account and region (`AWS_PROFILE`, `AWS_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`,
  `CLOUD_ML_REGION`: hashed, never shown or stored as text). When any of these
  changes (say you set `ANTHROPIC_BASE_URL` or an API key and restart), nothing is sent and the judge says "The
  Claude Code destination changed; preview again". The daily count and the cost cap apply, and a provider that keeps
  failing is backed off, as for a gateway provider.
- **What it costs.** It uses your Claude plan's usage limits, or API billing, whichever your Claude Code uses. The
  cost shown in Settings and counted against the cost cap is what Claude Code reports for each call
  (`total_cost_usd`): the **API-equivalent list price**. On a subscription you are not billed that amount per token,
  but the calls count against your plan's limits. Before a call, the cap check uses an estimate at a high list price
  for the model family (the top tier when no model is set); a call that reports no cost is counted at that estimate.
- **The model.** Leave it empty for Claude Code's own default, or type an alias (`haiku`, `sonnet`, `opus`) or a full
  model name; it is passed as `--model`. A small model such as **`haiku`** is recommended: a judgment is a short
  classification, and it saves your limits. Each result keeps the model that actually answered (`judge.used` in the
  API; the trace explorer shows it). A name that is not plain name characters, or that starts with a dash, is refused.
- **How it runs.** One `claude -p` per judgment, with no tools (`--tools ""`, and `--disallowedTools "mcp__*"` as a
  second fence), no MCP servers (`--strict-mcp-config`), no slash commands, no settings files
  (`--setting-sources ""`), the judge's system prompt instead of Claude Code's, and the answer forced to the
  evaluator's JSON schema (`--json-schema`). It writes no session (`--no-session-persistence`), and in case one is
  ever written, a session whose folder is the judge's own (`zaafpulse-judge-…`) is never judged. It runs in a new
  empty temporary folder, which is removed after the call, so no project `CLAUDE.md` is picked up; a `CLAUDE.md` in a
  folder above it was checked to have no effect. The turn text goes in on stdin, never on the command line, which
  other users of the machine can see in `ps`. `--bare` is not used: it would turn off the Claude account login.
- **Time and size limits.** After 120 seconds the CLI and every process it started (its process group, on macOS and
  Linux) get SIGTERM, then SIGKILL 5 seconds later; whatever still holds its output, the call ends within 126
  seconds. On Windows the CLI itself is stopped and the call ends within the same bound. An answer the CLI gave
  before it exited is still read when the time runs out while a helper holds its output. An answer over 1 MB is
  refused. Switching the judge to another provider or switching judging off cancels a running call; stopping the
  dashboard kills it at once (SIGKILL to its group) and removes its folder.
- **Not signed in.** An answer that the login is gone (or an API key is refused) backs the judge off with "Claude
  Code is not signed in, retrying in N min", instead of failing each turn. Sign in again with `claude` in a terminal.
- **Where the CLI is found.** `ZAAFPULSE_CLAUDE_BIN` if set (then only that file is tried), else `claude` on `PATH`
  (absolute entries only), else `~/.claude/local/claude`, `~/.local/bin/claude`, `/opt/homebrew/bin/claude` and
  `/usr/local/bin/claude`, else the copy inside an IDE extension (`~/.vscode`, `~/.vscode-insiders`, `~/.cursor`,
  `~/.windsurf`, `~/.antigravity-ide` and `~/.antigravity`, each under
  `extensions/anthropic.claude-code-*/resources/native-binary/`) or bundled with Claude Desktop on macOS
  (`~/Library/Application Support/Claude/claude-code/<version>/`). Among the extension and Desktop copies the highest
  version wins. On Windows the names are `claude.exe` and `claude.cmd` on `PATH`, `%USERPROFILE%\.local\bin\claude.exe`,
  `%USERPROFILE%\.claude\local\claude.exe`, `%APPDATA%\npm\claude.cmd` and the extension's `native-binary\claude.exe`.
  A `.cmd` is started through the package it wraps, never through a shell.
- **Which binary counts.** One whose `--version` says `(Claude Code)` within 10 seconds. On macOS and Linux a binary
  found on its own must have a file and folder (and a real file behind a link) that belong to you or to root and are
  not writable by everyone; writable by the group is fine (umask 002). Another one is passed over. The binary named
  in `ZAAFPULSE_CLAUDE_BIN` is taken as you set it: it only has to exist and be executable. A script (`.js`, or the package behind a `.cmd`) runs through node:
  this process's own, or in the single-file build a `node` found on `PATH` or in the usual folders; with none, the
  script is passed over. The answer is kept for 5 minutes, and dropped at once when the binary can no longer be
  started. Settings → Evals says whether it was found ("checking" while the first search is still running), never
  where.
- **Not found.** The judge waits with "Claude Code not found: install it, or set ZAAFPULSE_CLAUDE_BIN". A background
  service has no shell `PATH`; `zaafpulse service install` carries `ZAAFPULSE_CLAUDE_BIN` into the service when it is
  set.
- **Its environment.** The CLI gets your environment (it needs `HOME` and its login), without the `ZAAFPULSE_*`
  variables and without what a parent Claude Code session, the Agent SDK or VS Code sets for its own children
  (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_IDE_*`, `CLAUDE_CODE_SESSION_*`,
  `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_CODE_PLUGIN_DIRS`, `VSCODE_*` and the like). When `CLAUDE_CONFIG_DIR` lists
  several folders for the logs, Claude Code gets the first.
- **From the command line.** `zaafpulse eval` checks the confirmation against the environment of the terminal it runs
  in: a terminal whose `ANTHROPIC_*` variables differ from the dashboard's is a different destination, and is refused
  until it is previewed.
- **A gateway provider called `claude-code`.** The built-in one wins: a gateway provider with the id `claude-code` is
  left out of the judge's provider list and cannot be the judge. It still works in the gateway; give it another id to
  judge with it.

## Your ratings

In the Trace explorer, a turn can be rated **Good** or **Bad** (`g` and `b`) and given a note (`n`). A rating is
stored per turn, and a note up to 2,000 characters. Clearing both removes the record. Notes and ratings stay on
this machine.

## Judge agreement

The Evals card on the Quality overview shows how often the judges agree with you. A turn **passes** when every
judge evaluator that has a result for it gives its passing label. For each turn you rated, it counts as an
agreement when "passes" matches "Good". The card shows the pairs compared and the rate. Code checks and
whole-session verdicts are not part of it. A low rate means the local model grades differently from you: try a
larger model, or trust the labels less.

## Where the data lives

All files are in the `.data` folder of the data folder, mode `0600`, and are not read by anything else.

| File | Holds |
|---|---|
| `evals.jsonl` | judge results, one line per result key, with no prompt text. Rotates at 10 MB: it is rewritten with the latest result per key, and if it is still over the cap the oldest results go until it is about 80% of it. The file is read again before the rewrite, so results the CLI appended meanwhile are kept |
| `feedback.jsonl` | your ratings and notes, one line per target |
| `evals-state.json` | the moment the judge first became available, and today's count and cost against the caps |

The settings are under `evals` in `config.json` (the keys are `judge`, `provider`, `model`, `dailyCap`,
`costCapUSD`, `evaluators` and `externalConfirmed`); Settings → Evals writes them.
In demo mode (`DEMO=1`) the results and ratings are synthetic, nothing is judged and nothing touches the network.

## HTTP API

All routes sit behind the dashboard sign-in. A session is named by its trace key (from `/api/trace/sessions`),
never by its raw id. A state change needs a JSON body.

| Route | Returns |
|---|---|
| `GET /api/evals?key=…&turn=N` | the results of a session, or of one turn when `turn` is given: `evaluator`, `kind`, `scope`, `turn`, `label`, `score`, `pass`, `explanation`, `judge`, `trimmed`, `evidence`, `ts` |
| `GET /api/evals/summary?range=1..30` | the pass count, total, rate and daily counts per evaluator, and the judge agreement. `range` is days (default 7) |
| `GET /api/evals/status` | the judge (`ok`, `kind`, `model`, `provider`, `waiting`, `reason`), the queue length, today's count and cost, `paused` (`judge off`, `daily cap` or `cost cap`) and `since` |
| `GET /api/evals/evaluators` | the evaluators: `id`, `kind`, `scope`, `title`, `labels`, `pass` |
| `GET /api/evals/settings` | the settings in force and the providers you can choose. Claude Code is `{ "id": "claude-code", "label": "Claude Code (your Claude login)", "kind": "claude-cli", "external": true, "available": true, "destination": "Anthropic, through your Claude login", "confirm": "claude-code@…", "models": ["haiku", "sonnet", "opus"] }`, with `available` saying whether the CLI was found (`null` while the first search runs) |
| `POST /api/evals/settings` | JSON with any of `judge`, `provider`, `model`, `dailyCap`, `costCapUSD`, `evaluators`; a name it does not know is refused |
| `POST /api/evals/run` | JSON `{ "key" }`: queue every finished turn of the session; returns `{ "queued" }` (and `sessionDeferred` when the whole-session verdict waits) |
| `POST /api/evals/preview` | JSON `{ "key", "provider" }`: the exact masked text for that external provider or Claude Code (`system`, `user`, `evaluator`, `turn`, and for Claude Code `destination`); confirms the provider (Claude Code: that destination) |
| `GET /api/feedback?key=…&turn=N` | the ratings and notes of a session, or of one turn |
| `POST /api/feedback` | JSON `{ "key", "turn", "rating", "note" }`; `rating` is `good`, `bad` or `null`; an omitted field keeps its value |
| `GET /api/feedback/sessions?keys=a,b` | `{ "sessions": { key: { good, bad } } }` for up to 50 session keys, so the session list can mark rated sessions |

Errors are JSON `{ "error": … }`: 400 for a bad or missing parameter, 403 for a preview while content is off, 404
for an unknown route or key, 405 for the wrong method, 413 for a body that is too large and 415 for a body that is
not JSON.

## MCP

The read-only `acc_evals` tool tells an AI client how your agents are doing, as ids and labels only. Argument:
`range` (`7`, `30`, `90` or `all`; default 30). It returns:

```json
{
  "evaluators": [{ "id": "faithfulness", "kind": "judge", "rate": 0.82, "total": 40 }],
  "failures": [{ "key": "claude.…", "source": "claude", "turn": 3, "evaluator": "relevance", "label": "off-topic", "ts": 1792000000000 }]
}
```

- `evaluators` lists all eleven, with the pass rate (`null` when there is no result in the range) and the number of
  results. `failures` are the latest 20 results with a label other than the passing one, newest first.
- `turn` counts from 0, and is `null` for a whole-session verdict.
- **No explanation, no text, no path, no session id.** The tool opens the results file read-only and has no model, so
  it can never start judging. The same holds on the gateway's `/mcp` endpoint, which any key with the `mcp` scope can
  call.
- **Keys** are made per process, as for `acc_trace_sessions`. A failure for a session this process does not list has
  no key and is left out. A key from the gateway's `/mcp` works in the same server's dashboard until it restarts.
- In demo mode it returns the synthetic results and reads nothing under your home folder.

## Command line

```bash
zaafpulse eval --judge --session <id> [--source claude|codex] [--data DIR] [--json]
```

This judges every finished turn of one session without the dashboard running, with the local model (or Claude
Code, see below), and prints a table of turn, evaluator and label:

```text
TURN     EVALUATOR         LABEL         MODEL
1        faithfulness      faithful      qwen3:8b
1        task_completion   complete      qwen3:8b
…
session  user_frustration  none          qwen3:8b
```

- `<id>` is the raw session id (the file name of a Claude Code session, for example). Without `--source` it looks in
  Claude Code, then Codex.
- It indexes the logs, then uses the settings under `evals` in `<data>/config.json` and writes the results to
  `<data>/.data`. `--data DIR` works as for `zaafpulse start`.
- The table counts turns from 1, like the explorer. `--json` prints an array of `{ turn, evaluator, label, model,
  explanation }` with `turn` counted from 0 (`null` for the session verdict). `explanation` is `null` when
  `ZAAFPULSE_CONTENT=off`.
- Turns are numbered from 1 in the table, and from 0 in `--json`, the API and the MCP tool.
- Progress and messages go to stderr; the table or JSON goes to stdout.
- A turn that is still running is not judged, and the whole-session verdict is held back for a session active in
  the last 30 minutes.

| Exit code | Meaning |
|---|---|
| `0` | the session was judged |
| `2` | no local judge is available, the session is unknown, judging is off, the settings select a gateway provider or a Claude Code that is not confirmed or not found, or judging stopped early on a cap |
| `1` | nothing was judged for another reason (no finished turn yet, or no valid answer from the model) |

A gateway provider in the settings makes it print "external judges need the running dashboard" and exit 2: the CLI
has no gateway and no preview step. **Claude Code** works from the CLI once its preview was confirmed in Settings →
Evals of the same data folder, for the destination this terminal's environment gives; before that the CLI prints
"confirm the Claude Code preview in Settings → Evals first" (or "The Claude Code destination changed; preview
again") and exits 2, and nothing is sent. The `MODEL` column shows the model that
answered.

The CLI starts from the day's count and cost in `evals-state.json` and adds to them. A dashboard that is already
running keeps its own counters and does not see the CLI's, so the two together can pass the daily count, and with
Claude Code the cost cap, by up to one CLI run. The running dashboard reads the results file when it starts, so
results written by the CLI show there after a restart.

## Known limits

- **Code checks are per turn.** A detector event is placed on the turn whose time span holds it, and a correction
  marks the turn before the prompt that corrected it. In the explorer, a badge is matched to a span by the tool name
  in its evidence, so two calls of the same tool in a turn share a badge.
- **`tool_selection` is per turn.** It judges the whole set of calls of a turn, not each call, and does not see tool
  outputs.
- **Feedback is per turn.** A rating or a note belongs to a turn, not to a span.
- **The gateway has no tool inputs for the judge.** A collaboration run is judged from its task, its step texts and
  its answer; plain gateway requests keep no text and get only code results.
- **Gateway judges are not available from the CLI.** Use the dashboard, where the preview step and the cost cap
  apply. Claude Code is, once its preview was confirmed in the dashboard.
- **Claude Code's cost is an API-equivalent.** On a Claude subscription the cost cap counts list prices you are not
  billed, while the real limit is your plan's usage limit, which ZAAFPulse cannot read. A usage-limit answer from the
  CLI backs the judge off like any failing provider.
- **Small local models are noisy.** Compare their verdicts with your own ratings in the judge agreement before you
  rely on them.
- **The `acc_evals` code-failure scan is bounded.** It covers only the 100 most recently active sessions, so an
  older code-check failure can be missing from `failures`.
- **The evaluator rates include sessions `acc_evals` cannot name.** They count every stored result in the range;
  only `failures` is limited to sessions this process lists.
- **A clock moved back by more than a day** gives the day counters a fresh start.
- **`think: false` depends on your Ollama version.** Check `think: false` on your Ollama version; ZAAFPulse retries
  without it if refused, and then keeps leaving it out for that model until the dashboard restarts.
- **A quiet last turn can be judged mid-flight.** The last turn of a session counts as finished after 2 quiet
  minutes. An agent that is still working but writes nothing for that long (a long build, a slow tool) has its turn
  judged on what it had so far, and the automatic pass does not judge it again. Use **Judge this session** to judge
  it again later.
- **The cost estimate assumes about 4 characters a token.** Text in Chinese, Japanese or Korean has more tokens per
  character, so its estimate is too low. The error is bounded to one call: the reported cost is what counts once
  the call returns, and the next call is checked against it.
