---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 04
current_phase_name: first-agent-backend-live-transcripts
status: executing
stopped_at: Phase 4 EXECUTED; its credentialed UAT (04-UAT.md) deferred to the end-of-project credentialed verification pass
last_updated: "2026-08-21T05:30:18Z"
last_activity: 2026-08-20
last_activity_desc: Phase 04 all 10 plans executed and merged; 2 critical review findings fixed; verification routed 1 item to human UAT
progress:
  total_phases: 4
  completed_phases: 3
  total_plans: 38
  completed_plans: 38
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-08-17)

**Core value:** A feature folder goes in, and a green, human-approvable PR comes out — with the whole loop's reasoning visible in the PR — without a human orchestrating any of the handoffs.
**Current focus:** Phase 04 — first-agent-backend-live-transcripts

## Current Position

Phase: 04 (first-agent-backend-live-transcripts) — EXECUTED, not COMPLETE — same shape of hold as Phase 02, below
Plan: 10 of 10 — all executed, merged to main
Status: 04-UAT.md deferred to the end-of-project credentialed verification pass — not a live blocker; see "Phase 04 — what's left of testing" below
Last activity: 2026-08-20 — all 10 plans executed; 04-REVIEW.md found 2 Critical findings, both fixed with regression tests (commit aa29fd3); 04-VERIFICATION.md scored 8/9, routed 1 item to human verification

Progress: [██████████] 100% (plans) — the COMPLETE checkbox is deliberately unticked; nothing downstream waits on it

## Performance Metrics

**Velocity:**

- Total plans completed: 20
- Average duration: —
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 10 | - | - |
| 03 | 10 | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: Phase 12 is a hard DOGFOOD gate blocking Phases 13-18 — a precondition, not a milestone label.
- [Roadmap]: Second agent backend (Phase 11) is the sole breadth item permitted before the gate; second *backend* precedes second *forge* because ordering is by abstraction risk.
- [Roadmap]: Everything cheap-now/ruinous-later is pulled into Phases 1 and 5 — verdict schema, `criterionId`, `inconclusive`, protected paths, cost recording, forge-neutral vocabulary, sticky-comment data model, trusted-path detection.
- [Roadmap]: First gate exercised in Phase 5 is a command gate (`npm test`), not the reviewer agent — deterministic and forceable to fail, so send-back plumbing is proven without agent nondeterminism.
- [Research]: Kysely + hand-written SQL migrations settled; no Drizzle migration phase exists or should be added.

### Pending Todos

[From .planning/todos/pending/ — ideas captured during sessions]

None yet.

### Blockers/Concerns

- **Cost-accounting spike narrowed, not closed (04-10, 2026-08-20).** The recording path is real, tested, and wired end to end: `usageFromResult` (`packages/agent-claude-code/src/usage.ts`) maps a backend's terminal event to a `usage_events`-shaped record with `costSource: 'reported'` (never `'computed'` for this backend) and all four token counters null — never zero — when the backend did not report them; the worker reports over a new, fenced `usage` IPC message (`packages/manager/src/ipc/protocol.ts`); the manager inserts through the existing `usageRepository(db).record` — never a second writer (`packages/manager/src/worker-supervisor/supervisor.ts`, `daemon.ts`); and a full `adl dev-run` → dispatch → forked worker → manager write is proven end to end against a scripted replay double, including a negative check that the cache-token columns stay null (not zero) when the payload omits them (`packages/manager/test/usage/recording.test.ts`). **What remains unknown, and is the only thing left to close the spike:** no invocation of the real, pinned Claude Code CLI (2.1.237) against a real `ANTHROPIC_API_KEY` has been performed in any session to date — 04-01 Task 3's original gap, carried unchanged through 04-06/04-07/04-09 and now 04-10 (this execution host has no credential configured, and its installed `claude` resolves to 2.1.227, not the pin — same PATH-shadowing 04-07-SUMMARY.md already recorded). Two questions the ROADMAP's Phase 6 prerequisite names are therefore still open: (1) whether the real CLI's `usage` object field names match what `events.ts`/`usage.ts` assume (04-RESEARCH.md Pattern 4's Assumption A1 — the mapping is built from `events.ts`'s already-documented stand-in, not a captured fixture), and (2) whether the reported `total_cost_usd` reconciles against the provider's own billed usage for the same invocation. Neither can be answered without that one real call. **To close:** run `adl dev-run` once against the pinned CLI with a real credential, read the resulting `usage_events` row back (`usageRepository(db).listForFeature`), and compare it against the Anthropic Console's usage report for the same window.
- **Research flagged for Phases 4, 8, 11, 14** — unattended agentic-CLI behaviour; code-blind tester prompt design; owned-loop tool implementation over `Workspace`; GitLab API specifics.
- **Phase 17 is UI-bearing** — `/gsd-ui-phase` should be offered before planning it.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260821-a90 | Defer all credentialed-CLI UAT tests to a single end-of-project pass | 2026-08-21 | 3d7f884 | [260821-a90-defer-all-credentialed-cli-uat-tests-to-](./quick/260821-a90-defer-all-credentialed-cli-uat-tests-to-/) |

