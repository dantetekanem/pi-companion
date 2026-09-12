# pi-companion

A personal assistant inside [Pi](https://pi.dev) that keeps up with your routines, goals, and the information you care about.

Companion talks with you about what to follow, which sources it can use (such as email, calendars, Slack, or notes), and how often to check them. With your approval, it sets up recurring checks and keeps notes between runs so you don't have to start from scratch each time.

It appends important findings and requested reports to `~/.companion-reports-updates.md`. Routine checks with nothing new stay in its notes. It also remembers preferences you share and can review whether its schedules are still useful.

## Get started

Requires Pi with 0.85.1-compatible APIs. Install your checkout with `pi install /path/to/pi-companion`, run `/reload`, then `/companion`.

To try it for one invocation instead:

```sh
pi -e ./src/index.ts
```

Recurring checks require [Pi Scheduler](https://pi.dev/packages/@jl1990/pi-scheduler?name=pi-scheduler) and Pi running in the session that owns them. Companion asks before setting up integrations or scheduled work.

## Commands

- `/companion` or `/companion start`: start setup or return to Companion; resume schedules it paused.
- `/companion stop`: pause this session's Companion schedules without deleting their history.
- `/companion review`: assess current schedules and suggest improvements for your approval.

Schedules live in `~/.companion-schedules.md`; working notes and learned preferences live in `~/.companion-notes/`. Each Pi session controls its own schedules. In Herdr, other sessions can find Companion's last-known pane, and you can approve a separate pane to follow its reports live.
