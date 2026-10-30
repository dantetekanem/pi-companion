# Update or migrate Companion

## Choose your path

- Already running the standalone `pi-companion` CLI? Update the code and reopen the same workspace. Do not run the legacy migration again.
- Moving from `/companion` inside a Pi session? Follow the one-time migration below to import its saved conversations, schedules, notes and reports.

If a migration is unfinished, keep its destination and journal and continue at [Apply or resume](#3-apply-or-resume).

The CLI uses `--home` when supplied, otherwise `COMPANION_HOME`, otherwise `~/.companion`. Set the workspace once for the commands in this guide:

```sh
companion_home="${COMPANION_HOME:-$HOME/.companion}"
```

If you use a custom workspace, set `companion_home` to that same absolute path. Keep passing `--home "$companion_home"` on later launches too, unless `COMPANION_HOME` already points there. Use the workspace root, not its internal activated data directory.

## Already using the CLI

1. Close the CLI with Ctrl+C, or stop its headless runner through the supervisor you use.
2. Update the same package installation or checkout that provides your `pi-companion` command. If it already points to the updated checkout, reopening is enough. Keep the workspace, configuration, schedules, history and usage records in place.
3. Check the saved workspace, then reopen it:

```sh
pi-companion status --plain --home "$companion_home"
pi-companion schedules --home "$companion_home"
pi-companion --home "$companion_home"
```

The first two commands are local reads; opening the dashboard starts its runner. Reopening does not reimport history or reset the workspace. Resolve any reported configuration errors rather than initializing a replacement home.

## Legacy Pi extension: before planning

Migration can copy private histories and change old scheduler records. Installing the package, opening the dashboard, listing schedules and plain output never start it.

Close the old owning Pi process and let its admitted work finish or cancel. `/companion stop` also pauses routines; use it only if you want those pauses preserved in v2. Shutdown can change saved files, so do this before taking source hashes. Do not delete its locks or infer shutdown from a pane name. The CLI does not kill an old process for you.

For a new migration, use an uninitialized destination, normally `~/.companion`. If that workspace is already initialized, choose a different unused absolute path and set `companion_home` to it; do not merge into or replace the existing workspace. Do not run `init` or open the new dashboard before migration finishes. Keep the old Pi session files and installed `@jl1990/pi-scheduler` **0.5.1** with Croner **10.0.1** available. Compatibility schedules use pinned pure helpers from that installation; the CLI does not install or upgrade them.

Choose every saved Pi session corresponding to an existing Companion origin, including stopped origins. Choose one as the main conversation. Historical owner files are provenance, not proof that a process is stopped.

## 1. Inspect a read-only plan

Create a private `selection.json` with this shape, replacing all example paths and bindings:

```json
{
  "sourceHome": "/absolute/old-home",
  "sessionFiles": ["/absolute/saved-session.jsonl"],
  "mainSessionFile": "/absolute/saved-session.jsonl",
  "schedulerPackage": "/absolute/node_modules/@jl1990/pi-scheduler",
  "decisions": [],
  "config": {
    "version": 2,
    "initializedAt": "2026-01-01T00:00:00Z",
    "main": {"cwd": "/original/session/cwd", "model": "provider/model", "effort": "medium"},
    "background": {"harness": "pi", "model": "provider/model", "effort": "medium"},
    "concurrency": 2,
    "legacySessions": {
      "SAVED_SESSION_ID": {"model": "provider/model", "effort": "medium"}
    },
    "legacyReviews": {
      "SAVED_SESSION_ID": {"model": "provider/reviewer", "effort": "high"}
    }
  }
}
```

Companion does not impose an execution timeout. Historical `timeoutMs` metadata may remain in saved configuration and imported records without cutting off execution; originals are preserved. Dashboard scheduled jobs support manual `k` cancellation. Migration repair is not a dashboard job and has no `k` cancellation control.

The main working directory must match the selected saved session. Preserve the original session/review provider and intended binding. Missing saved bindings require an explicit choice; the importer will not guess or disclose a conversation to a different provider. The placeholder initialization date is replaced with the journal creation time when staging.

```sh
pi-companion upgrade-plan --selection /absolute/selection.json --home "$companion_home"
```

This only reads. It returns the source manifest, saved-session pins, engine pins and candidate scheduler metadata. It does not copy sources, start a model or change the old scheduler.

For every task in a mapped session, add a decision to `selection.json`, using its exact candidate hash and mapped origin:

```json
{
  "taskId": "task_example",
  "sha256": "EXACT_TASK_HASH",
  "origin": "session:EXACT_ORIGIN_HASH",
  "classification": "companion",
  "timezone": "America/Sao_Paulo",
  "reason": "This is the approved routine belonging to this saved conversation."
}
```

Use `unrelated` only for work that does not belong to Companion. A matching title is not proof of ownership. A task referenced by a saved pause, stop or daily wake cannot be excluded. Once, interval, cron, shell, notify and message actions remain compatibility records rather than being approximated as calendar schedules. Intervals continue to reschedule from completion; cron preserves the explicit original timezone.

Run planning again with the completed decisions. Save that exact output as private `plan.json`. Inspect the complete plan and its `hash`. If original review settings are needed, select the settings file in `references` with kind `review-settings` and provide its exact `path`, `size`, and `sha256` in `reviewSettings`. The runtime never discovers settings or private sessions on your behalf.

## 2. Prepare private metadata

```sh
pi-companion upgrade-prepare --selection /absolute/plan.json --confirm PLAN_HASH --home "$companion_home"
pi-companion upgrade-status --home "$companion_home"
```

Preparation checks source and engine pins, creates the private journal and saves the reviewed plan. It does not yet copy sources or disable tasks. The response includes the migration ID and source fingerprint. A changed plan cannot replace an existing one implicitly.

## 3. Apply or resume

For owners using the new lease protocol, a stopped receipt must exist for every mapped origin. For older owners, supply a private authorization file attesting that all mapped owners are already offline:

```json
{
  "offline": {
    "confirmed": true,
    "migrationId": "PREPARED_MIGRATION_ID",
    "fingerprint": "PREPARED_SOURCE_FINGERPRINT",
    "confirmedAt": "CURRENT_ISO_TIMESTAMP",
    "sessions": [{"sessionId": "SAVED_SESSION_ID", "sessionFile": "/absolute/saved-session.jsonl"}]
  }
}
```

This is your attestation, not a process probe. A held owner lease still blocks the operation. The session set must match exactly.

```sh
pi-companion upgrade-apply --confirm MIGRATION_ID --selection /absolute/authorization.json --home "$companion_home"
```

Apply installs the legacy startup fence, proves shutdown, stages byte-preserved originals, inspects a disposable copy of any Durable checkpoint, and validates every origin and owned schedule. Only then does it disable selected old records under the scheduler's lock and activate one destination. Unrelated records and unknown metadata survive. The original registry, notes, report feed, state files and mapped sessions remain available with their provenance; only the selected old scheduler records are disabled.

The journal advances through `inventory`, `staged`, `fencing`, `fenced`, `committed`, and `verified`. A failure is not partial success. Leave its files in place, inspect the diagnostics, resolve the reported blocker and repeat the same apply command. Never replace originals, delete the fence or reset the journal to force progress. Source drift requires reconciliation; there is no automatic rollback or discard command.

## 4. Verify and open the migrated workspace

```sh
pi-companion upgrade-status --home "$companion_home"
pi-companion status --plain --home "$companion_home"
pi-companion schedules --home "$companion_home"
pi-companion history --home "$companion_home"
```

Check that upgrade status reports `phase: "verified"`, all expected schedules and paused states are present, and history lists the imported origins and archive paths. These commands do not start providers or run checks.

Then open that same workspace:

```sh
pi-companion --home "$companion_home"
```

Startup resolves its `active.json` to the activated data directory without repeating the upgrade. Open Reports to inspect the imported reports. Repeating apply verifies the activation rather than re-disabling schedules. Historical cost estimates remain separate from v2 spend. An imported schedule is not proof that its next live check has succeeded.

## Agent checklist

- Identify whether this is an existing CLI update, a new legacy migration, or a resume. Record the exact workspace root and use it in every command.
- For a CLI update, preserve that workspace and follow [Already using the CLI](#already-using-the-cli); do not run `upgrade-prepare` or `upgrade-apply`.
- For an authorized legacy migration, identify every saved origin and session, the main conversation, original model/provider bindings, and each task's ownership. Preserve stopped and paused states; do not infer ownership from titles.
- Close the old owner before hashing sources. Run the read-only plan, complete task decisions, and save the exact reviewed plan and hash.
- Prepare using that hash; apply using the returned migration ID and actual shutdown evidence. If interrupted, inspect status and resume the same journal rather than creating another destination.
- Verify the phase, schedules and imported history with the commands above. Report the workspace, what was preserved, any unresolved errors, and whether a live check was actually exercised. Do not report migration verification as live collection success.

## Optional bounded state repair

State JSON errors can be proposed to a no-tools Pi model only with exact source/provider consent. Ownership, schedule attribution, active attempts and uncertain stop state require human decisions. Add a `repair` object to the authorization file only when you intend that provider call:

```json
{
  "sourcePath": "/absolute/old-state.json",
  "maxAttempts": 1,
  "consent": {
    "accepted": true,
    "sourcePath": "/absolute/old-state.json",
    "sourceSha256": "EXACT_SOURCE_HASH",
    "binding": {"harness": "pi", "model": "provider/model", "effort": "high"}
  }
}
```

Apply returns `repair_review` (exit code 2) with the proposal, attempt ID, cost and proposal hash. It does not approve or activate the proposal. After reviewing its complete value and stop/control fields, replace the request with:

```json
{
  "approval": {
    "sourcePath": "/absolute/old-state.json",
    "attemptId": "EXACT_ATTEMPT_ID",
    "proposalHash": "EXACT_PROPOSAL_HASH",
    "confirmed": true,
    "reviewedControl": true
  }
}
```

Both examples are values of the authorization file's `repair` field; retain its offline evidence when required. Accepted replacements affect only converted staging, retain the raw original bytes, and pass ordinary import and full schedule validation again. Parseable original control fields cannot change. Malformed originals need explicit control review; valid replacement JSON is not proof of correct meaning.

Attempts are reserved before dispatch. Interrupted attempts are not replayed. A completed invalid attempt can be retried only by naming `retryOf` within the originally consented budget of at most three attempts. The review source is limited to 32 KiB, and repair receipts contribute to v2's estimated cost. These are not spending guarantees.
