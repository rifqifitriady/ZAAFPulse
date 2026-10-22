# Datasets, replay & the CI gate

A **dataset** is a set of turns you saved from the [Trace explorer](explorer.md). Each saved turn is an **example**:
the prompt, the evidence the model had (tool results), the answer it gave, and optionally the answer you wanted.
You can replay a dataset against other models, score the answers, compare two runs, and gate a pull request on the
pass rates from a terminal.

What it is for:

- **Keep real cases.** Save the turns that went wrong (or well) instead of retyping them.
- **Try another model on them.** Replay one example or a whole dataset against up to three models, local first.
- **Score and compare.** The same evaluators grade every answer, side by side, and two runs can be compared.
- **Stop regressions.** `zaafpulse eval --dataset … --ci` fails a build when a pass rate drops.

Everything stays on this machine. Datasets are the only place ZAAFPulse keeps a copy of transcript text, and only
because you saved it.

## The example shape

Each example is one JSON line in `.data/datasets/<slug>.jsonl`:

```json
{
  "id": "ex_0123456789abcdef",
  "createdAt": 1790000000000,
  "updatedAt": 1790000000000,
  "source": { "source": "claude", "session": "<session id>", "turn": 0, "span": null },
  "input": {
    "system": null,
    "messages": [
      { "role": "user", "text": "fix the login redirect" },
      { "role": "tool", "name": "Read", "text": "…" }
    ],
    "tools": [{ "name": "Read", "description": "" }]
  },
  "output": { "text": "Changed the redirect.", "model": "claude-opus-5-5" },
  "reference": { "text": "optional: the answer you wanted" },
  "tags": ["auth-regressions"],
  "evals": { "faithfulness": "unfaithful" },
  "feedback": "bad"
}
```

`reference`, `tags`, `evals` and `feedback` are optional. Roles are `system`, `user`, `assistant` and `tool`.

How a turn becomes an example:

- The **messages** are the turn's prompt as a `user` message, then the **last 10 tool results** of the turn as `tool`
  messages, in the order they ran. A prompt keeps up to 64 KB, each tool result up to 8,000 characters.
- The **tools** are the distinct tool names the turn called (at most 100), with no description.
- The **output** is the turn's answer, with the model of the turn's last model call.
- A selected span (for example one tool call) is recorded in `source.span` for the link back to the trace only. It
  does not change what is replayed.
- A turn of a **gateway run** uses the run's task as the prompt and has no tool messages.

Including the tool results lets a replayed model answer from the same evidence, so a judge such as `faithfulness`
means something.

## Limits and masking

| Limit | Value |
|---|---|
| Examples per dataset | 1,000 |
| Datasets | 100 |
| One text field | 64 KB (65,536 characters) |
| Messages per example | 50 (at least one `user`) |
| Declared tools per example | 100 |
| Tags per example | 20, each 1 to 40 letters, digits, `_ . : -` |
| One serialized example | 1 MB |
| Dataset name | 80 characters |
| Turns in one "add" | 50 |
| One import | 16 MB |

A longer text field keeps its head and its tail around a `[… trimmed …]` marker. A dataset name becomes its slug
(lower case, digits and `-`, up to 64 characters). The slug is fixed when the dataset is created; renaming changes
the display name only. `import` and `settings` cannot be used as slugs.

**Every text field is masked when it is saved.** Secrets found by the same patterns as the Quality page (API keys,
tokens, private keys) are replaced by a marker such as `‹anthropic key hidden›`, the same marker the Trace explorer
shows. The original is not kept. This applies to the prompt, tool results, answers, references and imports.

## Adding examples

- **From the Trace explorer.** Open a turn and press **⤓ Add to dataset**. Pick an existing dataset or create a new
  one. If you selected a span, it is recorded as the link back.
