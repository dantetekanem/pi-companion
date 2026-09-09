# pi-companion

Saved updates and reports for Pi, without hunting through scheduled-task messages.

The footer shows only active schedules: `Companion · 3 schedules`, and only after `/companion` or `/companion start` has run in that session. This started state survives reloads; existing sessions need to run the command once after upgrading. Saved results do not add footer counters. Open an item to read it, press `r` to mark it read, or Escape to leave it unread. Read state survives reloads.

The schedule count includes enabled, pending or running recurring Companion tasks in this session whose names match the registry. Paused, canceled, finished, unrelated, and other sessions' tasks are excluded. The count refreshes on session load, after agent runs, and after Companion controls finish; it does not poll for external changes. If the scheduler or registry cannot be read, the count is omitted rather than shown as zero.

## Install locally

Requires Pi 0.85.1-compatible APIs. Register your local checkout with `pi install /path/to/pi-companion`, then run `/reload` in Pi. To try it for one invocation instead:

```sh
pi -e ./src/index.ts
```

`/companion` starts Companion in the current session. Each session can run Companion independently, with its own schedules, saved results, and footer. Installation does not create schedules, rewrite prompts, or discover, map, or import existing notes and baselines. Ask the owning agent to use `companion_save` for future results and digests.

## Commands

| Command | Opens or controls |
| --- | --- |
| `/companion` | Start Companion (equivalent to `/companion start`) |
| `/companion start` | Resume Companion-paused schedules, then send the bundled Companion instructions |
| `/companion updates` | Unread actionable updates |
| `/companion reports` | All saved reports, including those already read |
| `/companion stop` | Stop this session's approved recurring Companion schedules |

Start reads the extension's `src/prompt.md` and injects its contents directly into the agent; no separately installed prompt is needed. It resumes only unchanged, still-approved schedules stopped by Companion; with no saved pause receipts, it does not require schedule control. Stop preserves history, the schedule-count footer, and safe schedule-control receipts. A firing delivery finishes without being aborted; Companion then disables its next recurrence. Unfinished stop requests resume in the same session after reloads.

`~/.companion-schedules.md` is the source of truth for recurring tasks, cadence, timezone, checklists, and referenced working instructions. The agent reads it each run and uses relevant `~/.companion-notes/` as the previous-run baseline. A missing baseline means a first run, not a setup blocker; the scheduler does not need to retain collection summaries. Task-specific content stays in the registry rather than the extension.

Schedule control requires the existing `@jl1990/pi-scheduler` package. A task must belong to the exact current session (`scope: session`), recur, and have a name exactly matching a `##` heading in the local `~/.companion-schedules.md`. Other sessions, cwd/global tasks, one-shot tasks, canceled work, and unrelated names are excluded. Keep canceled work out of that source of truth. The extension blocks identifiable Companion `schedule_task` calls when they use another scope. Pi exposes this enforcement at tool calls, so direct scheduler slash commands and tasks without a registry-matching name remain outside the Companion gate.

Companion uses the scheduler's commands and confirms their saved state. It does not create schedules or change recurrence expressions. Start follows the scheduler's next-run calculation, resets interval timing, and does not backfill missed checks. Manually canceled, edited, or subsequently disabled tasks are not resumed. If a command cannot be confirmed, inspect `/schedules all`; confirmed changes and unfinished stop requests remain saved.

## Save a result

The agent calls `companion_save` only when it has something the user needs to read: a new action or decision, material change, useful synthesis, or an explicitly requested report. Completing a check alone does not justify publication. The tool validates and saves the result before updating the footer. A scheduler firing, a delivered prompt, or an ordinary assistant reply is not a saved report.

Supply `id`, `kind` (`update` or `report`), `final: true`, `title`, `body`, and `checks`. Each check needs `source`, `outcome`, and `detail`. Outcomes are `findings`, `no_change`, `failed`, `incomplete`, or `not_run`. Include every expected source or task, even those that failed or never ran.

Updates also need a `reason`: `action`, `material`, or `blocker`. Routine no-change results, individual feedback ratings, repeated findings, and non-actionable collection failures stay in notes. Feedback reviews group related evidence into a new problem or recommendation worth considering, not a report per rating. An explicitly requested report may confirm no change.

Before publishing, the agent compares prior publications in notes and omits unchanged findings, including findings already published in the other view. A follow-up explains the material change or an approved reminder. Titles name the finding; bodies lead with the outcome and include only necessary context, evidence links, and any next action. The agent decides relevance and semantic duplication; the extension does not enforce either or audit collection. A run without a saved item leaves its results and gaps in notes.

For example, an explicitly requested reading status report can disclose an incomplete check:

```json
{
  "id": "reading-run-example",
  "kind": "report",
  "final": true,
  "title": "Reading",
  "body": "Could not finish the paper check. No reading recommendation is available.",
  "checks": [
    { "source": "Paper search", "outcome": "failed", "detail": "The source request failed." },
    { "source": "Discussion check", "outcome": "not_run", "detail": "Not attempted after the source failure." }
  ]
}
```

It appears as `Reading report incomplete`. Available means a finalized result was saved, not that collection succeeded. An incomplete blocker can be an update when the user needs to act.

IDs are stable per published finding or synthesis version: up to 128 letters, digits, dots, colons, underscores or hyphens, starting with a letter or digit. Retrying identical content with the same ID preserves read state and avoids duplicates. Conflicting content is rejected; use a new ID for a correction. Keep titles short, bodies within 32,000 characters, and reports within 40 checks. Opening or saving never marks a result read. Read updates leave the unread view but stay stored; reports remain browseable.

## Storage and limits

Results and schedule-control state live outside the package, in `companion/<session-ID hash>.json` under Pi's agent directory. Files use private permissions and atomic replacement. Resuming the same session preserves state; new sessions and forks start empty. Tree navigation does not rewind read state. Existing Companion artifacts stay untouched. The reader wraps plain text and literal Markdown/URLs without opening a browser.

Companion has no cross-session inbox, collector, report generator, or daemon. Pi Scheduler's shared state file has no cross-process locking; that limitation still applies. A crash between disabling a task and saving its pause receipt can leave it disabled without a receipt. Inspect it with the scheduler's commands rather than blindly re-enabling it.

## Tests

Set `PI_PACKAGE_ROOT` and `PI_SCHEDULER_ROOT` to the already installed Pi and scheduler package directories, then run:

```sh
node --test test/companion.test.mjs test/scheduler-integration.test.mjs
```

Tests use temporary storage, Pi's bundled loader/TUI, and an isolated home for the scheduler. Running Node directly avoids package-manager commands that may automatically install dependencies.
