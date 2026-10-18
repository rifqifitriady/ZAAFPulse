---
name: zaafpulse-rag
description: Search and grow ZAAFPulse knowledge bases. Retrieval is hybrid (embeddings plus BM25) over documents ingested locally, and the results come with document titles to cite. Use it when the user asks what their documents or policies say, wants answers grounded in their files, or wants to add a document to a knowledge base.
---

# ZAAFPulse: RAG

Requires `ZAAFPULSE_URL` and `ZAAFPULSE_KEY`, with a key that has the `rag` scope. For setup, read the `zaafpulse` skill.

## List knowledge bases

```bash
curl -s $ZAAFPULSE_URL/v1/knowledge -H "Authorization: Bearer $ZAAFPULSE_KEY" | jq -r '.data[] | "\(.id)\t\(.documents) docs\t\(.name)"'
```

## Search

```bash
curl -s $ZAAFPULSE_URL/v1/knowledge/company-policies/search -H "Authorization: Bearer $ZAAFPULSE_KEY" -H "Content-Type: application/json" \
  -d '{"query":"refund limit without approval","k":5}'
```

The response holds `results[]` with these fields:

- `text`: the passage
- `document`: the title to cite
- `score`
- `semantic`: present when embeddings were used

`method` is `hybrid`, or `keyword` when the knowledge base has no embedding model.

## Add a document

```bash
curl -s $ZAAFPULSE_URL/v1/knowledge/company-policies/documents -H "Authorization: Bearer $ZAAFPULSE_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Refund policy 2026","content":"Refunds up to $100 need no approval…","kind":"text","source":"policy portal"}'
```

- `kind` is `text`, `markdown`, `html`, `csv` or `json`.
- Text is chunked (about 900 characters, overlapping by 150) and embedded when the knowledge base has an embedding model.

## Good practice

- Answer from the passages and cite the `document` titles.
- When nothing relevant comes back, say so instead of guessing.
- Add documents only when the user asks you to.
