# Find work worth automating

Companion can review selected Pi or historical Claude JSONL sessions for recurring requests. This is optional; startup collects and sends nothing.

Create a local JSON selection naming the files, date window and destination:

```json
{
  "sources": [{"harness": "pi", "path": "/absolute/session.jsonl"}],
  "from": "2026-01-01T00:00:00Z",
  "to": "2026-01-31T23:59:59Z",
  "excludeFiles": [],
  "excludeText": ["private project name"],
  "consent": {"harness": "pi", "model": "provider/model", "effort": "high"}
}
```

1. Run `pi-companion patterns-preview --selection /absolute/selection.json`.
2. Inspect the local preview's excerpts, source hashes, omissions and destination. It contains user text and tool names, not full transcripts or tool arguments. Keep it private.
3. Stop the running Companion owner, then submit the reviewed preview with `pi-companion patterns-submit --preview HASH --confirm HASH`, using the returned hash twice. Changed sources or destination require another preview.

Use the same `--home` for both commands and the dashboard. Submission sends the preview to the chosen Pi model with tools disabled. The report proposes schedules without creating or enabling them. Submitting the same preview again does not rerun it.

Choose a Pi-supported provider/model and effort, including Anthropic/Claude models. Historical Claude files are source data, not Claude execution. Exclusion text stays local; only exclusion counts and collection omissions reach the model. Counts describe selected material, not all your work or proof of unused features.
