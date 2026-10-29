# Pi Companion

A terminal workspace for recurring checks and a persistent Pi conversation. Reports stay on screen, the composer stays available while checks run, and schedules are ordinary files. Background checks can use Pi or Claude. The main conversation uses Pi; Pi Durable stores dispatch and ownership receipts separately from its transcript.

This checkout contains the v2 implementation at package version **0.1.4**. It has not been released as a new version. Existing data is never migrated by startup, listing or plain output. Use the [explicit one-time upgrade workflow](docs/upgrade.md) when ready.

## Start

Requires Node 22.19 or newer, Pi credentials, and the package dependencies. The SDK/TUI integration targets **0.85.1**, with Pi Durable **1.1.0**. A newer Pi host is not evidence that its SDK is compatible. Claude jobs also require the `claude` executable; Pi jobs require `pi` on PATH.

Once the command is installed on PATH, launch it from any directory:

```sh
pi-companion
```

First launch creates a private `~/.companion` workspace with `config.json` and empty `schedules/{daily,weekly,monthly}` folders, then connects the Pi runtime. No setup command or path flag is needed. Initialization does not ask an agent to configure anything, enable a check, or submit a model turn. Later launches reuse the workspace. An incomplete upgrade still blocks startup.

The existing Pi extension and `/companion` remain independent. A fresh CLI workspace does not import old data, disable old schedules or fence the extension. Migration requires the explicit upgrade workflow. Finite status/list commands never initialize a workspace or start work.

Edit `config.json` to select the main Pi model/effort and display the preferred background binding. Each schedule has its own explicit binding; changing the background preference does not rewrite schedules. Pi models use `provider/model`; `null` permits the harness's configured default. Keep the generated initialization timestamp unchanged because it defines the accounting and scheduling boundary.

The main Pi session uses ordinary project resources and tools, but extension discovery is disabled to avoid starting another scheduler or Companion owner. The CLI does not expose all Pi TUI slash commands or extension UI. It reopens the saved main identity; `/reset` starts a fresh persisted identity while retaining the previous transcript. It never silently replaces a missing adopted session.

## Schedule files

Put a Markdown file in the appropriate recurrence folder. [The short setup guide](src/prompts/schedule-setup.md) is also copied to `schedules/README.md` by initialization.

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

For multiple checks per day, use `"at": ["09:00", "12:00", "18:00"]` in the same file (1 to 48 unique times). This remains one schedule. After downtime, only the latest due time today is eligible. An authorized agent can edit these settings directly; no scheduler development or separate setup step is required. Paused routines stay paused unless enabling them is requested.

For an hourly check between 08:00 and 17:00, replace `at` with:
```json
"window": { "start": "08:00", "end": "17:00", "everyMinutes": 60 }
```
This is one schedule with ten checks, not ten files. The interval starts at `start`; `end` is included only if it lands on that interval. Both times use the schedule's timezone on the same day; overnight windows are rejected. `everyMinutes` is an integer from 1 to 1440, with at most 48 checks per day. Use either `at` or `window`, never both. After downtime, only the latest due check inside the window is eligible; nothing starts after its end minute.

Choose real paths and an available model, then enable the file. Weekly files also need `weekday` (0 is Sunday); monthly files need `day` (1 to 31). Missing monthly dates and nonexistent daylight-saving times are skipped. Repeated local times run once. Native calendar schedules can run later on the same local date but never catch up previous dates or occurrences before initialization.

`pi-companion schedules` reports malformed files and duplicate IDs. The runner reloads definitions before admission and dispatch. Context includes only named regular files within the real working directory, a bounded previous outcome and the schedule instructions. A file is limited to 32 KiB and the complete context to 64 KiB. These restrictions are not an OS sandbox: permitted harness tools can read other accessible files. Do not use a schedule as an isolation boundary for hostile code or secrets.

## Terminal runtime and background process

With a TTY, `pi-companion` opens the running harness with reports and a message input in the terminal. It paints a saved local view before connecting Pi. Chat opens with the input ready. The header shows the main binding, effort, schedule count, estimated spend and context usage. Schedules shows local times such as `09:00 ET`, rounded next-run estimates, and live background jobs with their harness/model/effort, directory, start time and elapsed time. Its running count is live only while connected; saved receipts are not treated as running. The footer names the next check. Reports show relative age and fixed local date/time with a timezone, including in the full-width Markdown reader. Imported timestamps stay unchanged; missing or invalid times are omitted.

- Type a message and press Enter. In Chat, Left/Right cycles Chat, Reports and Schedules when the draft is empty; with draft text, they move the editor cursor. In Reports or Schedules, Left/Right continues cycling views.
- Pi's editor supports Ctrl+A/E, Alt+Left/Right, Ctrl+W/U/K, Ctrl+Y, Ctrl+- undo, Ctrl+J or Shift+Enter for a new line, and Up for prompt history. Namespaced `tui.editor.*`, `tui.input.*` and `tui.select.*` bindings load from Pi's `keybindings.json`; application actions and legacy binding aliases are not imported.
- `/clear` hides the current visible chat across restarts without deleting history or resetting model context. `/reset` starts a fresh main context without a model turn. It keeps the previous transcript and cumulative usage, and cancels only main work and queued steering; background work and schedules continue. Unknown commands stay local instead of becoming model prompts.
- Agent questions can show selectable answers: Up/Down chooses, Enter answers, Escape cancels. Your draft stays intact. Headless mode returns unavailable instead of waiting for an answer. The selected answer is returned to the same tool call, not sent as a second turn.
- User and assistant headings have different colors. Empty assistant entries are hidden; the footer shows Thinking while the main turn runs.
- In Reports, arrow keys select; Enter opens one; Escape returns to the list.
- Page Up/Down or the mouse wheel scroll the reading area; Chat starts at the latest message. Scrolling over the composer leaves its text alone.
- Escape returns from report detail to the list, or from a tab to Chat, preserving the draft.
- Invalid schedules appear in Schedules; scroll to read their errors.
- Ctrl+C quits.