## Deferred Items

Items acknowledged and carried forward from previous milestone close, and
items deferred to the end-of-project credentialed verification pass:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Credentialed UAT | `04-UAT.md` test 1 — one real `ANTHROPIC_API_KEY` plus an unshadowed `@anthropic-ai/claude-code@2.1.237` run of `adl dev-run` and `adl logs -f`; closes rows 2-4 of the Phase 04 gap table | Deferred to the end-of-project credentialed verification pass | 2026-08-21 (Phase 04) |
| Credentialed fixtures | `04-01` Task 3 — capture real CLI transcript fixtures into `packages/agent-claude-code/test/fixtures/`; rides along with the run above but is a separate deliverable | Deferred to the end-of-project credentialed verification pass | 2026-08-21 (Phase 04) |
| Linux-host repro | `D-2-08-1` and `.planning/todos/pending/reproduce-d-2-r-1-on-linux.md` | Deferred, host-bound rather than credential-bound — needs a Linux host, independent of the credential gap | 2026-08-19 (Phase 02) |

## Session Continuity

Last session: 2026-08-20T11:48:21.828Z
Stopped at: Phase 4 context gathered
Resume file: .planning/phases/04-first-agent-backend-live-transcripts/04-CONTEXT.md

## Phase 02 — why it is EXECUTED and not COMPLETE

Maintainer decision, 2026-08-19. This is a deliberate hold, not unfinished work.

**Everything is done and shipped.** 8/8 plans with summaries; 5/5 must-haves
verified; `02-VERIFICATION.md` status `passed`; `02-SECURITY.md` `threats_open: 0`
(45/45 threats resolved); `02-UAT.md` status `complete` — 4 passed, 0 issues.
All code is merged to `main` and CI-green on both matrix legs.

**The one thing outstanding:** `02-UAT.md` test 2 — running D-2-R-1's
cross-feature isolation reproduction on a Linux host — is SKIPPED, because it
cannot run from the maintainer's Windows machine. GSD's phase-transition
predicate counts a skipped UAT item as unverified, which is the correct
conservatism: "we decided not to check" is not "we checked".

Rather than force the checkbox, the phase stays `executed`. Nothing depends on
the flag; the work is on `main`.

**To close it:** run the reproduction per
`.planning/todos/pending/reproduce-d-2-r-1-on-linux.md`, mark test 2, then
re-run `/gsd-verify-work 2`. Phase 3 is the natural moment — it is where
manager-owned lease state makes the real fix (a uid pool) buildable, so both
can be closed together.

**Open, tracked, and deliberately not auto-closable** (no `resolves_phase:`):

- `revisit-cross-feature-isolation.md` — one trust domain per daemon, accepted
  for v1 with four named revisit triggers

- `reproduce-d-2-r-1-on-linux.md` — until this runs, that acceptance rests on
  argued rather than demonstrated severity

- `phase-15-needs-config-neutralisation-criterion.md` — Phase 15's criteria say
  nothing about config neutralisation, so D-2-R-4 would land with no acceptance
  point

**Carry into Phase 3/4:** `D-2-08-1` — on a provisioned Linux deployment the
agent cannot run git inside its own worktree (`safe.directory`, exit 128). It
blocks nothing in WORK-01..07 but lands squarely on Phase 4's "makes a real
commit through the workspace".

## Phase 04 — what's left of testing before COMPLETE

**Deferred, not blocking — maintainer decision, 2026-08-21.** This phase stays
`executed` rather than `complete` for the same shape of reason as Phase 02
above, but a different specific one — Phase 02 lacks a Linux *host*, Phase 04
lacks a *credential* (a live `ANTHROPIC_API_KEY` plus the pinned Claude Code
CLI resolving unshadowed on `PATH`).

Every credentialed item in the project now accumulates into a single
end-of-project credentialed verification pass instead of gating the phase
that surfaced it, per PROJECT.md's Key Decisions table.

`04-UAT.md` is that pass's first entry and stays `pending` — deferred is not
passed, and Phase 04 does not earn a COMPLETE checkbox from this decision.

