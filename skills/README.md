# ZAAFPulse: Agent Skills

These skills teach an AI agent (Claude Code, Cursor, ChatGPT, a custom SDK) to use ZAAFPulse: chat on any provider, domain agents, multi-agent collaboration, workflows with approval gates, RAG, the second brain, MCP tools and A2A. Each skill is a `SKILL.md` with `name` and `description` frontmatter.

## Get them

Choose one of these:

- **Install into Claude Code:** Dashboard → Agent Gateway → Code tools → *Agent skills* → **Install**. This copies the skills to `~/.claude/skills/zaafpulse*`, and **Remove** deletes them again.
- **Paste to any AI:** `Read this skill and use it: http://127.0.0.1:4777/skills/zaafpulse/SKILL.md`.
- **Copy by hand:** copy the folders below into the agent's skills directory.

The gateway serves these files itself, so they always match the running version. They are not fetched from a public branch that could change underneath you.

## Configure once

```bash
export ZAAFPULSE_URL="http://127.0.0.1:4777"
export ZAAFPULSE_KEY="zp_..."      # Dashboard → Agent Gateway → API keys (or Code tools → New key)
```

## Skills

| Skill | For |
|---|---|
| `zaafpulse` | **Start here**: setup, scopes, models, errors, and the index of the others |
| `zaafpulse-chat` | Chat in OpenAI, Anthropic, Responses or Gemini format; routes; token saver; embeddings |
| `zaafpulse-agents` | 17 domain agents, the orchestrator, sessions |
| `zaafpulse-collaborate` | Vote, debate, review loop, group chat, handoff, parallel; runs, budgets, verdicts |
| `zaafpulse-workflows` | 24 ready-made workflows with risk tiers and approval gates |
| `zaafpulse-rag` | Search and add to knowledge bases |
| `zaafpulse-brain` | Read the second brain: sources, search, links |
| `zaafpulse-mcp` | Integration tools over MCP |
| `zaafpulse-a2a` | ZAAFPulse as an A2A agent |
