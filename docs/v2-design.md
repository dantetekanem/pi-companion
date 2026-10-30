# Companion v2 design

## Decisions

The user chose a standalone CLI that owns and restores its own main Pi conversation. It does not attach to the existing Companion pane or share a live session file. Pi remains responsible for model turns, tools, extensions, compaction and conversation history. Pi Durable checkpoints Companion dispatch and lifecycle state separately.

The current Durable change is published as `7a8d516` on main. The package version remains `0.1.4`; v2 work does not authorize another push or a release.

Upgrading must carry forward all Companion-owned state once. The legacy inventory is complete at the source/metadata level. The user requires every schedule to migrate: partial imports, skipped schedules or permanently pending conversions do not count as success. Agent repair is permitted for migration errors, but ordinary setup remains model-free. A new installation must not overwrite, adopt or reconstruct an existing installation by guessing.

## Terminal experience

Use the installed Pi TUI directly in a separate Node process. Reports take most of the screen. A compact header shows the view tabs with report and schedule counts, plus connection state; a bottom status bar shows the main Pi model/effort, context usage, and estimated USD cost since initialization or the last `/reset`. Accounting diagnostics stay internal rather than appearing as dashboard counters.

Chat and reports use the full reading width without a side bar. The header and footer carry connection and schedule status. Smaller terminals lose decoration rather than errors or send status. An extremely small terminal gets a finite resize hint. Use width-aware wrapping for Unicode and strip terminal controls from external content.

Keep the composer visible. Report navigation and conversation reading are separate views; sending a message makes the reply easy to find without turning every ordinary conversation turn into a published report. Tab changes focus; arrow keys and PageUp/PageDown navigate the focused list/body; slash enters the composer; Escape leaves it without erasing the draft. Editor shortcuts own input while typing. Failed sends retain the draft; accepted-but-interrupted sends are shown as uncertain and are not silently retried. Help shows the available keys.

Plain mode, also used when output is not a terminal, returns one ANSI-free local snapshot and exits. It never starts a model or background scheduler. A headless runner is an explicit separate command for an external supervisor; Companion does not install a service. Only one runner can own a data root at a time.

Render cached local state before initializing the model runtime. Network work and subprocess output must not block typing. Coalesce state updates; do not scan histories or rerender every frame. Preserve the selected report and scroll position across refreshes. Measure cold first paint, input response, and resize with an offline PTY before describing the CLI as fast.

## Schedule files

Use one editable Markdown file per schedule under `schedules/daily`, `schedules/weekly`, or `schedules/monthly`. A strict JSON metadata block carries machine settings; the body contains short instructions. JSON avoids adding a YAML parser and is easy to validate without a model. The folder determines recurrence. Files carry stable IDs, a local time, an IANA timezone, weekly weekday or monthly day when needed, enabled state, the Pi harness and model/effort binding, working directory, and explicit context/source references.

Initialization creates these folders and short instructions without submitting a model turn. Examples start disabled. Validation reports a broken file by path; a malformed or changed definition cannot acquire authority from an earlier cached version. An old schedule still bound to the native Claude harness remains on disk with a per-file parse error and is excluded from execution. Saved config and history remain readable. No agent is needed to register a valid enabled file.

Recurrence uses local calendar dates, not a fixed 24-hour interval. A repeated local time during a daylight-saving transition is one occurrence; a nonexistent time is not guessed. A monthly day absent from a month is skipped. Stable occurrence IDs prevent repeat dispatch. Missed periods do not cause an unbounded catch-up burst. Migration must preserve original cadence semantics through an explicit compatibility representation where calendar shorthand is insufficient, including intervals, one-time work and irregular cron. Folder placement must not reinterpret timing. Conversion errors block cutover; a bounded repair agent may propose a staged correction, which must pass the same checks before migration continues.

## Runtime and execution boundaries

The main Pi session uses the supported installed SDK with an explicit SessionManager and a Companion-owned session path. The configured Pi environment supplies ordinary tools and context for the user's direct messages. Startup and initialization do not issue a model request.

Background jobs run in ordinary Pi sessions with per-job identities and the schedule's Pi model/effort binding. They receive the schedule instructions, named context files and a bounded previous outcome, not the main transcript. Live public output uses Pi's native SDK/RPC stream as plain Markdown; child-specific renderers and replay after reconnect are not guaranteed. Cancellation aborts owned Pi work. Companion imposes no execution deadline, fixed report contract or read-only tool gate; the configured Pi environment determines available tools. Anthropic/Claude models remain available through Pi, but the CLI does not invoke a Claude executable. This is not an OS sandbox.

