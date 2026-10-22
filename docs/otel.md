# OpenTelemetry export

ZAAFPulse can send traces of what the Agent Gateway does to any backend that accepts OTLP over HTTP: Dynatrace, Arize Phoenix, Arize AX, Langfuse or your own OpenTelemetry Collector. You then see every model call with its tokens, cost and errors next to the rest of your systems.

Export is **off** until `config.json` says `"enabled": true`. Prompts, answers and tool arguments are **not** sent unless you also set `"captureContent": true`.

No extra software is needed: ZAAFPulse writes OTLP itself (binary protobuf by default, JSON on request), with no dependencies.

## What you get

| Span | Kind | When |
|---|---|---|
| `POST /v1/chat/completions` (and the other gateway routes) | SERVER | a gateway request that reached a model or a tool. It continues the caller's W3C `traceparent`. |
| `chat {model}`, `embeddings {model}` | CLIENT | every model call the gateway made, including fallback attempts and the calls agents make |
| `invoke_workflow {pattern}` | INTERNAL | a collaboration run (sent when the run ends or pauses for approval) |
| `invoke_agent {agent name}` | INTERNAL | one agent's turn inside a run |
| `execute_tool {tool}` | INTERNAL | a tool an agent called inside a run (`zp_handoff`, consults, integration tools) |
| `plan`, `judge` | INTERNAL | the planner and the vote judge |
| `execute_tool {integration tool}` | CLIENT | every call to an integration tool (Dynatrace, n8n, MCP servers …), from agents, the MCP server or the dashboard |

A collaboration run's spans sit in the same trace as the request that started it. Model calls inside a run appear once, as the gateway's `chat` spans (with `gen_ai.agent.id`), so tokens and cost are never counted twice. The reply of `/v1/collaborate` and `/v1/runs/:id` carries `otel: { traceId, spanId, sampled }`, the trace the run belongs to.

### Attributes

The names follow the OpenTelemetry GenAI semantic conventions as published in [open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai) (schema `gen-ai-dev/1.42.0-dev`, read at commit `547934a` of 18 Oct 2026, built on core semantic conventions v1.44.0). These conventions are still marked *Development*, so names may change; this page lists exactly what ZAAFPulse sends.

Model call spans (`chat`, `embeddings`):

