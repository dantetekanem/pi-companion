# Pi Companion

Companion runs scheduled checks through Pi and saves their results as Markdown reports. Chat with the agent, watch checks as they run, and read completed reports in the terminal.

![Pi Companion showing Chat, Reports and Schedules in the terminal](docs/images/companion-cli.png)

## Run it

Run from a checkout containing the standalone CLI:

```sh
pnpm install
pnpm pi-companion
```

You need Node 22.19 or newer, pnpm, configured Pi credentials and `pi` on PATH. This checkout uses Pi SDK/TUI 1.4.0. If `pi-companion` is already on PATH, launch it from any directory:

```sh
pi-companion
```

First launch creates `~/.companion` and connects Pi without sending a model request. Later launches reopen the same conversation. Use `--home /absolute/path` or `COMPANION_HOME` for another workspace.

Companion uses your ordinary Pi tools, extensions, MCP servers and project context. Models configured in Pi, including Anthropic/Claude models, work here. Pi's own screens and custom extension widgets are not reproduced.

Already using Companion? Read the [CLI update steps](docs/upgrade.md#already-using-the-cli) or the [legacy migration steps](docs/upgrade.md#legacy-pi-extension-before-planning). Opening a new workspace never imports old data or disables the old extension.

## Use it

Chat opens ready to type. Reports holds completed checks; Schedules shows their next run and any configuration errors. Running checks get their own read-only tabs. Finishing the selected check opens its report.

- **Enter** sends a message or opens the selected report.
- **Left/Right** changes views when the chat draft is empty; otherwise it moves the cursor.
- **Arrow keys** select reports. **Page Up/Down** and the mouse wheel scroll.
- **Escape** leaves a report or returns to Chat without losing the draft.
- **k** cancels the selected running check. Jobs have no automatic execution deadline.
- **Ctrl+C** quits.

Type `/` to see local commands. `/clear` hides visible chat without deleting history or changing model context. `/reset` starts a fresh conversation and resets the displayed cost estimate; old transcripts, usage history and background work remain. Pi's editor shortcuts and configured editor keybindings work in the composer.

Colors follow Pi's saved theme. The header shows connection state; the status bar shows model, context usage and estimated cost. Critical and useful report summaries appear in Chat; no-news reports stay in Reports.

Ask the agent to run a configured check now, even if its recurring schedule is paused. This runs it once without changing its schedule.

## Add a schedule

Create a Markdown file in `~/.companion/schedules/daily/`, `weekly/` or `monthly/`:

```markdown
---
{
  "id": "morning-recap",
  "title": "Morning recap",
  "at": "09:00",
  "timezone": "America/Sao_Paulo",
  "enabled": false,
  "harness": "pi",
  "model": "provider/model",
  "effort": "medium",
  "cwd": "/absolute/project/path",
  "context": ["notes/current.md"]
}
---
Check the approved notes for changes worth acting on. Cite the evidence.
```

Set your paths, timezone and model, then enable the file. `model: null` uses Pi's default. The [schedule guide](src/prompts/schedule-setup.md) covers multiple daily times, hourly windows and weekly/monthly settings. Companion reloads edited schedules automatically. Keep the dashboard or headless runner open for checks to run.

## Run without the dashboard

`pi-companion run` runs in the foreground for your supervisor to manage. Companion does not install a service. Only one runner can own a workspace.

These commands read saved state without starting Pi or schedules:

```sh
pi-companion status --plain
pi-companion schedules
pi-companion history
```

After a crash, unfinished work is marked interrupted rather than retried. A stale owner lock can take up to five minutes to expire; do not delete a live owner's lock. Costs are estimates, not invoices. See [architecture and recovery details](docs/v2-design.md).

To find recurring work in selected past sessions, use the optional [session review](src/prompts/session-patterns-setup.md). For `/companion` inside Pi, see the [legacy guide](docs/legacy.md). Migration instructions include an [agent checklist](docs/upgrade.md#agent-checklist).
