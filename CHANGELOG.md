# Changelog

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