Reserve a stable dispatch in durable storage before a model/tool-producing action. Save receipts and results before reporting completion. After a crash, an admitted dispatch without a conclusive receipt is interrupted/unknown, not eligible for automatic replay. Cancellation must terminate and reap owned children, not merely stop awaiting them. Do not promise exactly-once external effects or power-loss durability from SQLite WAL with synchronous NORMAL.

## Reports, context and improvement

Reports render inside the CLI. Publication attribution stays in private runtime records; user-facing text contains no Companion tracking comments. A result distinguishes findings, no change, failed, incomplete and not run. Completed work, delivered reports, user reading and usefulness are different facts. No-news runs may save their outcome without publishing a noisy report.

The initial session-review prompt can review only explicitly selected Pi or Claude JSONL sources, dates and exclusions. Submission always uses a selected model/effort through Pi; this can be an Anthropic/Claude model supported by Pi. Declining it still leaves a usable CLI. Extract dated user requests and observed workflow evidence, not entire tool transcripts. Surface frequent manual requests, known underused workflows, and daily/weekly/monthly repetitions as automation candidates. Counts describe inspected coverage; lack of evidence is not proof that a workflow is unused. Repetition does not authorize access or actions.

Taste and learning use relevant bounded notes with provenance. Historical messages, tool output and imported reports are data, not new instructions. Reflection proposes reversible changes with a benefit and an observable success signal; the runtime/user's permission contract decides what may be applied. Explicit stops override learning and silence is not rejection.

## One-time upgrade

The legacy sources are eight origin-hashed v1 session stores, historical owner.json, an optional Durable lifecycle database (absent during inventory), raw pi-scheduler 0.5.1 storage, the free-form schedule registry, 727 note files in 14 directories, and the append-only report feed. Pi conversation references and the external review-model binding are distinct from Companion-owned content. Actual private bodies have not been read or validated during design.

The initializer detects legacy state before starting v2 execution. It uses one stable migration identity and a private journal: inventory, staged, fencing, fenced, committed, verified. Every source is enumerated and hashed. Origin namespaces preserve overlapping IDs, provider links, read flags, explicit stops and pending questions. Preserve registry/notes/feed bytes in a private import area without treating imported prose as new instructions. Pi keeps ownership of its session format; select and validate the saved main identity rather than infer it from a hash or pane hint.

Stage and verify the destination before cutover. Source drift or a crash resumes the same journal, never a second import. Preserve originals. The scheduler adapter must use raw records and its compatible lock: the installed scheduler normalizer can drop unknown records and is not a lossless migration reader. Compare exact attributed task records under lock; never disable unrelated same-name tasks. Record each disable intent and receipt. An old running attempt, ambiguous external effect or unproven owner quiescence blocks activation.

Old extension startup must honor a migration fence, and an already running pre-fence version must be stopped before cutover. Disabling task records alone cannot establish exclusive ownership. All schedule conversions, source counts/hashes and references must validate before activating v2; first occurrences are after cutover without missed-run catch-up. Disabled/cancelled/stopped work retains its original state.

A repair agent receives only a failed item's permitted evidence and diagnostics. It can propose changes to staging, not originals, permissions or the completion checks. Bound attempts, persist the repair/result identity and record unknown costs. Revalidate after each repair. An unresolved error remains an incomplete upgrade, never an accepted partial migration or an automatic repeat of uncertain actions. This is recovery support, not a claim that migration cannot fail.

After verification, a committed migration marker makes later starts skip migration. The UI keeps all imported origins and history reachable, while old opaque report markers remain confined to preserved history. New reports never include them. End-to-end fixtures must prove every schedule migrates, interrupted cutover does not produce two executors, and repeated startup does not reimport or rerun work.

### Cutover implementation boundaries

Cutover is split into five independently checked pieces: legacy entry-point fencing and shutdown receipts; storage-only checkpoint inspection and saved-session copies; raw scheduler compare-and-swap; verified v2 admission; and the journal coordinator. The UI/history task depends on the coordinator, not merely on the presence of a fence file.

The installed scheduler locks the raw `tasks.json` path with `realpath: false`, a 10-second stale limit and a 2-second update. Its writer reconstructs the top-level object, so Companion must use the same lock but preserve raw unknown metadata and unrelated tasks itself. Compare all selected records before the first write; retain exact before/after hashes to recover a completed write whose receipt was interrupted.

