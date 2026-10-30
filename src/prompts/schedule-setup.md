# Schedule files

Put one Markdown file in `daily/`, `weekly/` or `monthly/`. No agent registers it. Use JSON between the opening `---` lines, followed by the task instructions:

```markdown
---
{
  "id": "morning-recap",
  "title": "Morning recap",
  "at": "09:00",
  "timezone": "America/Sao_Paulo",
  "enabled": false,
  "harness": "pi",
  "model": null,
  "effort": "medium",
  "cwd": "/absolute/project/path",
  "context": ["notes/current.md"]
}
---
Summarize useful changes in the approved notes. Cite the evidence and leave completed work alone.
```

Change the working directory, timezone and context paths to your own. Context paths are relative to `cwd`. Keep private material within its approved provider scope. Set `enabled` to `true` when the instructions, access and timing are ready. `model: null` uses Pi's configured default; an explicit Pi-supported provider/model is not silently replaced. The active harness is always Pi, including when the selected model is Anthropic/Claude.

For several checks on the same day, set `"at": ["09:00", "12:00", "18:00"]` in that one file. A list holds 1 to 48 unique `HH:mm` times; the single-string form still works. One file counts as one schedule regardless of its number of times. After downtime, only the latest due time on the current local date is eligible, not every missed check. Editing the file does not require a code change, agent registration or restart. Preserve `enabled: false` when changing a paused routine unless enabling it was requested.

For an hourly check between 08:00 and 17:00, replace `at` with:
```json
"window": { "start": "08:00", "end": "17:00", "everyMinutes": 60 }
```
This is one schedule with ten checks, not ten files. The interval starts at `start`; `end` is included only if it lands on that interval. Both times use the schedule's timezone on the same day; overnight windows are rejected. `everyMinutes` is an integer from 1 to 1440, with at most 48 checks per day. Use either `at` or `window`, never both. After downtime, only the latest due check inside the window is eligible; nothing starts after its end minute.

Weekly files also need `"weekday": 1` (Sunday is 0, Saturday is 6). Monthly files need `"day": 1` (1–31); a day absent from a month is skipped. Local times use the named timezone. A repeated daylight-saving time runs once; nonexistent local times are skipped. IDs must be unique across all three folders.

Use `pi-companion schedules` to validate and list files. Initialization and listing do not call a model. The runner must be active for checks to execute; merely writing a file is not proof that a check ran. An existing schedule still bound to the native Claude harness stays on disk with a per-file parse error and is excluded from execution. Saved config and history remain readable. An external supervisor can manage the headless runner; Companion does not install one.

Use a Pi effort supported by the selected model: `off`, `minimal`, `low`, `medium`, `high` or `xhigh`. Unsupported settings must fail visibly rather than downgrade.
