# pi-companion

A [Pi](https://pi.dev) extension for assistance that continues across days. Companion discovers useful recurring work, maintains its schedules, observes outcomes and adjusts what it does. You can keep talking with it; you do not need to manage a learning workflow.

## Start and stop

- `/companion` or `/companion start`: begin or resume the saved Companion conversation and its daily reflection.
- `/companion stop`: stop learning and pause the owning session's Companion schedules, preserving history and unanswered questions. Run it in that session.

Returning starts use Pi Durable checkpoints without submitting a model setup turn. They do not scan notes, generate resume documents, or recreate routines. A start from a different Pi conversation switches to the saved owner; if another process already owns Companion, it reports that rather than taking over. Other sessions' schedules remain untouched.

Recurring work requires Pi running in the owning session. Start resumes only schedules Companion itself paused, not tasks cancelled, edited or stopped outside Companion. On first adoption after upgrading, run `/companion start` in the existing Companion conversation. Its saved state and schedules are reused without reading private histories. If a registry exists but the current conversation has no saved setup or active approved routines, adoption fails visibly instead of rebuilding it elsewhere.

A daily-reflection stop failure does not prevent pausing owned routines. Failures and scheduler receipts remain saved and visible after restart. Once the scheduler issue is corrected, run `/companion stop` again to retry; a failed control is not reported as completed.

A genuinely new Companion sends its setup instructions once. The dispatch is reserved before sending; a crash in that gap does not cause an automatic retry. If initial setup was interrupted, continue in the saved conversation. An unavailable or deleted owning session is an error, not permission to replace it.

## How it learns

The existing agent does the work. It defines tasks in `~/.companion-schedules.md`, using established source and action permissions, and maintains context in `~/.companion-notes/`. It can create, revise, consolidate or retire its checks without asking you to administer each change. Broader access, external sends, installations and operational mutations still need their established authorization.

The extension records owned scheduler receipts, deliveries and normal user messages while Companion is running. The agent uses the internal `companion_record` tool to record observations, actual run outcomes, publications and answers. IDs are internal; you never need to supply task IDs or ratings. A delivery is not completion, publishing is not proof of reading, and no reply means uncertain usefulness, not dislike.

Every 24 hours, one session-owned scheduler wake runs an isolated reflection with the existing Teams global `favoriteModels.read-critical` binding. It uses the exact configured model and effort, without changing the conversation model. That slot is not inherently a stronger model: it can select the same model with more reasoning effort. The current adapter supports the Codex responses API and requires the same provider as the conversation; missing, unsupported or cross-provider routing fails visibly rather than silently falling back.

Reflection reviews bounded evidence, retains incremental lessons, links clear answers to questions and proposes a few changes with expected benefits and success signals. The existing agent receives that context, checks current state and permissions, applies useful decisions through the normal tools and records receipts. Later reviews compare outcomes with the intended benefit. This is harness-level learning, not model-weight training or a measured claim that recommendations improve.

## Questions and reports

Companion can interview you whenever it needs context. It can also leave questions in `~/.companion-reports-updates.md`, the same append-only Markdown feed used for important findings. Answer normally in the Companion conversation; those answers inform later decisions. Unanswered questions remain pending without repeated nudges. Routine no-news runs stay quiet. Tail the file in your existing tracking pane; Companion does not create another feed or unread counter.

## Runtime boundaries

Pi Durable **1.1.0** (experimental) owns model-free start/stop tasks in `companion/durable/companion.sqlite` under Pi's agent directory. A typed document stores the owner, setup-dispatch reservation, and control-task identity. Tasks checkpoint between daily-reflection control and routine control; after interruption, the remaining phase reconciles existing scheduler receipts before acting. Quit, reload, and session replacement close the Harness and release its process lock. After an unclean process death, a stale lock may take up to five minutes to expire; never delete a live owner's lock.

This integration does not move ordinary model turns, tool calls, scheduled checks, or reflection into Durable. Pi and its installed extensions still execute them. Durable has no configured model providers here, and no generic bridge from Pi tool metadata to executable tools. SQLite uses WAL with `synchronous=NORMAL`: checkpoints survive process crashes, but the latest commits may be lost after power failure. See [Pi Durable's storage contract](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/README.md#storage).

Experience, question links, lesson revisions, decisions and review receipts live in the existing session storage under Pi's agent directory (`companion/<session-hash>.json`). Older evidence remains on disk. Context excludes evidence and derived memory from another provider. The agent should record only material permitted for that provider; the extension does not crawl accounts, archives or notes for the reflector.

The model binding is a small read-only schema integration with Teams' documented global `~/.pi/agent/pi-extended-teams/settings.json`; project settings cannot override favorites. No extra policy file or command is required. Pi's model registry handles authentication. Reviews omit tools, reserve at most one attempt per UTC day, cap supplied context and accepted output at 32 KB each, and have a two-minute deadline. The installed Codex adapter does not enforce a token-generation cap; output validation is not a spending limit. Stop, model changes and session shutdown/navigation reject stale results. Failed or interrupted attempts are retained rather than automatically retried that day.

Scheduler commands own timers and persistence. Companion validates its opaque-token wake and records model completion separately from scheduler delivery. Busy-session wakes wait for settlement. Review effectiveness and real provider behavior require live use; isolated tests exercise the installed scheduler transport and mock the paid model boundary.

The research informs three choices:

- [Reflexion, §3](https://arxiv.org/html/2303.11366v4): evaluate a trajectory, turn feedback into a verbal lesson, and condition later actions on that memory. Companion keeps delivery, outcomes and reflection separate.
- [ACE, §3 and §4.4](https://arxiv.org/html/2510.04618v2): merge itemized context updates instead of repeatedly rewriting the whole memory. ACE also reports degradation with unreliable feedback; citations and tentative lessons reduce that risk but cannot prove a model's interpretation correct.
- [Pare, Appendix B](https://arxiv.org/html/2604.00842v1): distinguish rejection from a user gathering context before deciding. Companion therefore does not treat silence as rejection or a task firing as success.

These papers motivate the approach; they do not establish that it works for a particular user. Companion does not reproduce their benchmarks or claim their measured gains.

## Installation

```sh
pi install git:github.com/dantetekanem/pi-companion
pi install git:github.com/jl1990/pi-scheduler
```

Requires Node 22.19 or newer. The package includes Pi Durable and its runtime dependencies; it does not install or start a daemon. Run `/reload`, then `/companion` in the existing Companion conversation when upgrading. Automatic reflection reuses an existing Teams `read-critical` favorite. The extension never installs integrations or changes that mapping itself.

See the [agent instructions](src/prompts/prompt.md), [daily reflection contract](src/prompts/reflection.md) and [taste guidance](src/prompts/taste.md).
