---
name: zaafpulse-mcp
description: Call the user's integration tools through ZAAFPulse's MCP server over HTTP (JSON-RPC at /mcp). The tools cover AI usage and quality, OmniRoute, n8n, observability and the other integrations configured in ZAAFPulse. Use it when the user wants live data or actions from those integrations, or wants to add ZAAFPulse as an MCP server in a client.
---

# ZAAFPulse: MCP tools

Requires `ZAAFPULSE_URL` and `ZAAFPULSE_KEY`, with a key that has the `mcp` scope. For setup, read the `zaafpulse` skill.

## Add ZAAFPulse to an MCP client

```bash
claude mcp add --transport http zaafpulse $ZAAFPULSE_URL/mcp --header "Authorization: Bearer $ZAAFPULSE_KEY"
```

JSON config, for clients that use one:

```json
{ "mcpServers": { "zaafpulse": { "type": "http", "url": "http://127.0.0.1:4777/mcp", "headers": { "Authorization": "Bearer zp_..." } } } }
```

## Call it directly (JSON-RPC 2.0)

```bash
# List tools
curl -s $ZAAFPULSE_URL/mcp -H "Authorization: Bearer $ZAAFPULSE_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[] | "\(.name)\t\(.description)"'

# Call one
curl -s $ZAAFPULSE_URL/mcp -H "Authorization: Bearer $ZAAFPULSE_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"acc_usage_summary","arguments":{"range":"7"}}}'
```

- The answer is `result.content[]`, a list of text parts.
- A tool error comes back with `result.isError: true`.

## Good practice

- List tools first, and use only names that the list returns.
- Tools that write anything are disabled unless the user allowed writes for that integration.
- Integration secrets stay in the macOS Keychain and never appear in tool results.
