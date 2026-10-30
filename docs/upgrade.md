# Update or migrate Companion

Already using `pi-companion`? Update it in place. Moving from `/companion` inside Pi? Use the one-time migration below. To resume an interrupted migration, keep its workspace and journal and return to [Apply or resume](#3-apply-or-resume).

Use the same workspace throughout:

```sh
companion_home="${COMPANION_HOME:-$HOME/.companion}"
```

For a custom workspace, set this variable to its absolute path. `--home` overrides `COMPANION_HOME`, which otherwise defaults to `~/.companion`. Pass the workspace root, not an internal activated-data directory.

## Already using the CLI

1. Close the dashboard with Ctrl+C or stop your headless runner through its supervisor.
2. Update the package installation or checkout that supplies your command. Keep the workspace and its data. If the command already points to the updated checkout, just reopen it.
3. Check saved state, then launch:

```sh
pi-companion status --plain --home "$companion_home"
pi-companion schedules --home "$companion_home"
pi-companion --home "$companion_home"
```

The first two commands only read local state; the third starts the runner. Do not rerun migration or replace the workspace to resolve configuration errors.

## Legacy Pi extension: before planning

Migration copies private history and disables selected old scheduler tasks. Installation and ordinary CLI commands never start it.

Close the old owning Pi process and let its work finish or cancel **before hashing sources**. `/companion stop` also pauses routines; use it only if you want those pauses preserved. A saved pane or owner file does not prove the process stopped. Do not delete its locks.

Use an uninitialized destination. If `~/.companion` already contains a workspace, choose another unused path. Do not run `init` or open that destination before migration finishes.

Keep the saved Pi sessions available. If the old home has scheduler records (`~/.pi/agent/state/scheduler/tasks.json`), also keep `@jl1990/pi-scheduler` **0.5.1** with Croner **10.0.1** installed and name it in `schedulerPackage`. Imported schedules use those pinned helpers; migration does not install them. Without scheduler records, omit `schedulerPackage`. Select every saved Companion origin, including stopped ones, and choose one main conversation.

## 1. Inspect a read-only plan

Create a private `selection.json`, replacing the example paths and bindings:

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

The main working directory must match its saved session. Preserve the original session and review providers; choose missing bindings explicitly. If Pi starts through a wrapper, add `launcher` to `config` (see the README); repair attempts use it too. Staging replaces the example initialization date with the journal creation time.

```sh
pi-companion upgrade-plan --selection /absolute/selection.json --home "$companion_home"
```

Planning reads sources without copying them, starting a model or changing the scheduler. It returns source hashes, session and engine pins, and candidate tasks. Add a decision for every task in a mapped session using its exact hash and origin:

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

Use `unrelated` only for tasks outside Companion; titles alone do not establish ownership. Tasks referenced by a saved pause, stop or daily wake cannot be excluded. Imported one-time, interval, cron, shell, notify and message actions keep their original behavior. Intervals reschedule from completion; cron keeps its explicit timezone.

Run planning again, inspect the complete result and save it as private `plan.json`. Keep its `hash`. If review settings are required, select their file in `references` as `review-settings`, then supply its exact `path`, `size` and `sha256` in `reviewSettings`. Companion does not discover private sessions or settings for you.

## 2. Prepare private metadata

```sh
pi-companion upgrade-prepare --selection /absolute/plan.json --confirm PLAN_HASH --home "$companion_home"
pi-companion upgrade-status --home "$companion_home"
```

Preparation checks the pins and saves the reviewed plan and private journal. It returns a migration ID and source fingerprint without copying sources or disabling tasks. A changed plan cannot silently replace it.

## 3. Apply or resume

Owners using the lease protocol must have a stopped receipt for every mapped origin. For older owners, provide a private authorization file confirming they are offline:

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

This records your confirmation; it does not inspect processes. The session set must match exactly, and a held owner lease still blocks migration.

```sh
pi-companion upgrade-apply --confirm MIGRATION_ID --selection /absolute/authorization.json --home "$companion_home"
```

Apply checks shutdown evidence, prevents legacy startup, stages preserved originals and validates every origin and schedule. It then disables selected old tasks under the scheduler lock and activates the destination. Unrelated tasks, unknown metadata and original source files remain intact. Durable checkpoint inspection uses a disposable copy.

The journal records `inventory`, `staged`, `fencing`, `fenced`, `committed` and `verified`. On failure, keep its files, resolve the reported error and repeat the same command. Do not delete the fence, reset the journal or replace originals. Source changes require reconciliation; there is no automatic rollback or discard command.

## 4. Verify and open the migrated workspace

```sh
pi-companion upgrade-status --home "$companion_home"
pi-companion status --plain --home "$companion_home"
pi-companion schedules --home "$companion_home"
pi-companion history --home "$companion_home"
```

Check for `phase: "verified"`, expected schedules and paused states, and imported origins and archive paths. These commands do not start providers or checks. Then launch:

```sh
pi-companion --home "$companion_home"
```

Startup follows `active.json` without repeating migration. Open Reports to inspect imported results. Repeating apply verifies the existing activation rather than disabling tasks again. Historical costs stay separate from new usage. Migration verification does not prove a live check succeeded.

Historical `timeoutMs` fields are preserved but do not impose execution deadlines. Use `k` for running dashboard jobs; migration repair has no dashboard cancellation shortcut.

## Agent checklist

- Identify update, migration or resume; use one workspace root throughout.
- For CLI updates, preserve the workspace and skip migration commands.
- For migration, identify all origins, task ownership and original model/provider bindings. Preserve stops and pauses.
- Stop the old owner before hashing. Review and save the complete plan, then prepare with its hash.
- Apply with the returned migration ID and actual shutdown evidence. Resume the same journal after interruption.
- Verify status, schedules and history. Report unresolved errors and whether any live check was actually run.

## Optional bounded state repair

A no-tools Pi model can propose a correction to one malformed state JSON file with explicit source/provider consent. Ownership, task attribution, active attempts and uncertain stop states still require human decisions.

To request a proposal, add this `repair` value to the authorization file, retaining any required offline evidence:

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

Apply returns `repair_review` (exit code 2), the proposal, attempt ID, cost and proposal hash. It does not activate the proposal. Review the full value, including stop/control fields, then replace `repair` with:

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

Approved repairs change staging only and must pass import and schedule validation. Original bytes remain intact; parseable control fields cannot change. Valid JSON alone does not establish correct meaning.

Attempts are reserved before dispatch. Interrupted attempts are not replayed. A completed invalid attempt needs `retryOf` and remaining consented budget, at most three attempts. Sources are limited to 32 KiB; repair costs count toward the CLI estimate. Neither limit guarantees spending.
