# Schedule files

Put one Markdown file in `daily/`, `weekly/`, `monthly/` or `once/`. Use JSON between the opening `---` lines, then the task instructions. No registration step is needed.

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

Set your working directory, timezone and context paths; context paths are relative to `cwd`. Keep material within its approved provider scope. Enable the file when instructions, access and timing are ready. Preserve paused state during edits unless enabling was requested.

`model: null` uses Pi's configured default. Explicit provider/model bindings are never silently replaced. Checks use Pi, including when configured with an Anthropic/Claude model. Supported efforts are `off`, `minimal`, `low`, `medium`, `high` and `xhigh`; the selected model must support the choice.

## Timing

Use one `HH:mm` time or 1 to 48 unique times, such as `"at": ["09:00", "12:00", "18:00"]`. After downtime, only the latest due time on the current local date is eligible.

For hourly checks between 08:00 and 17:00, replace `at` with:

```json
"window": { "start": "08:00", "end": "17:00", "everyMinutes": 60 }
```

This schedules ten checks in one file. The interval starts at `start`; it includes `end` only when that time falls on the interval. Windows use one local day, cannot cross midnight, and accept an integer `everyMinutes` from 1 to 1440, with at most 48 checks. Use either `at` or `window`. After downtime, only the latest due check inside the window is eligible; none starts after its end minute.

Weekly files also need `"weekday": 1` (Sunday 0 through Saturday 6), or a list of days such as `"weekday": [1, 2, 3, 4, 5]` for Monday to Friday. Monthly files need `"day": 1` (1 to 31); missing dates are skipped. All times use the named timezone. Repeated daylight-saving times run once; nonexistent times are skipped. IDs must be unique across folders.

## One-time schedules

A file in `once/` runs on one date and never again. Add `"date": "2026-05-04"` (a real local calendar date in the file's timezone) to the usual fields; only `once/` files may carry `date`. `at` (one time or a list) or `window` then apply to that date only.

```json
"date": "2026-05-04",
"at": "15:00",
"timezone": "America/Sao_Paulo"
```

If Companion was not running at that time, the check runs once at the next tick, however late, provided the time is after Companion's initialization. With several times, the latest passed time runs and earlier missed ones are skipped. Once a time has started, in any outcome, it never runs again; to repeat it, create a new file or change the date. Disabled files never run. The dashboard shows `scheduled`, then `done`; `expired` means the time passed before initialization and nothing ran. `run_schedule` can still run the file manually without using up the date.

For "remind me at 3pm", use today's date in the user's timezone. For "in 2 hours", compute the date and `HH:mm` from the current time. Set `enabled` to `true` when the user asked for the reminder, bind the background model and effort shown in the runtime block, and write the reminder or check in the instructions. Leave finished files in place; they are the record.

## Validate and run

`pi-companion schedules` lists files and validation errors without calling a model. Initialization also needs no model. Editing files requires neither code changes nor a restart. One file counts as one schedule, regardless of its times.

Keep the dashboard or headless runner active for checks to execute. A saved file does not prove a check ran. An external supervisor can manage the runner; Companion does not install one. Old non-Pi harness bindings remain on disk but fail validation; saved configuration and history remain readable.