- **Several turns at once.** Ctrl/⌘-click (or press Space on) turns in the tree to pick them, then **⤓ Add to
  dataset** adds every picked turn (up to 50 at a time). A turn that is already in the dataset, or that has no text,
  is skipped and the reason is shown.
- **Replay turn.** **↻ Replay turn** adds the turn to a dataset and opens the Playground's Dataset mode on that
  example, so you can try another model at once.
- **Automatically (off by default).** An optional rule copies turns that went wrong into one dataset. It adds a turn
  when a judge evaluator fails it, or when you rate it 👎. Added examples get the tag `auto`. Code checks never
  trigger it. The rule is paused while content viewing is off. It has no screen yet: set it with
  `POST /api/datasets/settings` (see below) or in `config.json`:

  ```json
  { "datasets": { "autoAdd": { "enabled": true, "dataset": "auth-regressions", "onFail": true, "onBad": true } } }
  ```

  `onFail` and `onBad` default to on once `enabled` is true. The dataset must exist.
- **By import.** See below.

## Managing datasets

Open **Datasets** in the sidebar. The list shows each dataset with its example count and last change. Open one to see
its examples.

- **Edit in place.** Add or change the **reference answer** of an example (it is what `reference_match` compares
  against) and its **tags**. Delete an example, or the dataset, after a confirmation.
- **Export JSONL.** Downloads one example per line. An exported line carries the trace key and a sealed span, never a
  raw session id or a file path.
- **Import JSONL.** Choose a file of exported lines. An import is **atomic**: if any line is bad, or the result would
  pass 1,000 examples, nothing is written, and the first 20 reasons are shown (for example `line 3: …`). Importing
  into an existing dataset appends. An example whose id already exists there gets a new id.

An import keeps the link back to the session only on the same running server, because trace keys use a secret that is
new for every process. After a restart, or on another machine, examples import with no link. Even where the link
survives, the span is dropped (a sealed span id cannot be turned back), so the example points to the turn, not to the
span.