Ask the main agent to run a configured check now. It can list native schedules and trigger one exact ID with the existing instructions and binding, even while recurrence is paused. This does not enable the schedule or change its timing. The tool returns an admission receipt; the result appears in Reports when the check finishes, including when nothing changed.

An accepted message is not a completed model turn. Rejected sends retain the draft; accepted or interrupted work is never automatically retried. Invalid model reports remain incomplete, and ordinary calendar no-change checks stay quiet. Reports use private receipt IDs rather than visible tracking comments.

`pi-companion run` runs without a TUI in the current process. An external supervisor may manage it; Companion does not install a daemon, detach itself or configure a service. SIGINT/SIGTERM stop owned work and release the owner lock. Only one dashboard, headless runner or review submission may own a home at a time. After an unclean exit, a stale lock can take up to five minutes to expire. Never remove a live owner's lock.

`pi-companion status --plain`, `pi-companion schedules`, and non-TTY status are finite local reads. They neither start providers nor run schedules. Saved status is labeled as a snapshot, not a liveness check. `pi-companion history` prints imported provenance and local archive paths.

## Costs, context and recovery

`runtime/companion.sqlite` stores Durable dispatch receipts; Pi owns the conversation files. An unfinished dispatch is marked interrupted on reopen, not replayed. SQLite checkpoints protect against process crashes, not every power failure. See [Durable's storage contract](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/README.md#storage).

The header shows SDK-estimated context tokens/limit (for example, `52.6k/272k`), a rounded whole percentage, auto-compaction setting and completed compactions on this conversation branch. Inapplicable metadata is omitted, including tokens immediately after compaction until new provider usage arrives. Pi retains its configured automatic compaction; Companion does not change that setting. The harness handles compaction automatically; the footer shows `Compacting…` while it runs. Closing prevents late submission but may wait for pending authentication to settle.

`runtime/usage.json` tracks per-session cumulative cost deltas, exact baselines and receipt IDs. Imported historical estimates remain separate. New Pi/Claude checks, conversation turns and migration repair attempts are included from initialization. Missing or conflicting observations retain specific receipt reasons. Amounts are client estimates, not invoices or subscription charges; receipt reasons and pending work are displayed. Companion imposes no automatic job execution timeout; use `k` to cancel scheduled work in the dashboard. Headless runs and pattern submissions accept SIGINT/SIGTERM cancellation. Legacy daily reviews can be cancelled with `/companion stop`; migration repairs have no dashboard `k` control. Provider limits and output bounds still apply and are not spending caps.

Pi background checks use RPC and verify the returned model/thinking binding before submitting the prompt. Claude uses structured print output, an exact session ID and restrictive CLI settings. The installed Claude 2.1.311 help and synthetic process protocol were checked; live provider behavior, effective Claude effort and newer CLI compatibility still need operational verification. Neither harness is an OS sandbox.

Imported daily reflection preserves the original same-provider review binding, records one attempt per UTC day and produces proposals without enabling schedules. New direct messages and run outcomes retain provider attribution. Silence and delivery are not feedback. Historical archives are never automatically injected into a model.

## Find repeated work

The optional [session-pattern review guide](src/prompts/session-patterns-setup.md) describes the consent and selection format. Select exact Pi/Claude JSONL files, dates, exclusions and destination in a local JSON file:

```sh
pi-companion patterns-preview --selection /absolute/selection.json
pi-companion patterns-submit --preview HASH --confirm HASH
```

Preview is local. Submission requires the exact reviewed hash, unchanged source pins and an idle home. It sends bounded user-role excerpts and tool names with tools disabled, then saves a report of daily/weekly/monthly proposals. It does not discover private histories, assume unused workflows, or create schedules. Read the linked guide before submitting.

## Legacy extension and verification

The package still registers `src/index.ts` for existing `/companion` users. Its commands, feed and learning behavior are documented [separately](docs/legacy.md). The v2 upgrade preserves every selected origin and owned schedule, including irregular legacy actions, using pinned scheduler 0.5.1/Croner 10.0.1 helpers. Compatibility routines retain their explicit stops and saved conversation bindings; uncertain attempts require reconciliation.

Tests use temporary roots, real Durable/SessionManager and fake provider boundaries. Migration compatibility tests require an existing scheduler installation; they skip those cases when `COMPANION_TEST_SCHEDULER` is absent. Set it to the absolute package directory for complete compatibility evidence. No test needs private histories, live scheduled commands or paid provider calls. Packaging, tests and local development do not authorize a real migration or release.