| Attribute | Example |
|---|---|
| `gen_ai.operation.name` | `chat`, `embeddings` |
| `gen_ai.provider.name` | `openai`, `anthropic`, `gcp.gemini`, `gcp.vertex_ai`, `aws.bedrock`, `azure.ai.openai`, `mistral`, `x_ai` …; other presets send their own id (`openrouter`, `ollama`) |
| `gen_ai.request.model` | `openai/gpt-6.1` (the gateway model name) |
| `gen_ai.response.model` | the model that answered (differs when a route fell back) |
| `gen_ai.request.stream` | `true` |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | `1200`, `310` (input includes cached tokens, as the convention says) |
| `gen_ai.usage.cache_read.input_tokens` | `800` (when the provider reports cache reads) |
| `gen_ai.response.finish_reasons` | `["stop"]`, `["end_turn"]`, `["tool_calls"]` (the reason in the format the client asked for) |
| `gen_ai.response.id` | `chatcmpl-…`, `msg_…`, `resp_…` |
| `gen_ai.response.time_to_first_chunk` | `0.42` (seconds, streaming only) |
| `gen_ai.conversation.id` | the gateway session, when there is one |
| `gen_ai.agent.id` | the agent that made the call |
| `server.address`, `server.port` | the provider's host |
| `error.type` | the HTTP status (`429`, `500`) or `network_error`, with span status ERROR |
| `zaafpulse.cost.usd` | `0.0042` (ZAAFPulse's list-price cost of the call) |
| `zaafpulse.api_key.id` | `key_…` (the gateway key's id, never its secret) |
| `zaafpulse.provider.id`, `zaafpulse.request.kind`, `zaafpulse.request.format`, `zaafpulse.request.model_alias`, `zaafpulse.token_saver.saved_tokens` | ZAAFPulse details |

With `captureContent: true` they also carry `gen_ai.input.messages`, `gen_ai.system_instructions` and `gen_ai.output.messages`, as JSON text in the convention's message shape, each cut to `contentMaxChars`.

Run spans carry `gen_ai.operation.name`, `gen_ai.workflow.name`, `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.usage.*` (totals), `gen_ai.conversation.id`, `zaafpulse.run.id`, `zaafpulse.run.state`, `zaafpulse.cost.usd` and the run's own `zaafpulse.*` details (pattern, effort, depth, tool calls). With `captureContent`, the `invoke_workflow` span holds the task and the answer.

Integration tool spans carry `gen_ai.operation.name` (`execute_tool`), `gen_ai.tool.name`, `gen_ai.tool.type` (`extension`), `zaafpulse.integration.id`, `zaafpulse.integration.type`, `mcp.method.name` (`tools/call`, for MCP integrations) and `zaafpulse.tool.argument_names`. Argument values (`gen_ai.tool.call.arguments`) and results (`gen_ai.tool.call.result`) are sent only with `captureContent`, capped.

The resource has `service.name` (default `zaafpulse`), `service.version`, `telemetry.sdk.name` (`zaafpulse`), `telemetry.sdk.language` and anything you add under `resourceAttributes`.

## Configuration

Add an `otel` section to `config.json`. ZAAFPulse reads it again within a few seconds of a change; no restart needed.

```json
"otel": {
  "enabled": true,
  "endpoint": "http://localhost:4318",
  "headers": { "Authorization": { "keychain": "acc.otel" } },
  "serviceName": "zaafpulse",
  "captureContent": false
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turns export on. Nothing is sent and no connection is made while it is off. |
| `endpoint` | `http://localhost:4318` | The OTLP base URL; `/v1/traces` is added unless the URL already ends with it. |
| `tracesEndpoint` | | The full traces URL, used as written (for endpoints with another path). |
| `protocol` | `http/protobuf` | `http/protobuf` or `http/json`. gRPC is not supported. |
| `headers` | | Header name → text, or a secret reference `{ "keychain": "acc.…" }` / `{ "env": "NAME" }`. A header whose name looks secret (`Authorization`, `*api-key*`, `*token*`, `*secret*`) must be a reference: plain text there turns export off with an error. |
| `serviceName` | `zaafpulse` | `service.name` of the resource. |
| `resourceAttributes` | | Extra resource attributes, for example `{ "deployment.environment.name": "prod" }`. |
| `captureContent` | `false` | Send prompts, answers, system instructions and tool arguments and results. |
| `contentMaxChars` | `4096` | Cap per content attribute (256 to 65536). |
| `timeoutMs` | `10000` | Timeout of one export request. |
| `compression` | `none` | `gzip` to compress requests. |
| `batch` | | `maxQueueSize` (2048), `maxExportBatchSize` (512), `scheduleDelayMs` (5000). |
| `retry` | | `maxAttempts` (5), `initialBackoffMs` (1000), `maxBackoffMs` (30000). |

Store secrets the same way as for integrations (see [integrations.md](integrations.md)), for example:

```bash
security add-generic-password -a "$USER" -s acc.otel -w
```

Header values from secrets are masked as `***` in logs and error messages.

### Standard environment variables

When `config.json` does not set a value, the standard variables are used:

| Variable | Used for |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | full traces URL (as written) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | base URL (`/v1/traces` is added) |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | `name=value,name2=value2` (percent-encoded values); `config.json` headers win on the same name |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | resource |
| `OTEL_EXPORTER_OTLP_PROTOCOL`, `…_TRACES_PROTOCOL` | `http/protobuf` or `http/json` |
| `OTEL_EXPORTER_OTLP_TIMEOUT`, `…_TRACES_TIMEOUT` | milliseconds |
| `OTEL_EXPORTER_OTLP_COMPRESSION`, `…_TRACES_COMPRESSION` | `gzip` |
| `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, `OTEL_BSP_SCHEDULE_DELAY` | batching |
| `OTEL_SDK_DISABLED=true` | forces export off |

Export is on when `config.json` has `"enabled": true`, or when `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set, which is handy in Docker. If your shell sets one of these for other tools and ZAAFPulse should not send, put `"otel": { "enabled": false }` in `config.json` or set `OTEL_SDK_DISABLED=true`.

### Trace context

A client that sends `traceparent` (and `tracestate`) to the gateway gets its trace continued: the gateway's SERVER span is a child of the caller's span, and everything below it shares the trace id. A caller that sends the *not sampled* flag (`-00`) gets nothing recorded for that request. Without a `traceparent`, every request starts a new trace.

### Delivery

Spans wait in a bounded queue and go out in batches (when 512 are waiting, or every 5 seconds). One export is in flight at a time. `429`, `502`, `503`, `504` and network errors are retried with exponential backoff and jitter, honouring `Retry-After` (up to twice `maxBackoffMs`); other errors are not retried. When the queue is full, new spans are dropped and counted, never blocking a request. On shutdown (Ctrl-C, `zaafpulse stop`, launchd) queued spans get up to 2 seconds to go out.

### Local store

The same spans also go to ZAAFPulse's own trace store (see [explorer.md](explorer.md#the-local-trace-store)),
whether export is on or off. Content attributes never go there.

### Calls to remote agents and MCP servers

- A remote A2A agent is called inside a CLIENT span `a2a {agent id}` (`rpc.system: a2a`, `server.address`), and
  the request carries its `traceparent`.
- A call to an MCP server over Streamable HTTP carries the `traceparent` of its `execute_tool` span, as a header
  and as `params._meta.traceparent`.

### Spans coming back

A remote agent or MCP server **on this machine** that exports OpenTelemetry can send its spans back as OTLP/HTTP
JSON (`content-type: application/json`) to `http://127.0.0.1:<port>/v1/traces`. They show in the same trace.

- Only from this machine: the connection must come from loopback, with a loopback `Host` and no forwarding
  header (`x-forwarded-*`, `forwarded`, `x-real-ip`, `via`). Do not put a reverse proxy in front of this path.
- Only for traces whose `traceparent` ZAAFPulse itself sent to an MCP server or a remote A2A agent in the last
  24 hours. Spans of any other trace are dropped.
- At most 2,000 spans per trace. A body over 1 MB is cut off and the connection is closed.
- A span needs a valid start and end. Content attributes, `zaafpulse.*` attributes and numbers that are not
  finite are dropped.
- A resource whose `service.name` is `zaafpulse` is refused, so pointing the OTLP export back at this server is
  ignored.
- Returned spans add no tokens or cost to a trace's totals, and never replace one of ZAAFPulse's own spans.

The reply's `partialSuccess.rejectedSpans` counts what was dropped.

## Backends

### Dynatrace

Dynatrace accepts OTLP over HTTP with **binary protobuf only** (the default here; do not set `http/json`).

1. Create an access token with the scope **`openTelemetryTrace.ingest`** (Access tokens → Generate new token), and store it with the `Api-Token ` prefix:

   ```bash
   security add-generic-password -a "$USER" -s acc.otel-dynatrace -w   # paste: Api-Token dt0c01.…
   ```

2. Add to `config.json` (use your environment id, without `.apps`):

   ```json
   "otel": {
     "enabled": true,
     "endpoint": "https://{your-environment-id}.live.dynatrace.com/api/v2/otlp",
     "headers": { "Authorization": { "keychain": "acc.otel-dynatrace" } }
   }
   ```

   Through an Environment ActiveGate, the endpoint is `https://{your-activegate-domain}:9999/e/{your-environment-id}/api/v2/otlp`.

A platform token works too: store it as `Bearer dt0s16.…`; it needs the scope `openpipeline:traces:ingest`.

### Arize Phoenix (local)

Phoenix accepts **binary protobuf only**. With Phoenix on its default port:

```json
"otel": {
  "enabled": true,
  "endpoint": "http://localhost:6006/v1/traces",
  "headers": { "x-project-name": "zaafpulse" },
  "resourceAttributes": { "openinference.project.name": "zaafpulse" }
}
```

Phoenix reads the project from the `x-project-name` header; `openinference.project.name` is the resource attribute OpenInference uses for the same thing. A Phoenix with authentication turned on also needs `"Authorization": { "keychain": "acc.phoenix" }` holding `Bearer <api key>`.

### Arize AX

```json
"otel": {
  "enabled": true,
  "endpoint": "https://otlp.arize.com/v1/traces",
  "headers": {
    "arize-space-id": "U3BhY2U6…",
    "arize-api-key": { "keychain": "acc.otel-arize" }
  },
  "resourceAttributes": { "openinference.project.name": "zaafpulse" }
}
```

Arize's documentation says the OTLP/HTTP endpoint expects the hyphenated `arize-space-id` and `arize-api-key` headers, while gRPC uses `space_id` and `api_key`; some of its pages show the unprefixed names with HTTP too. If no spans arrive, try `space_id` and `api_key` as the header names. Spaces in the EU region use their own host (shown in the AX space settings).

### Langfuse

Langfuse accepts OTLP over HTTP (protobuf or JSON) with Basic auth made of your public and secret key:

```bash
echo -n "pk-lf-…:sk-lf-…" | base64        # then store "Basic <that value>" as acc.otel-langfuse
```

```json
"otel": {
  "enabled": true,
  "endpoint": "https://cloud.langfuse.com/api/public/otel",
  "headers": {
    "Authorization": { "keychain": "acc.otel-langfuse" },
    "x-langfuse-ingestion-version": "4"
  }
}
```

Use `https://us.cloud.langfuse.com/api/public/otel` for the US region, or `http://localhost:3000/api/public/otel` for a self-hosted Langfuse (v3.22 or later). Without the `x-langfuse-ingestion-version: 4` header, Langfuse may show the data up to 10 minutes late. Langfuse reads model, usage and `gen_ai.operation.name` from the attributes above; its own cost fields are not set, so ZAAFPulse's cost is in `zaafpulse.cost.usd`.

### A local OpenTelemetry Collector

Point ZAAFPulse at the collector's OTLP/HTTP receiver and forward from there to anything the collector supports:

```json
"otel": { "enabled": true, "endpoint": "http://localhost:4318" }
```

```yaml
# otelcol.yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
```

```bash
otelcol-contrib --config otelcol.yaml
```

## Troubleshooting

- Nothing arrives: check that `"enabled": true` is inside `"otel"`, and look at the ZAAFPulse log for lines starting with `otel:`. A configuration problem (a missing Keychain item, a plain-text secret, an unsupported protocol) turns export off and says why once.
- `HTTP 415` from Dynatrace or Phoenix: the protocol is `http/json`; remove it to use protobuf.
- `HTTP 401` / `403`: the token or its scope is wrong. Dynatrace needs `openTelemetryTrace.ingest`.
- Spans dropped: the endpoint is slower than the traffic; raise `batch.maxQueueSize` or lower the traffic.
- The `mcp.js` stdio MCP server (what Claude Code, Cursor, Codex and the other clients start) runs in its own process. It exports its own `execute_tool` spans with the same `otel` settings, but reads `config.json` only when the client starts it: restart the client (or its MCP server) after changing `otel`. Its `otel:` log lines go to the client's MCP log (stderr).
