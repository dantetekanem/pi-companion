# pi-companion

Companion schedules checks in Pi and tells the agent to append important updates and reports to `~/.companion-reports-updates.md`.

The reports file is shared across sessions, append-only, and has no unread state or updates/reports UI. Routine no-change checks stay in `~/.companion-notes/`. After onboarding, the agent offers to follow reports with `tail -f` in a new Herdr pane below the current pane, only with approval.

The footer shows only active schedules: `Companion · 3 schedules`, and only after `/companion` or `/companion start` has run in that session. This started state survives reloads.

The schedule count includes enabled, pending or running recurring Companion tasks in this session whose names match the registry. Paused, canceled, finished, unrelated, and other sessions' tasks are excluded. The count refreshes on session load, after agent runs, and after Companion controls finish; it does not poll for external changes. If the scheduler or registry cannot be read, the count is omitted rather than shown as zero.

## Install locally

Requires Pi 0.85.1-compatible APIs. Register your local checkout with `pi install /path/to/pi-companion`, then run `/reload` in Pi. To try it for one invocation instead:

```sh
pi -e ./src/index.ts
```

Each session can run Companion independently, with its own schedules and schedule-control state. Installation does not create schedules or import existing notes or saved results.

## First-start onboarding

The bundled prompt starts with a mid-tier model recommendation and inexpensive `read-collect` helpers, then guides a conversation about normal days, Mondays and Fridays, weekly and monthly routines, goals, and habits. It asks which sources are useful, including email, Slack, calendars, and notes, whether to find missing MCP integrations, and whether selected local Pi sessions may inform the setup. Access and recurring use require agreement.

The agent checks available tools and existing tasks before proposing setup. It offers help with [Pi Scheduler](https://pi.dev/packages/@jl1990/pi-scheduler?name=pi-scheduler), [pi-extended-teams](https://github.com/dantetekanem/pi-extended-teams), or [pi-voice-shortcut](https://github.com/dantetekanem/pi-voice-shortcut) when needed. Voice onboarding recommends transcript-only input for review before sending. Installs and configuration changes require approval, followed by `/reload` and an availability check; typing and direct collection remain options.

With approval, the agent creates missing artifacts and populates `~/.companion-schedules.md`, `~/.companion-notes/onboarding.md`, and task notes from confirmed answers. A new `~/.companion-reports-updates.md` gets a heading and purpose, not a sample report. Existing content is preserved, and returning users resume instead of repeating the interview.

The first proposed schedule is a weekly morning Companion review: the same instructions as `/companion review`, using approved prior context and notes to assess schedules, propose worthwhile improvements, and preserve continuity. The user confirms its day, time, timezone, sources, and budget before it is scheduled. Its registry entry references the installed `src/review-prompt.md` by absolute path, and the scheduled prompt asks the agent to read it; a bare slash command is not dispatched by the scheduler. This is an opt-in proposal, not an automatic default; scheduled work requires Pi to be running in its owning session.

## Commands

| Command | Action |
| --- | --- |
| `/companion` | Start Companion (equivalent to `/companion start`) |
| `/companion start` | Resume Companion-paused schedules, then send the bundled Companion instructions |
| `/companion stop` | Stop this session's approved recurring Companion schedules |
| `/companion review` | Review current schedules and Companion's usefulness; propose improvements if warranted |

Review sends the bundled `src/review-prompt.md` and `taste.md` instructions to the agent. It does not start Companion or control schedules. The prompt directs useful findings to the same append-only reports file, leaves existing Herdr tail panes alone, and requires approval before applying any operational proposal. Supported descriptive taste updates are saved under the taste instructions. No worthwhile change is a valid result.

Every start reads `src/prompt.md` and the package's root `taste.md` and sends both directly to the agent, including returning starts. It resumes only unchanged, still-approved schedules stopped by Companion; with no saved pause receipts, it does not require schedule control. Stop preserves history, the schedule-count footer, and schedule-control receipts. A firing delivery finishes without being aborted; Companion then disables its next recurrence. Unfinished stop requests resume in the same session after reloads.

`~/.companion-schedules.md` is the source of truth for recurring tasks, cadence, timezone, checklists, and referenced working instructions. The agent reads it each run and uses relevant `~/.companion-notes/` as the previous-run baseline. A missing baseline means a first run, not a setup blocker. Task-specific content stays in the registry rather than the extension.

Schedule control requires the existing `@jl1990/pi-scheduler` package. A task must belong to the exact current session (`scope: session`), recur, and have a name exactly matching a `##` heading in `~/.companion-schedules.md`. Other sessions, cwd/global tasks, one-shot tasks, canceled work, and unrelated names are excluded. The extension blocks identifiable Companion `schedule_task` calls when they use another scope. Direct scheduler slash commands and tasks without a registry-matching name remain outside that gate.

Companion uses the scheduler's commands and confirms their saved state. The extension does not create schedules or change recurrence expressions; the agent reconciles tasks from the registry. Startup instructions also tell the agent to update existing current-session Companion task prompts with the append-only destination. Start follows the scheduler's next-run calculation, resets interval timing, and does not backfill missed checks. Manually canceled, edited, or subsequently disabled tasks are not resumed. If a command cannot be confirmed, inspect `/schedules all`.

## Continuity on returning starts

When schedules or prior notes exist, startup instructions tell the agent to load durable onboarding context and taste, then build a compact in-context map of note paths and topics. Daily details and full histories stay in their files until a conversation or task needs them. Existing notes prevent repeated onboarding; knowing where evidence lives does not count as reading it or completing a fresh check. This is agent-directed retrieval, not a new index file or automatic import.

## Taste memory

The agent maintains learned interests, likes, dislikes, and preferences in `~/.companion-notes/taste.md`. The package's `taste.md` is the maintenance prompt, not the personal profile. It applies throughout onboarding, ordinary conversation, requests, corrections, feedback, reviews, and scheduled work. Start loads instructions; supported new evidence triggers updates. Relevant preferences inform responses, and current requests take precedence.

Startup instructions direct the agent to include the installed taste prompt's absolute path in current-session Companion task prompts so independent runs read it too. Review injects it directly. No separate taste schedule or history scan is created. Routine maintenance stays out of reports. Profile reads, evidence assessment, and saves are agent responsibilities, not an automatic extractor or file watcher.

### Research basis

These sources inform the taste design; they do not validate this exact prompt.

- [PRELUDE/CIPHER: Aligning LLM Agents by Learning Latent Preference from User Edits](https://www.microsoft.com/en-us/research/publication/aligning-llm-agents-by-learning-latent-preference-from-user-edits/) investigates readable, context-dependent preferences inferred from edits. Its evaluation uses simulated users for writing tasks, not unrestricted real-world taste learning.
- [LongMemEval](https://xiaowu0162.github.io/long-mem-eval/) evaluates knowledge updates, temporal reasoning, and abstention, among other memory abilities. Its findings also warn that compressing conversations into isolated facts can lose useful context.
- [LangGraph memory overview](https://docs.langchain.com/oss/python/langgraph/memory) describes profiles and collections of memories, including update errors, information loss, and retrieval trade-offs.

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
