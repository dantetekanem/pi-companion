# pi-companion

Companion schedules checks in Pi and tells the agent to append important updates and reports to `~/.companion-reports-updates.md`.

The first startup task asks whether to follow that file with `tail -f` in a new Herdr pane below the current pane. The agent opens it only after approval. Declining does not block setup. The file is shared across sessions, append-only, and has no unread state or updates/reports UI. Routine no-change checks stay in `~/.companion-notes/`.

The footer shows only active schedules: `Companion · 3 schedules`, and only after `/companion` or `/companion start` has run in that session. This started state survives reloads.

The schedule count includes enabled, pending or running recurring Companion tasks in this session whose names match the registry. Paused, canceled, finished, unrelated, and other sessions' tasks are excluded. The count refreshes on session load, after agent runs, and after Companion controls finish; it does not poll for external changes. If the scheduler or registry cannot be read, the count is omitted rather than shown as zero.

## Install locally

Requires Pi 0.85.1-compatible APIs. Register your local checkout with `pi install /path/to/pi-companion`, then run `/reload` in Pi. To try it for one invocation instead:

```sh
pi -e ./src/index.ts
```

Each session can run Companion independently, with its own schedules and schedule-control state. Installation does not create schedules or import existing notes or saved results.

## Commands

| Command | Action |
| --- | --- |
| `/companion` | Start Companion (equivalent to `/companion start`) |
| `/companion start` | Resume Companion-paused schedules, then send the bundled Companion instructions |
| `/companion stop` | Stop this session's approved recurring Companion schedules |

Start reads `src/prompt.md` and sends its contents directly to the agent. It resumes only unchanged, still-approved schedules stopped by Companion; with no saved pause receipts, it does not require schedule control. Stop preserves history, the schedule-count footer, and schedule-control receipts. A firing delivery finishes without being aborted; Companion then disables its next recurrence. Unfinished stop requests resume in the same session after reloads.

`~/.companion-schedules.md` is the source of truth for recurring tasks, cadence, timezone, checklists, and referenced working instructions. The agent reads it each run and uses relevant `~/.companion-notes/` as the previous-run baseline. A missing baseline means a first run, not a setup blocker. Task-specific content stays in the registry rather than the extension.

Schedule control requires the existing `@jl1990/pi-scheduler` package. A task must belong to the exact current session (`scope: session`), recur, and have a name exactly matching a `##` heading in `~/.companion-schedules.md`. Other sessions, cwd/global tasks, one-shot tasks, canceled work, and unrelated names are excluded. The extension blocks identifiable Companion `schedule_task` calls when they use another scope. Direct scheduler slash commands and tasks without a registry-matching name remain outside that gate.

Companion uses the scheduler's commands and confirms their saved state. The extension does not create schedules or change recurrence expressions; the agent reconciles tasks from the registry. Startup instructions also tell the agent to update existing current-session Companion task prompts with the append-only destination. Start follows the scheduler's next-run calculation, resets interval timing, and does not backfill missed checks. Manually canceled, edited, or subsequently disabled tasks are not resumed. If a command cannot be confirmed, inspect `/schedules all`.

## Append important findings

The agent appends only new actions or decisions, material changes, actionable blockers, useful new syntheses, or explicitly requested reports. Completing a check alone does not justify an entry. Routine no-change results, individual feedback ratings, repeated findings, and non-actionable collection failures stay in notes.

Each entry has a timestamp with timezone, task name, update/report label, title, and stable publication ID. Lead with the finding, include necessary context and evidence links, and account for expected checks, including failures and gaps. Compare the file and notes before appending; check the ID before retrying an uncertain write. Corrections are new entries referring to the original. Never overwrite, truncate, rotate, or rewrite the file.

The prompt directs the agent to use an actual append operation, not a read-modify-write replacement. There is no custom save tool, file watcher, or report generator. Relevance, collection completeness, and duplicate detection are agent responsibilities, not enforced by extension code. The agent does not echo full entries in chat.

## Storage and limits

Schedule-control state remains in `companion/<session-ID hash>.json` under Pi's agent directory, with private permissions and atomic replacement. Existing saved results remain untouched in those files; they are not migrated into the Markdown file. Resuming the same session preserves schedule state; new sessions and forks have independent state.

Pi Scheduler's shared state file has no cross-process locking; that limitation still applies. A crash between disabling a task and saving its pause receipt can leave it disabled without a receipt. Inspect it with the scheduler's commands rather than blindly re-enabling it.

## Tests

Set `PI_PACKAGE_ROOT` and `PI_SCHEDULER_ROOT` to the already installed Pi and scheduler package directories, then run the relevant tests:

```sh
node --test test/companion.test.mjs test/scheduler-integration.test.mjs
```

Tests use temporary storage, Pi's bundled loader, and an isolated home for the scheduler. Prompt instructions are verified by direct inspection, not prose assertion tests.