With content viewing off (the default in server mode), adding from the trace and exporting are refused, and texts
appear as `null`/hidden. See [Privacy](#privacy).

## Replay

Open **Gateway → Playground** and switch to **Dataset** mode. Pick a dataset, one example or all of them, one to
three models, the evaluators and the caps.

What is sent:

- **Text only.** The recorded messages go as they were saved. A `tool` message is sent as a user message that starts
  with `[tool result: <name>]`, because a saved result has no call id to pair with. The saved tools are **declared**
  to the model (name and description, with an open parameter schema) and **never run**. A tool built from a trace has
  an empty description; an imported one may carry text, which is masked for an external model like the messages and
  shown in the preview. If the model proposes a tool call, it is shown as a proposal and that example ends there.
- **One call per example and model.** Every call goes through the gateway, so usage, cost, OTLP export and key
  budgets apply as for any request.

Which models:

- Only `provider/model` names of a usable gateway provider. **Aliases and routes are refused**, because their real
  target is not known up front.
- **Local models come first**: Ollama, then LM Studio, then other private providers, then external ones. Ollama or LM
  Studio must be added under **Gateway → Providers** to be used; running on this machine is not enough.
- A model whose name ends in `cloud` counts as external. Embedding and rerank models are not listed.

External providers follow the same rule as the judge:

- **A known price is required.** An external model with no known price is not offered, because the cost cap could not
  count it.
- **Masked, with personal data hidden too.** Secrets are masked as everywhere; for an external model, emails, phone
  numbers and similar personal data are also hidden, in the messages and in the declared tool descriptions.
- **Preview, then confirm.** **Preview what will be sent** shows the first example exactly as each external model
  would receive it: the messages and the declared tools (names and masked descriptions). Nothing is sent until you press **Send**. Any change to the form (dataset, examples, models,
  evaluators, caps) while the preview is open drops the preview; you preview again before sending. A run that reaches
  the server without a matching preview is refused (428).
- **With content viewing off the preview is refused**, so external models cannot run. Local models still work and
  their texts come back hidden. The Playground says so.

Caps (a run's own, set in the form):

| Cap | Default | Allowed |
|---|---|---|
| Cost | $0.50 | more than $0, at most $10 |
| Requests | 100 | a whole number, 1 to 1,000 |

The run **stops before the next call** once a cap is reached, and the result says which. A call that is already in
flight completes, so the cost can pass the cap by one call. There is no stop button and no cancel route. Only one
experiment runs at a time on a server; a second start is refused (409). A call that gets no answer in time is
recorded as an error and the run goes on.

## Scoring and experiments

Each answer is scored by the evaluators you pick:

| Evaluator | Kind | What it checks |
|---|---|---|
| `reference_match` | code | the answer equals, or contains, the example's reference (case, spacing and Unicode form are ignored); only examples with a reference count |
| `secret_leak` | code | a secret in the answer or in a proposed call's arguments |
| `risky_command` | code | a proposed call whose `command` argument is risky |
| `faithfulness`, `task_completion`, `tool_selection`, `relevance` | judge | the [judge evaluators](evals.md#the-evaluators), run on the replayed answer |

The other code checks read log signals, and `user_frustration` is about a whole session, so they do not apply to a
replay.

**Pass rates are strict.** For each model and evaluator, the rate is passes divided by every attempted example. An
errored replay, or a judge that returned no verdict, counts as not passing. `reference_match` counts only examples
that have a reference. The original outputs are shown beside the new ones but are not scored.

**Judge calls count against the judge's limits.** They go through the same single lane, the daily count and the
external cost cap of **Settings → Evals** ([Waiting, caps and limits](evals.md#waiting-caps-and-limits)). A judge
that is off or capped leaves those verdicts empty, which counts as not passing. The run's own caps count replay
requests only.

A finished run is one line in `.data/experiments.jsonl`:

```json
{
  "id": "exp_0123456789abcdef",
  "dataset": "auth-regressions",
  "models": ["local/qwen3"],
  "evaluators": ["reference_match", "faithfulness"],
  "startedAt": 1790000000000,
  "endedAt": 1790000060000,
  "status": "done",
  "stopped": null,
  "caps": { "maxCostUSD": 0.5, "maxRequests": 100 },
  "usage": { "requests": 12, "cost": 0 },
  "perExample": [
    { "exampleId": "ex_…", "model": "local/qwen3", "output": { "text": "…", "proposal": null }, "error": null,
      "labels": { "faithfulness": { "label": "faithful" } }, "cost": 0, "ms": 2100 }
  ],
  "summary": { "models": { "local/qwen3": { "requests": 12, "cost": 0, "ms": 2100, "errors": 0, "proposals": 0,
    "evaluators": { "faithfulness": { "pass": 10, "total": 12, "rate": 0.83 } } } } }
}
```

`stopped` is `null`, `request cap` or `cost cap` (`status` is then `stopped`). It is also `cancelled` when a CLI
run is interrupted (Ctrl-C or a kill), and `error` when a dashboard run fails before it ends.

- **Bounded.** The newest 100 records are kept. Outputs are masked and cut to 4,000 characters (head and tail). A
  record is kept to about 2 MB: a very large one may have its texts shortened or dropped, and is then marked
  `trimmed`.
- **Compare.** Under **Datasets → Experiments**, tick two runs and press **Compare**. Rates are shown side by side
  for the evaluators and models they share. Two runs of different datasets are marked as not like for like.

## The CI gate

```bash
zaafpulse eval --dataset <slug> --model <provider/model> [--model …] \
  [--require '<evaluator>>=<0..1>']… [--max-cost USD] [--max-requests N] [--json] [--ci] [--data DIR]
```

It replays the dataset without the dashboard and prints a table:

```text
EVALUATOR        MODEL        PASS RATE      REQUIRED  RESULT
faithfulness     local/qwen3  83.3% (10/12)  >= 0.80   pass
task_completion  local/qwen3  66.7% (8/12)   >= 0.70   FAIL
```

- `--model` may repeat, up to 3 times. `--max-cost` and `--max-requests` take the ranges of the caps above.
- `--require` takes `>=` or `>` and a number from 0 to 1. **Quote every `--require`**: an unquoted `>` is a shell
  redirect and would write a file instead of passing the requirement. With no `--require`, only the free code
  evaluators run (`reference_match`, `secret_leak`, `risky_command`) and nothing is gated.
- A value flag with no value (for example a trailing `--require`, or `--dataset --ci`) is a configuration error, not a
  pass.
- `--data DIR` is the data folder (the one that holds `config.json` and `.data/`), as for `zaafpulse start`. Without it
  the usual default applies: `ZAAFPULSE_DATA` if set, the checkout's own folder when you run from a git checkout, else
  `~/Library/Application Support/ZAAFPulse` (macOS), `~/.local/share/zaafpulse/data` (Linux) or
  `%APPDATA%\ZAAFPulse` (Windows).
- **Models:** local gateway providers only. The CLI refuses external models (exit 2), because they need the
  dashboard's preview.
- **Judge evaluators** need a judge the way `zaafpulse eval --judge` does: a local model, or Claude Code once its
  preview was confirmed in Settings → Evals. Otherwise it exits 2.

| Exit code | Meaning |
|---|---|
| `0` | the run finished and, with `--ci`, every requirement passed (without `--ci`, a finished run is always 0) |
| `1` | with `--ci`: a requirement failed, or the run stopped early at a cap; also, without `--ci`: the replay itself failed |
| `2` | a configuration error: unknown dataset or model, an empty dataset, a bad flag or value, an external model, or a judge that is required but unavailable |
| `130` | stopped by Ctrl-C, `SIGTERM` or `SIGHUP`; the run ends at once and no partial record is written |

`--json` prints one object on stdout (progress and messages go to stderr):

```json
{
  "ok": false,
  "dataset": "auth-regressions",
  "models": ["local/qwen3"],
  "experiment": "exp_0123456789abcdef",
  "stopped": null,
  "usage": { "requests": 12, "cost": 0 },
  "evaluators": { "local/qwen3": { "task_completion": { "pass": 8, "total": 12, "rate": 0.667 } } },
  "requirements": [
    { "evaluator": "task_completion", "model": "local/qwen3", "op": ">=", "threshold": 0.7,
      "rate": 0.667, "pass": 8, "total": 12, "ok": false }
  ]
}
```

A finished CLI run is appended to the same `.data/experiments.jsonl`, so it shows under **Experiments**.

**A CLI run and the dashboard share the judge's `evals-state.json`.** Writes are atomic, but while both run at the
same time the judge's daily count and cost caps can undercount.

### Recipes

A pull-request gate on a self-hosted runner on the machine that holds the ZAAFPulse data folder (a hosted runner has
no local model and no data):

```yaml
# .github/workflows/eval-gate.yml
name: eval-gate
on: [pull_request]
jobs:
  gate:
    runs-on: [self-hosted, zaafpulse]
    steps:
      - uses: actions/checkout@v4
      # ZAAFPULSE_DATA is set on the runner to the data folder, for example
      # ~/.local/share/zaafpulse/data (Linux) or ~/Library/Application Support/ZAAFPulse (macOS)
      - run: >
          zaafpulse eval --dataset auth-regressions --model local/qwen3
          --require 'faithfulness>=0.8' --require 'task_completion>=0.7' --ci
          --data "$ZAAFPULSE_DATA"
```

A local pre-push hook:

```sh
#!/bin/sh
# .git/hooks/pre-push (chmod +x): block a push when the regression set drops
exec zaafpulse eval --dataset auth-regressions --model local/qwen3 --require 'task_completion>=0.7' --ci
```

The hook needs no `--data` when it runs as the same user as the dashboard.

## Privacy

- **Local by default.** Datasets and experiments live in files on this machine. Replay uses local models first, and
  nothing goes to an external provider unless you pick one, read the masked preview and press Send.
- **Text only.** Saved texts, answers and references are shown as plain text. No Markdown, no HTML from a transcript.
- **Masked on save and on send.** Secrets are masked when a text is saved. For an external model, personal data is
  masked too.
- **Content off.** With `ZAAFPULSE_CONTENT=off` (and by default in server mode) no saved text leaves an API response:
  every text is `null`, including replayed answers and error messages. Adding from the trace, export and the external
  preview are refused (403) and the auto-add rule does nothing. Import, tag edits, deletes and local runs still work,
  because the copy is your own.
- **Dashboard only.** Every route needs the dashboard sign-in. A gateway API key, an MCP tool or an A2A agent cannot
  read or change datasets. Responses name sessions by opaque key, never by file path or raw session id.
- **Opaque spans.** Export lines carry a sealed span id, not a raw one.

### Where the data lives

| File | Holds |
|---|---|
| `.data/datasets/index.json` | dataset names, slugs, counts and times |
| `.data/datasets/<slug>.jsonl` | the examples of one dataset |
| `.data/experiments.jsonl` | the experiment records (newest 100) |

The `datasets` folder is mode 0700 and the files 0600 (not applied on Windows). Auto-add settings are in
`config.json` under `datasets.autoAdd`. In demo mode (`--demo`) the views show synthetic data and nothing is written.

## HTTP API

All routes need the dashboard sign-in. A body is JSON (415 otherwise). Errors are `{ "error": … }`.

| Route | Does |
|---|---|
| `GET /api/datasets` | the datasets, the limits, and whether content is on |
| `POST /api/datasets` | create `{ name, slug? }` |
| `GET /api/datasets/<slug>` | the dataset and its examples |
| `PUT /api/datasets/<slug>` | rename `{ name }` (the slug stays) |
| `DELETE /api/datasets/<slug>` | delete it |
| `POST /api/datasets/<slug>/examples` | add turns `{ items: [{ key, turn, span? }] }` (1 to 50); returns `added` and `skipped` with reasons; 403 with content off |
| `PATCH /api/datasets/<slug>/examples/<id>` | set `{ reference }` (`null` removes it) and/or `{ tags }` |
| `DELETE /api/datasets/<slug>/examples/<id>` | delete one example |
| `GET /api/datasets/<slug>/export` | NDJSON, one example per line; 403 with content off |
| `POST /api/datasets/import` | `{ slug, name?, jsonl }` (up to 16 MB); atomic; 400 with up to 20 `reasons` |
| `GET /api/datasets/settings` · `POST` | the auto-add rule `{ autoAdd: { enabled, dataset, onFail, onBad } }` |
| `GET /api/experiments` | the records (without outputs), the running one, the models and the evaluators |
| `GET /api/experiments/<id>` | one record; while it runs, its progress |
| `POST /api/experiments` | start a run `{ dataset, examples?, models, evaluators, maxCostUSD?, maxRequests?, preview?, confirm? }`; 202 with an id. `preview: true` returns, per external model, `{ model, messages, tools }` as they will be sent (masked) and a `confirm` token; an external model without it gets 428; a run already going gets 409 |

## Known limits

- **No versioning.** An example has created and updated times, nothing more.
- **No prompt management.** Replay sends what was recorded; there is no place to edit and compare prompts.
- **No tool-running agent experiments.** Tools are declared and never run, so an agent loop is not replayed.
- **No sharing with Phoenix or AX.** Datasets stay in ZAAFPulse.
- **No stop button.** A run ends at its caps or when every example has run.
- **The auto-add rule has no screen yet.** Use the API or `config.json`.
- **Local models only in the CLI.** External models need the dashboard.