The gap inventory below is unchanged and is what the end-of-project pass
works from.

All 10 plans executed and merged to `main` (`228baf3..b67aa22`). Full monorepo
suite green (cli 33/33, core 446/446, plugin-sdk 28/28, agent-claude-code
59/59, db 75/75, workspace 222/228 + 6 platform-gated skips, manager 263/263,
root architecture suite 65/65), lint/typecheck/format clean. `04-REVIEW.md`
found 2 Critical defects during code review — both fixed with regression
tests before verification (commit `aa29fd3`; see that file's "Post-Review
Fixes" section). `04-VERIFICATION.md` scored 8/9 must-haves, status
`human_needed`.

**One root cause behind every open item below:** no session across this
entire phase (04-01 through 04-10) ever invoked the real, pinned Claude Code
CLI (`2.1.237`) against a real `ANTHROPIC_API_KEY`. This execution
environment has neither — no credential configured, and the host's `claude`
on `PATH` resolves to an older WinGet-installed `2.1.227` that shadows the
correctly npm-installed `2.1.237` (confirmed correct via direct path
invocation, never used for a real capture). Every gap traces back to this one
missing precondition, not to a code defect — each was hit, recorded honestly,
and left open rather than faked, across five separate plans.

**What running one real, credentialed `adl dev-run` + `adl logs -f` closes:**

| # | Gap | Where recorded | Closed by the UAT run? |
|---|-----|-----------------|-------------------------|
| 1 | `04-01` Task 3: capture real CLI fixtures (`packages/agent-claude-code/test/fixtures/` — does not exist on disk) | `04-01-SUMMARY.md`, `04-VERIFICATION.md` truth #3 | Partially — a real invocation proves the code path works, but capturing the fixture files themselves is a separate follow-up task |
| 2 | `04-06` Task 1 human-check: watch a real transcript stream live, confirm the commit | `04-06-SUMMARY.md` | Yes — this is exactly `04-UAT.md`'s test |
| 3 | `04-07`: `claudeVersionCheckRunner` never exercised against the real pinned binary | `WINDOWS.md` #2 | Yes, once the PATH shadowing is fixed so the daemon actually resolves `2.1.237` |
| 4 | `04-10` Task 3 human-check: reconcile a real `usage_events` row against the Anthropic Console's billed usage — the cost-accounting spike is narrowed, not closed | `WINDOWS.md` #5, this file's Blockers/Concerns above | Yes — this is the other half of `04-UAT.md`'s test |
| 5 | `D-2-08-1`: Linux privilege-drop reproduction | `WINDOWS.md` #1, carried from Phase 2 | No — needs a Linux host, independent of the credential gap |

**Single UAT item that covers rows 2-4:** `04-UAT.md` — run `adl dev-run
<feature-id>` and `adl logs -f <stage-attempt-id>` with `@anthropic-ai/claude-code@2.1.237`
resolving correctly on the daemon's `PATH` (not shadowed) and a real
`ANTHROPIC_API_KEY` set. Confirm: the transcript scrolls live, not all at
once; `adl logs -f` exits on its own once the run ends (no Ctrl-C needed —
this is the CR-01 fix, proven in code but not yet against the real CLI); the
commit is authored `ADL (claude-code) <...>`, never the operator's identity;
the resulting `usage_events` row has `cost_source: 'reported'` and a cost
that reconciles against the Console. Then `/gsd-verify-work 4`.

**Non-blocking, tracked as follow-up only** (none exploitable, none block a
success criterion, per `04-REVIEW.md`'s own severity classification):

- **WR-01** — the 10-minute wall-clock timeout is a hardcoded placeholder, not wired to `effectiveConfig`; risks misclassifying a legitimate long agent run as a timeout.
- **WR-02** — `loadSpecFromWorktree` builds a path via plain `join()` with no `resolveWithinRoot` containment check; not reachable with untrusted input today, but inconsistent with the containment discipline used everywhere else in this phase.
- **WR-03** — the rendered prompt is passed to the `claude` CLI as a trailing positional argument with no `--` end-of-options separator; safe today only because the template can never start with `-`.
- **IN-01/02/03** — a same-name/different-type placeholder field on `stage_result`, an unused `AgentTask.contextFiles`, and an untested-on-any-platform ENOENT fallback branch. Documentation/clarity notes, not functional defects.
- **`WINDOWS.md` #3, #4** — two accepted deviations (a lighter test harness for the kill/reattach reconnect proof; a dropped capability-reconciliation error event that would have hijacked unrelated runs into false failures). Both are deliberate, documented design decisions, not open test debt.
