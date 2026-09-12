# pi-companion

A prompt designed for long-horizon assistance, packaged as a [Pi](https://pi.dev) extension. Read the prompts for [onboarding and recurring work](src/prompt.md), [workflow reviews](src/review-prompt.md), [learning preferences](taste.md), and [following reports in Herdr](tail.md).

Most conversations with an agent begin with a request and end with an answer. But routines, goals, and interests need attention over time. Companion helps you build recurring workflows around them, carrying context forward instead of making you explain everything again.

## How it works

Companion starts with a conversation about your days, responsibilities, and what you want help keeping up with. Together, you decide which work is worth repeating, what information it needs, and how often it should happen.

That might mean a morning briefing from approved sources, a weekly review of your goals, or research into an ongoing interest. You approve the sources and schedules before recurring work begins.

Between runs, Companion keeps working notes and remembers preferences you share. It uses that context to distinguish useful changes from repetition, appending important findings and requested reports to `~/.companion-reports-updates.md`. Routine checks with nothing new stay in its notes.

As your priorities change, you can review the workflows together: keep what helps, adjust what needs attention, and stop what no longer matters.

## Installation

```sh
pi install git:github.com/dantetekanem/pi-companion
pi install git:github.com/jl1990/pi-scheduler
```

Run `/reload` in Pi, then `/companion` to get started. Recurring work requires Pi to remain running in the session that owns the schedules.

## Commands

- `/companion` or `/companion start`: begin setup or return to Companion and resume schedules it paused.
- `/companion stop`: pause this session's Companion schedules.
- `/companion review`: assess how useful the current workflows are and propose improvements.
