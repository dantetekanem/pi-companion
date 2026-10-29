# Find work worth automating

Companion can review selected Pi or Claude sessions for repeated daily, weekly or monthly requests. This is optional. Nothing is collected or sent at startup.

Create a local JSON selection with explicit source files, a date window and the exact destination:

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

Run `pi-companion patterns-preview --selection /absolute/selection.json`. Inspect the excerpts, source hashes, omissions and destination in the local preview. It contains user-role text and tool names, not complete transcripts or tool arguments. Keep the preview private.

Only after reviewing it, stop any running Companion owner and run `pi-companion patterns-submit --preview HASH --confirm HASH`, using the returned hash twice. This sends the previewed evidence to that model, with tools disabled. Source or destination changes require a new preview. The resulting report appears on the dashboard and does not create or enable schedules. Repeating the same submission does not run it again.

Use the same `--home` for both commands and the dashboard. Claude is also supported as a destination when explicitly selected, with its model alias and effort. Exclusion text stays local; the model receives exclusion counts and the collector's omissions. Counts describe only the selected material, not all your work or proof that a feature is unused.
