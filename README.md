# pi-companion

A [Pi](https://pi.dev) extension for assistance that continues across days. Companion discovers useful recurring work, maintains its schedules, observes outcomes and adjusts what it does. You can keep talking with it; you do not need to manage a learning workflow.

## Start and stop

- `/companion` or `/companion start`: begin or resume Companion and its automatic daily reflection.
- `/companion stop`: stop learning and pause this session's Companion schedules, preserving history and unanswered questions.

Starting Companion in a new session always creates that session's routine schedules from the saved registry, even if equivalent schedules exist in another session. It does not ask which session should own the work, and it leaves other sessions untouched. Deduplication applies only within the current session.

Recurring work requires Pi running in the owning session. Within that session, start resumes only schedules Companion itself paused, not tasks cancelled, edited or stopped outside Companion. An older saved session resumes automatically only when active owned schedules establish that it was running and no pause/stop receipts contradict that; ambiguous legacy state remains stopped.

## How it learns

The existing agent does the work. It defines tasks in `~/.companion-schedules.md`, using established source and action permissions, and maintains context in `~/.companion-notes/`. It can create, revise, consolidate or retire its checks without asking you to administer each change. Broader access, external sends, installations and operational mutations still need their established authorization.

The extension records owned scheduler receipts, deliveries and normal user messages while Companion is running. The agent uses the internal `companion_record` tool to record observations, actual run outcomes, publications and answers. IDs are internal; you never need to supply task IDs or ratings. A delivery is not completion, publishing is not proof of reading, and no reply means uncertain usefulness, not dislike.

Every 24 hours, one session-owned scheduler wake runs an isolated reflection with the existing Teams global `favoriteModels.read-critical` binding. It uses the exact configured model and effort, without changing the conversation model. That slot is not inherently a stronger model: it can select the same model with more reasoning effort. The current adapter supports the Codex responses API and requires the same provider as the conversation; missing, unsupported or cross-provider routing fails visibly rather than silently falling back.

Reflection reviews bounded evidence, retains incremental lessons, links clear answers to questions and proposes a few changes with expected benefits and success signals. The existing agent receives that context, checks current state and permissions, applies useful decisions through the normal tools and records receipts. Later reviews compare outcomes with the intended benefit. This is harness-level learning, not model-weight training or a measured claim that recommendations improve.

## Questions and reports

Companion can interview you whenever it needs context. It can also leave questions in `~/.companion-reports-updates.md`, the same append-only Markdown feed used for important findings. Answer normally in the Companion conversation; those answers inform later decisions. Unanswered questions remain pending without repeated nudges. Routine no-news runs stay quiet. Tail the file in your existing tracking pane; Companion does not create another feed or unread counter.

## Runtime boundaries

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

Run `/reload`, then `/companion`. Automatic reflection reuses an existing Teams `read-critical` favorite. The extension never installs integrations or changes that mapping itself.

See the [agent instructions](src/prompts/prompt.md), [daily reflection contract](src/prompts/reflection.md) and [taste guidance](src/prompts/taste.md).
