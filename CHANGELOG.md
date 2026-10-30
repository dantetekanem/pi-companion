# Changelog

## Unreleased

- Add Companion-only memory: a short list in `memory.md` that the agent maintains. Chat sees it on every turn; scheduled checks can read it but not change it.
- Give each check a `memory.md` it maintains and a Companion-written `log.md` under `checks/<id>/`, both supplied to every run, so checks stop rediscovering their tools and reconstructing their history from transcripts and the database.
- Add a `Blocked:` report line and stop retrying stuck checks. After two blocked or failed runs in a row, a check is held and tries again after 1, 2, 4, then 7 days. A working run or a schedule edit clears the hold, and manual runs still work.
- Show the next run the newest outcome, including manual runs and failure errors that were previously dropped.
- Keep scheduled checks running until every agent they spawned has reported, so a check no longer finishes with its interim reply as the report.
- Exit as soon as Companion has closed, so a leftover connection cannot delay quitting.
- Separate report notices in Chat with a blank line.

## 0.1.6 - 2026-10-29

- Add `pi-companion reports` to list reports and `pi-companion reports delete ID...` to remove selected reports.
- Refresh the live dashboard after deletion and keep deleted reports out of saved and imported listings. Preserve run receipts so deletion does not replay completed checks.

## 0.1.5 - 2026-10-29

- Add the standalone `pi-companion` CLI with persistent chat, Markdown reports, live job tabs and Pi themes.
- Define daily, weekly and monthly checks in editable Markdown files. Run them through Pi with configured tools, extensions and MCP servers.
- Show running checks and their output; use `k` to cancel a selected job. Jobs have no automatic execution deadline.
- Add resumable migration from the Pi extension, preserving saved conversations, schedules, history and paused states.
- Make `/reset` start a fresh conversation and zero the displayed cost estimate without deleting history or stopping background checks.
- Fix concurrent legacy-owner startup and retry after scheduler setup failures.
- Shorten the README, guides and agent prompts; add the CLI screenshot and migration instructions for users and agents.

## 0.1.4 - 2026-09-11

- Save Companion's Herdr pane and workspace to a temporary location file on start.
- Automatically inject that location and `tail.md` into new Pi sessions, without agent-led discovery or schedule lookup.

## 0.1.3 - 2026-09-11

- Inject taste-maintenance instructions with every Companion start and review; maintain learned preferences in `~/.companion-notes/taste.md` throughout conversations and approved scheduled work.
- Restore durable context and a lightweight map of notes on returning starts, retrieving daily details only when needed.
- Shorten the prompts while preserving source permissions, evidence rules, and report safeguards; keep research references in the README.

## 0.1.2 - 2026-09-11

- Guide first-start onboarding through routines, goals, habits, approved sources, and optional voice, scheduler, and subagent setup.
- Add `/companion review` and propose an opt-in weekly review using the same bundled instructions.
- Ask questions in ordinary chat and leave unanswered requests pending. Account for corrected context and stop repeated collection failures within a run.
- Append useful review findings to the existing reports file without disturbing Herdr tail panes.

## 0.1.1 - 2026-09-11

- Direct the agent to append important updates and reports to `~/.companion-reports-updates.md`, with stable publication IDs and duplicate checks.
- Offer an optional, user-approved Herdr pane to follow the reports file on first startup.
- Remove `companion_save` and the updates/reports views. Preserve existing saved results and session-scoped schedule controls.
- Replace lookaround expressions in result validation with OpenAI-compatible schema patterns.
