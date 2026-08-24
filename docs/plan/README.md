# ADL planning

Plain markdown. No framework, no tooling, no generated state. Read it, edit it, commit it.

## The files

| File | What it's for | When it changes |
|------|---------------|-----------------|
| **[STATUS.md](./STATUS.md)** | ⭐ **Start here.** Where we are, what to do next, how to build and run. Written so a fresh session needs nothing else to begin. | End of every work session |
| [ROADMAP.md](./ROADMAP.md) | All 18 milestones at a glance, with dependencies and the hard gate | At a milestone boundary |
| [milestones/](./milestones/) | One file per milestone: goal, acceptance criteria, and the small steps to get there | As steps land |
| [DECISIONS.md](./DECISIONS.md) | Settled calls with the reasoning that settled them | When a decision is taken or reopened |
| [DEBT.md](./DEBT.md) | Everything discovered and not fixed — deferred items, accepted risks, open findings | The moment something is found |
| [REQUIREMENTS.md](./REQUIREMENTS.md) | The 92 v1 requirements, each mapped to a milestone | Rarely |

## How a milestone works

Each milestone file has two lists, and they are not the same thing:

- **Done when** — the acceptance criteria. These define the milestone. They came from the
  original planning work and shouldn't be edited casually.
- **Steps** — small, individually committable pieces of work. A route to the destination,
  not the destination. Reorder, split, merge and add freely.

**A milestone is done when the acceptance criteria are all ticked** — not when the steps
are. If every step is done and a criterion still isn't true, the steps were wrong.

## Working rules

1. **One milestone at a time, in order.**
2. **One step, one commit.** If a step turns out to be two things, split it in the file
   rather than growing the commit.
3. **Deferred is not done.** Anything found and not fixed goes in `DEBT.md` with an owner
   milestone and, where possible, a reproduction.
4. **Update `STATUS.md` when you stop.** It is the handoff to your next session.

## Conventions for the code itself

The house rules — the no-direct-spawn ban, watched-failing guards, classify-don't-throw,
derive-never-restate, commit format, test layout — live in **`.claude/CLAUDE.md`**, which
Claude Code loads automatically every session. They're worth reading once; several of them
are enforced by tests that will fail the build if you drift.

## Where the history went

This project previously used the GSD planning framework. Its artifacts — phase plans, code
reviews, verification reports, UAT records, and the full reasoning behind every accepted
risk — are preserved read-only in [`.planning/`](../../.planning/ARCHIVED.md).

**That directory is history, not instructions.** Nothing there should be updated. The
identifiers used in `DEBT.md` (`D-2-R-1`, `WR-03`, `G-03-3`, …) are greppable in it when
you want the original detail.
