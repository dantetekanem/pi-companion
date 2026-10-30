# Companion CLI architecture

Companion owns a persistent Pi conversation and a scheduler. Pi handles model turns, tools, extensions, compaction and conversation history. Pi Durable records dispatch and lifecycle state separately. The CLI does not attach to another Pi pane or share a live session file.

## Execution

The main conversation uses Pi's SDK and SessionManager. It loads ordinary tools, configured extensions, project resources, codemode, tool search and MCP. Startup binds extensions without a model request; reset and shutdown close their lifecycle.

Background checks use separate Pi RPC sessions and verify each schedule's model/effort before submission. Anthropic/Claude models work through Pi. The CLI has no Claude executable or Teams-specific integration.

Checks receive their instructions, named context files and a limited previous outcome rather than the main transcript. Context files must be regular files within the working directory, at most 32 KiB each. The complete supplied context is limited to 64 KiB. This preload rule is not a sandbox: Pi tools retain their configured access.

Companion reserves each dispatch before work starts and saves its result before reporting completion. After a crash, a dispatch without a conclusive result becomes interrupted rather than replaying automatically. Cancellation terminates and reaps owned children. Jobs have no automatic execution deadline.

## State and reports

Under the workspace root, `runtime/companion.sqlite` stores dispatch receipts, `runtime/usage.json` stores usage, and `reports/` holds new Markdown reports. Listings also include imported history and runtime records. Pi owns conversation files.

Reports retain output alongside execution errors without a JSON envelope or tracking comments. Model completion does not establish successful collection, reading or usefulness.

Only one dashboard, headless runner or pattern-review submission can own a workspace. SIGINT/SIGTERM stops owned work. A stale lock may take five minutes to expire after an unclean exit. SQLite WAL with `synchronous=NORMAL` protects against process crashes, not all power failures, and cannot guarantee exactly-once external effects. Storage contract: https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/README.md#storage

## Schedules

The [schedule guide](../src/prompts/schedule-setup.md) defines JSON-frontmatter files and local-calendar timing. The runner reloads files before admission and dispatch. Invalid definitions, duplicate IDs and explicit non-Pi bindings produce errors rather than using cached authority or rewriting history.

Stable occurrence IDs prevent duplicate dispatch. Missed dates are not replayed. Imported intervals and irregular cron retain their original semantics through the compatibility adapter.

## Terminal

Pi TUI uses the alternate screen and restores the terminal on exit. Cached state renders before connection. External text is width-wrapped and stripped of terminal controls; tiny terminals get a resize hint.

Navigation preserves drafts, selection and scroll position. Rejected sends retain drafts; interrupted sends are not retried. Themes follow Pi settings and custom files, with Dracula as the fallback for package-only themes.

Live output carries public Pi text and tool results. Custom child renderers, images and reconnect replay are not guaranteed. Plain status reads a snapshot without starting work; `run` starts a foreground headless runner.

## Migration

The [upgrade guide](upgrade.md) covers commands and journal phases. Migration preserves selected session stores, notes, registry, reports, scheduler records and Durable checkpoints with their provenance, providers, stops and pending questions. Restart resumes the same journal. Source drift, uncertain attempts or missing shutdown evidence block activation.

Cutover has five parts:

1. Fence legacy startup and reinforcement, and drain admitted work before writing shutdown receipts. Older owners need explicit offline confirmation.
2. Preserve source bytes and saved-session identities. Inspect Durable through a working copy without starting its task harness; retain original database and WAL files.
3. Compare selected raw scheduler records under its compatible lock before disabling them. Preserve unrelated tasks and unknown metadata. Before/after hashes reconcile writes interrupted before receipt persistence.
4. Validate every origin and schedule while retaining disabled, cancelled and stopped states. First occurrences follow cutover without catch-up.
5. Activate the destination only with a matching verified journal. Mutable working configuration stays separate from migration evidence; the active pointer alone is insufficient.

The adapter uses installed scheduler 0.5.1/Croner 10.0.1 helpers. Its raw `tasks.json` lock uses `realpath: false`, a 10-second stale period and a 2-second update. The scheduler's normalizer can drop unknown records, so migration reads and preserves raw data.

Optional model repair proposes changes to staging, never originals. Exact source/provider consent, recorded attempts, proposal review and ordinary validation remain required. Interrupted attempts are not repeated automatically.

## Usage and learning

Usage adds deltas from cumulative Pi observations per session. Adopted sessions start from existing totals; receipts and nested costs are deduplicated. Missing or conflicting observations stay recorded internally. Imported Claude estimates remain historical; Anthropic models through Pi produce Pi usage.

`/reset` changes the displayed-spend baseline without deleting history. Estimates include turns, checks and migration repairs, not provider invoices or spending guarantees. Context figures and automatic compaction come from Pi.

Optional pattern review sends only previewed excerpts from explicitly selected sessions to the chosen Pi model. It proposes schedules without enabling them. Reflection records one attempt per UTC day and proposes changes with evidence and success signals. Historical content is evidence rather than instructions; explicit stops and existing permissions govern changes. Silence is not negative feedback.

## Development

The CLI uses ESM `.mjs`, Node 22.19+, Pi SDK/TUI 1.4.0 and Durable 1.1.0. The legacy extension remains TypeScript.

Tests use temporary roots, synthetic histories, fake provider boundaries and real Durable/SessionManager. Migration compatibility checks need `COMPANION_TEST_SCHEDULER` set to an installed scheduler package; otherwise those cases skip. Use the package's `test`, `test:cli` and `test:migration` scripts for their respective areas.

Terminal checks cover 120×40, 80×24 and 60×18 layouts, input, scrolling, resize and clean shutdown. Source and fixture checks do not establish live-provider permissions, billing or collection success.
