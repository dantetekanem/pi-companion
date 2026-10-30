# Companion inside Pi

For the standalone CLI, see [README](../README.md). To migrate from this extension, follow the [upgrade guide](upgrade.md) with the old owner stopped.

## Install

Requires Node 22.19 or newer:

```sh
pi install git:github.com/dantetekanem/pi-companion
pi install git:github.com/jl1990/pi-scheduler
```

Run `/reload`, then `/companion`. The package includes Pi Durable; it does not install a daemon. Automatic reflection uses `favoriteModels.read-critical` in `~/.pi/agent/pi-extended-teams/settings.json`. Companion does not install Teams or change that setting.

## Start and stop

- `/companion` or `/companion start` starts or resumes the saved conversation and daily reflection.
- `/companion stop` pauses that session's Companion routines and reflection while keeping history and unanswered questions.

Keep the owning Pi session running for recurring work. Start resumes only routines Companion paused, leaving other sessions' work and externally changed routines alone. It never starts migration.

Without a Durable checkpoint, an existing installation uses the current Pi session and saved state. With a checkpoint, it returns to the saved owner without another setup turn. If another process owns the checkpoint, startup reports that conflict rather than taking over.

New sessions receive setup once; returning starts reuse the daily wake. Setup is reserved before dispatch. After interruption, continue in the saved conversation; it is not retried automatically. Missing owners are reported, not replaced.

A reflection-stop failure does not prevent pausing routines. Correct the scheduler error and retry `/companion stop`; failures remain visible after restart.

## Notes, reports and questions

Routines live in `~/.companion-schedules.md`; context lives in `~/.companion-notes/`. The agent maintains them within existing permissions. Broader access, sends, installs and operational changes need authorization.

Important findings and questions go to the append-only `~/.companion-reports-updates.md` feed. Follow it in an existing tail pane and answer questions normally in the conversation. Unanswered questions remain pending without repeated nudges; routine no-news checks stay quiet. You do not need to manage task IDs or ratings.

## Daily reflection

Every 24 hours, a session-owned wake reviews recorded work using the configured `read-critical` model and effort. The conversation model stays unchanged. The current adapter supports the Codex responses API and requires the same provider as the conversation; unsupported settings fail visibly.

Reflection proposes changes with benefits and success signals. The agent checks state and permissions before applying them and records outcomes through `companion_record`. Delivery does not prove reading or usefulness; silence does not mean rejection. Learning uses saved lessons, not model-weight training.

Reviews have no tools, allow one attempt per UTC day and limit input/output to 32 KB each. These bounds do not cap spending. Stop, model changes and session shutdown/navigation cancel stale work. Failed or interrupted reviews are saved rather than retried that day.

## Storage and recovery

Checkpoint-backed installations use Pi Durable 1.1.0 for start/stop control in `companion/durable/companion.sqlite` under Pi's agent directory. Control tasks checkpoint between reflection and routine operations, then reconcile scheduler receipts after interruption. Ordinary turns, tools and checks still run in Pi.

Quit, reload and session replacement release the owner lock. After an unclean exit, a stale lock can take five minutes to expire; do not delete a live owner's lock. SQLite WAL with `synchronous=NORMAL` protects against process crashes but can lose recent commits on power failure. Storage contract: https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/README.md#storage

Evidence, lessons and review receipts remain in `companion/<session-hash>.json` under Pi's agent directory. Reflection excludes another provider's evidence and does not crawl private accounts or archives. Scheduler delivery and model completion are recorded separately; busy-session wakes wait for settlement. Tests mock paid model calls, so live usefulness and provider behavior still need observation.

## Instructions and references

Read the [agent instructions](../src/prompts/prompt.md), [reflection contract](../src/prompts/reflection.md) and [taste guidance](../src/prompts/taste.md).

The learning approach draws on verbal feedback in Reflexion, incremental context updates in ACE, and Pare's distinction between rejection and further investigation. These motivate the design, not claims that Companion reproduces their results:

- https://arxiv.org/html/2303.11366v4
- https://arxiv.org/html/2510.04618v2
- https://arxiv.org/html/2604.00842v1