A fence must cover reinforcement hooks as well as `/companion start`; reinforcement registers input, tool-result, settled and record handlers before the command handlers. Owner registrations and shutdown receipts belong outside the archived source tree. Shutdown drains admitted work before issuing a receipt. Missing registrations from older versions do not prove those owners stopped: the eventual offline upgrade needs explicit trusted-host confirmation for pre-protocol owners. A saved pane location is never that confirmation.

Inspect a working copy of an optional Durable database through storage APIs, which materialize document revisions without starting the task harness. Preserve the original database and WAL bytes. A terminal lifecycle's `active` flag expresses desired enabled state, not process liveness; pending control or requested setup remains a blocker. Session adoption preserves exact Pi identities and starts cost accounting from their existing cumulative totals.

The active pointer is insufficient by itself: the matching journal must be verified before v2 admission. Mutable working config and conversations are distinct from immutable migration evidence. No part of this protocol will be invoked on current user data during development.

## Cost accounting

Persist the initialization timestamp and per-source accounting identity. Pi session statistics include historical and compacted/branched usage, so adoption needs an initial baseline for that exact session. Switching sessions creates a separate segment. Fresh job sessions have their own receipts.

Pi session statistics provide cumulative cost observations for current conversations and checks. Store the last accepted observation per Pi session and add only its delta; deduplicate receipts across reloads and do not count nested cost twice. Mark missing or aborted results as unknown coverage. Imported historical Claude cost records remain readable and separate from current Pi usage. A Claude model selected through Pi is accounted as a Pi session; the CLI does not invoke a Claude executable or add new Claude CLI receipts. Display client estimates as estimates, not provider invoices or subscription spending. Durable-owned usage, when present, is a distinct source from Pi session estimates.

## Compatibility evidence

This checkout targets coding-agent and TUI 1.4.0, with Durable 1.1.0. The main session loads Pi's built-in codemode, tool search and MCP extensions alongside configured extensions, then binds their lifecycle through the supported SDK. Startup, cancellation during preflight, reset and shutdown are checked against the installed SDK rather than inferred from another Pi host.

New CLI modules will be plain ESM `.mjs` so the installed executable does not depend on Node stripping TypeScript from node_modules or an undeclared transpiler. Existing extension TypeScript stays in place. Reuse installed Pi TUI; avoid adding React or changing the supported Node runtime for a second UI framework.

## Research sources

- [Pi TUI exports](https://github.com/earendil-works/pi/blob/main/packages/tui/src/index.ts), initially checked against 0.85.1; current integration uses the installed 1.4.0 API.
- [Lazygit configuration](https://raw.githubusercontent.com/jesseduffield/lazygit/master/docs/Config.md): focus indicators, panel navigation and contextual key help.
- [Ink README](https://raw.githubusercontent.com/vadimdemedes/ink/master/readme.md): a viable React approach, but adds a framework absent here; master documents upcoming behavior.
- [OpenTUI core](https://raw.githubusercontent.com/anomalyco/opentui/main/packages/core/README.md): current runtime/native requirements do not fit this package's Node 22.19 baseline without changing distribution.
- [Bubble Tea](https://raw.githubusercontent.com/charmbracelet/bubbletea/main/README.md): state/update/view and alternate-screen reference, not a Node dependency choice.
- Installed Pi 1.4.0 SDK, SessionManager, AgentSession and RPC declarations/docs: session ownership, extension lifecycle and statistics contracts.
- Installed Pi Durable 1.1.0 README and Harness/task/tool declarations: separate runtime, phase checkpoints, explicit replay policy and storage limitations.

## Verification and delivery limits

TDD applies to executable behavior. Use the existing Node test runner with temporary roots, synthetic session histories, fake harness processes and real installed Durable SQLite. Inspect prompt text directly rather than asserting its wording in tests. Verify schedule validation/due times, source boundaries, concurrency, restart/uncertain dispatch, cancellation, usage deduplication, migration recovery and report rendering.

Exercise 120×40, 80×24 and 60×18 terminal layouts, focus, paste, Unicode, resize, disconnected and failed states, plain output and first paint without provider access. Package smoke tests must exercise the actual executable layout. Independent review focuses on migration/cutover, subprocess/context boundaries, durable dispatch and cost honesty. Mock tests cannot establish live-provider permissions or actual billing.

No live user migration, backup, service operation, package install, provider run, v2 publication or release is part of current verification without the corresponding authorization.
