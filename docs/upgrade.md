# One-time v2 upgrade

These commands can copy private histories and change old scheduler records. Run them only when you choose to migrate. Installing the package, opening the dashboard, listing schedules and plain output never start an upgrade.

All development checks use disposable synthetic sources. No live migration is part of developing this checkout.

## Before planning

Close the old owning Pi process and let its admitted work finish or cancel. `/companion stop` also pauses routines; use it only if you want those pauses preserved in v2. Shutdown can change saved files, so do this before taking source hashes. Do not delete its locks or infer shutdown from a pane name. The CLI does not kill an old process for you.

Select a new destination, normally `~/.pi-companion`. Do not initialize it first. Keep the old Pi session files and installed `@jl1990/pi-scheduler` **0.5.1** with Croner **10.0.1** available. Compatibility schedules use pinned pure helpers from that installation; the CLI does not install or upgrade them.

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
pi-companion upgrade-plan --selection /absolute/selection.json --home /absolute/new-home
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
pi-companion upgrade-prepare --selection /absolute/plan.json --confirm PLAN_HASH --home /absolute/new-home
pi-companion upgrade-status --home /absolute/new-home
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
pi-companion upgrade-apply --confirm MIGRATION_ID --selection /absolute/authorization.json --home /absolute/new-home
```

Apply installs the legacy startup fence, proves shutdown, stages byte-preserved originals, inspects a disposable copy of any Durable checkpoint, and validates every origin and owned schedule. Only then does it disable selected old records under the scheduler's lock and activate one destination. Unrelated records and unknown metadata survive. The original registry, notes, report feed, state files and mapped sessions remain available with their provenance; only the selected old scheduler records are disabled.

The journal advances through `inventory`, `staged`, `fencing`, `fenced`, `committed`, and `verified`. A failure is not partial success. Leave its files in place, inspect the diagnostics, resolve the reported blocker and repeat the same apply command. Never replace originals, delete the fence or reset the journal to force progress. Source drift requires reconciliation; there is no automatic rollback or discard command.

After `verified`, startup resolves `active.json` to the same data directory and never repeats the upgrade. Repeating apply verifies that activation rather than re-disabling schedules. Run `pi-companion history` for imported provenance and local archive paths; open Reports in the terminal for the imported reports. Historical cost estimates remain separate from v2 spend.

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
