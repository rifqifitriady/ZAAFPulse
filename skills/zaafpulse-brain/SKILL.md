---
name: zaafpulse-brain
description: Read the user's second brain through ZAAFPulse (read only). Sources are Obsidian (the default), Logseq, Notion, Tana, Roam Research, mem.ai, Reflect, Heybrain, a PARA workspace, the RAG knowledge bases, and vector databases (Pinecone, Weaviate, Qdrant, pgvector, Chroma). You can list sources, find notes across them, and see how notes link. Use it when the user asks what they have noted about something, which notes relate, or how their knowledge is organised (PARA, hubs, orphans).
---

# ZAAFPulse: second brain

Requires `ZAAFPULSE_URL` and `ZAAFPULSE_KEY`, with a key that has the `rag` scope. For setup, read the `zaafpulse` skill.

Access is **read only**, and note text is not returned. You get titles, tags, groups, PARA buckets, links, times, and a link to open each note in its own app.

## Sources

```bash
curl -s $ZAAFPULSE_URL/v1/brain/sources -H "Authorization: Bearer $ZAAFPULSE_KEY" | jq -r '.data[] | "\(.id)\t\(.label)\t\(.name)"'
```

## Find notes (one source or all)

```bash
curl -s "$ZAAFPULSE_URL/v1/brain/search?q=pricing&source=all&limit=20" -H "Authorization: Bearer $ZAAFPULSE_KEY"
```

Each hit includes:

- `name`, `source`, `group`, `tags`, `para`
- `links`: the titles this note links to
- `backlinks`: the titles that link here
- `url`, which opens the note in Obsidian, Notion, Logseq, Roam and so on
- `modified`

## The map of one source

```bash
curl -s "$ZAAFPULSE_URL/v1/brain/graph?source=obsidian&limit=300" -H "Authorization: Bearer $ZAAFPULSE_KEY"
```

The response contains:

- `notes[]`, with `id`, `name`, `group`, `para`, `tags`, `inLinks`, `outLinks`, and `xy` for vector or RAG sources (2D meaning coordinates)
- `edges[]` as `[from id, to id]`
- `hubs`: the most connected notes
- `orphans`: count of notes with no links
- `unresolved`: names that are linked but have no note

## Good practice

- Search before you claim the user has no notes on a topic.
- Cite note names, and offer the `url` so the user can open the note.
- To change notes, ask the user to do it in their app; ZAAFPulse only reads.
