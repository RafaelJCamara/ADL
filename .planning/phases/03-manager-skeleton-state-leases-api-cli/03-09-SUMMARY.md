---
phase: 03-manager-skeleton-state-leases-api-cli
plan: 09
subsystem: testing
tags: [scenario-test, crash-recovery, concurrency, ci-matrix, platform-gate-discipline, docs]

# Dependency graph
requires:
  - phase: 03-manager-skeleton-state-leases-api-cli
    provides: "the reaper/fencing/crash-recovery machinery (03-05), the boot startup gate and boot orphan kill (03-06), the dispatcher and concurrency cap (03-07), and the status view/control verbs/GC schedule (03-08) this plan proves together in one interaction test"
provides:
  - "packages/manager/test/scenario/concurrency-crash-restart.test.ts — the D-32 scenario: 3 real leased features at concurrency.global 3, one SIGKILLed mid-run (recovered by the fast path), the daemon restarted while the other two are still leased (recovered by the real, unmodified startDaemon() boot sequence against real orphaned processes), proving all five D-32 closing assertions together"
  - "packages/manager/test/helpers/lease-audit.ts — collectLeaseIntervals/findOverlappingLeases, reconstructing lease spans from the append-only feature_events log so double-leasing is provable from the log rather than a final-state snapshot"
  - "packages/manager/test/helpers/held-worker-entry.ts + worker-harness.ts's withHeldWorker() — a worker double that never completes its stage on its own, the deterministic mid-run kill hook the scenario needs"
  - "test/platform-gate-discipline.test.ts — a root-suite scan proving every platform-gated case in packages/manager/test/ and packages/cli/test/ routes through the sanctioned helper, never a bare process.platform/skipIf check"
  - "test/ci-matrix.test.ts extended to assert the non-Linux CI leg runs `pnpm -r test` (not merely that a test step exists on it)"
  - "packages/manager/README.md and packages/cli/README.md — operator-facing documentation of the daemon config, startup sequence, Windows degradations, worker-stop mechanism, and the full adl verb set"
affects: []

# Actuals (#2632)
actuals:
  tokens: 15400
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "A scenario test that needs to prove a manager's OWN process death (not a graceful shutdown) assembles its own 'daemon 1' from startDaemon()'s own exported pieces (createSupervisor, startReaper, dispatchOnce) rather than using a live startDaemon() handle — DaemonHandle.stop() only exposes a monolithic graceful stop, which stops every live worker deliberately and cannot simulate an orphaning crash. 'Daemon 2' is then the real, unmodified startDaemon(), so the actual production boot sequence is what gets proven."
    - "A live child process is 'orphaned' inside a single-process test by calling .removeAllListeners() on its ForkedWorker's child/stdout/stderr — standing in for 'the process that held these listeners no longer exists', without needing a second real OS process for the manager itself."
    - "A worker double that never resolves its stageRunner promise (held-worker-entry.ts) is the reliable way to guarantee a SIGKILL lands mid-run in a test — createSupervisor.spawn's forkWorker call passes no env override, so ADL_TEST_STAGE_DELAY_MS (used by the existing scripted-worker-entry.ts double) never actually reaches a child forked through the supervisor, making timing-based holds unreliable for a scenario whose kill timing must be exact."
    - "lease-audit.ts's collectLeaseIntervals is deliberately naive about pairing: a second lease_acquired before a lease_expired closes the first is recorded as a still-open interval rather than silently closed at the new acquisition's time, so findOverlappingLeases can actually detect the anomaly instead of a bug in the reconstruction paving over it."

key-files:
  created:
    - packages/manager/test/scenario/concurrency-crash-restart.test.ts
    - packages/manager/test/helpers/lease-audit.ts
    - packages/manager/test/helpers/held-worker-entry.ts
    - test/platform-gate-discipline.test.ts
    - packages/cli/README.md
  modified:
    - packages/manager/test/helpers/worker-harness.ts
    - test/ci-matrix.test.ts
    - packages/manager/README.md

key-decisions:
  - "The scenario runs a manually-assembled 'daemon 1' (createSupervisor + startReaper + manual dispatchOnce calls) rather than a live startDaemon() handle, specifically so the test can sever daemon 1's observation of its two still-live workers (removeAllListeners) without touching the processes themselves — simulating an ungraceful manager death, not a graceful shutdown. 'Daemon 2' is the real, unmodified startDaemon(), so the actual restart boot sequence (schema gate, D-35 reconciliation, D-13 boot orphan kill, D-13 unconditional lease expiry) is what the scenario proves, not a second approximation of it."
  - "All three of the scenario's workers use a new 'held' double (held-worker-entry.ts) rather than the existing scripted-worker-entry.ts, because ADL_TEST_STAGE_DELAY_MS never reaches a child forked through createSupervisor.spawn (no env override is passed to forkWorker there), making the existing double's completion timing unreliable for a scenario whose SIGKILL must land deterministically mid-run rather than merely probably."
  - "The GC-pass closing assertion (D-32's 'no orphan worktrees remain') drives one of the scenario's three features directly to `abandoned` via a raw UPDATE, since no gate pipeline exists yet in this phase to walk any feature to a real TERMINAL_STATE — the same gap test/recovery/crash-recovery.test.ts's own precedent already works around. The other two features stay non-terminal and their worktrees are asserted to survive the same GC pass untouched."
  - "The scenario's Linux-only assertion (that the boot orphan kill actually SIGKILLs the two orphaned processes) is gated through requirePlatform('linux', ...) rather than asserted unconditionally — D-13's unconditional lease-expiry half is proven on every platform, but D-14's actual process kill has no subject on Windows (readProcessStartTime returns 'unavailable', which killBootOrphans treats as not-attributable, per T-3-03's accepted disposition). The scenario's own teardown independently SIGKILLs any surviving recorded pid regardless of platform, so the T-3-36 no-leaked-process assertion is unconditional even though the production kill is not."
  - "No changes to .github/workflows/ci.yml. The Windows matrix leg already runs `pnpm -r test` (landed in 03-01), and a full local Windows run (`pnpm -r typecheck && pnpm lint && pnpm format && pnpm -r test && vitest run --project root`) turned up no genuine cross-platform failure to fix or gate."

requirements-completed: [EXEC-03, EXEC-05, EXEC-06]

coverage:
  - id: D1
    description: "The D-32 scenario (three features at concurrency 3, one SIGKILLed mid-run and recovered by the fast path, the daemon restarted while the other two are orphaned and recovered by the real boot sequence) proves all five closing assertions: every feature accounted for with no expired lease held, committed work intact on every branch including the killed feature's, the spend ledger byte-identical before/after, zero orphan worktrees after a GC pass, and zero overlapping lease intervals proven from the append-only feature_events log"
    requirement: "EXEC-03"
    verification:
      - kind: integration
        ref: "packages/manager/test/scenario/concurrency-crash-restart.test.ts#the D-32 scenario"
        status: pass
    human_judgment: false
  - id: D2
    description: "The scenario runs at concurrency.global 3 — three features leased and forked simultaneously via real dispatchOnce calls against the real concurrency cap"
    requirement: "EXEC-05"
    verification:
      - kind: integration
        ref: "packages/manager/test/scenario/concurrency-crash-restart.test.ts#the D-32 scenario"
        status: pass
    human_judgment: false
  - id: D3
    description: "A real, unmodified startDaemon() boots against the same on-disk database mid-scenario and its production boot sequence (schema gate, repo reconciliation, boot orphan kill, unconditional lease expiry) recovers the two orphaned features, with feature_events left gap-free and contiguous"
    requirement: "EXEC-06"
    verification:
      - kind: integration
        ref: "packages/manager/test/scenario/concurrency-crash-restart.test.ts#the D-32 scenario"
        status: pass
    human_judgment: false
  - id: D4
    description: "collectLeaseIntervals/findOverlappingLeases reconstruct lease spans from the append-only feature_events log and detect an overlap that a final-state snapshot could not see"
    verification:
      - kind: integration
        ref: "packages/manager/test/scenario/concurrency-crash-restart.test.ts#the D-32 scenario (findOverlappingLeases assertion)"
        status: pass
    human_judgment: false
  - id: D5
    description: "No platform-gated case in packages/manager/test/ or packages/cli/test/ skips via a bare process.platform/skipIf check outside the sanctioned helper, and the non-Linux CI leg is proven (not merely asserted to exist) to run the manager and CLI suites"
    requirement: "EXEC-03"
    verification:
      - kind: unit
        ref: "test/platform-gate-discipline.test.ts#no bare platform conditional outside the helper"
        status: pass
      - kind: unit
        ref: "test/ci-matrix.test.ts#the non-Linux test step runs pnpm -r test"
        status: pass
    human_judgment: false
  - id: D6
    description: "packages/manager/README.md and packages/cli/README.md document the daemon config keys, the schema-version refusal/pre-migration-copy behavior, the Windows PID-reuse boot-orphan-kill degradation, the IPC-then-SIGKILL worker-stop mechanism, and the CLI's six verbs / three blast radii / --all confirmation rule"
    verification: []
    human_judgment: true
    rationale: "Documentation quality and completeness against 03-CONTEXT.md D-33's stated requirements is a human editorial judgment, not something an automated test asserts on."

duration: 24min
completed: 2026-08-20
status: complete
---

# Phase 3 Plan 09: The D-32 Scenario — Concurrency 3, One SIGKILL, One Restart Summary

**One scenario test proves the whole phase's recovery guarantees hold together — three real leased features, one worker SIGKILLed mid-run, the daemon genuinely restarted against real orphaned processes — plus the platform-gate discipline audit and the operator-facing manager/CLI READMEs that close out the phase.**

## Performance

- **Duration:** ~24 min (base commit 07:16:25+02:00, last task commit 07:39:39+02:00)
- **Started:** 2026-08-20T07:16:25+02:00
- **Completed:** 2026-08-20T07:39:39+02:00
- **Tasks:** 2
- **Files modified:** 8 (5 created, 3 modified)

## Accomplishments

- `packages/manager/test/scenario/concurrency-crash-restart.test.ts`: three features get a real git worktree, a real developer commit, and a real `usage_events` row each, then are leased and forked simultaneously (`concurrency.global: 3`, three real `dispatchOnce` calls). One worker is `SIGKILL`ed directly and recovered by the child-exit fast path while "daemon 1" is still alive. The other two are orphaned by severing "daemon 1"'s listeners on their live `ChildProcess` handles (simulating the manager process itself dying, not a graceful shutdown) and then recovered by a real, unmodified `startDaemon()` call — the actual production boot sequence (schema gate, D-35 reconciliation, D-13's boot orphan kill, D-13's unconditional lease expiry) booting against the same on-disk database. All five D-32 closing assertions are proven in one test: every feature accounted for with no expired lease held, every commit (including the killed feature's) still reachable on its branch, `usage_events` byte-identical before/after, zero orphan worktrees for a feature driven to `abandoned` after a real GC pass (while the other two features' worktrees survive), and zero overlapping lease intervals proven from the append-only `feature_events` log via the new `lease-audit.ts` helper. A Linux-only gate (`requirePlatform`) additionally proves the two orphaned processes are actually `SIGKILL`ed by the boot orphan kill where `/proc` makes that attributable; the scenario's own teardown independently reclaims any surviving process on every platform, so no live process ever leaks out of this file (T-3-36).
- `packages/manager/test/helpers/lease-audit.ts`: `collectLeaseIntervals` reconstructs each feature's lease spans from its `lease_acquired`/`lease_expired` `feature_events` rows (naive pairing — a second acquisition before a close is recorded as still-open rather than silently closed, so the reconstruction cannot paper over the exact anomaly it exists to catch); `findOverlappingLeases` flags any two same-feature intervals whose time spans intersect.
- `packages/manager/test/helpers/held-worker-entry.ts` + `worker-harness.ts`'s new `withHeldWorker()`: a worker double whose `stageRunner` promise never resolves, giving any scenario a deterministic mid-run kill hook — `ADL_TEST_STAGE_DELAY_MS` (the existing `scripted-worker-entry.ts` double's timing knob) never actually reaches a child forked through `createSupervisor.spawn`, since that call site passes no `env` override to `forkWorker`.
- `test/platform-gate-discipline.test.ts`: scans every test file under `packages/manager/test/` and `packages/cli/test/` and fails, naming the offending file and line, on a bare `process.platform`/`os.platform()`/`.skipIf`-family check outside `helpers/platform.ts` — the audit turned up zero offenders; every existing platform-gated case already routes through `requirePlatform`/`windowsOnly`/`posixOnly`, and nothing under `test/control/` (03-07's worker-stop tests) skips on any platform.
- `test/ci-matrix.test.ts` gains two assertions: the non-Linux leg's test step literally runs `pnpm -r test` (not a scoped subset), and `@adl/manager`/`@adl/cli` are real workspace packages with their own `test` script for that recursive command to reach.
- `packages/manager/README.md` (rewritten) and `packages/cli/README.md` (new): operator-facing documentation covering the daemon config file and every key, the startup sequence including the schema-version refusal and what to do when you see one, the Windows PID-reuse boot-orphan-kill degradation, the soft_stop-then-`SIGKILL` worker-stop mechanism and why not `SIGTERM`, and the CLI's six verbs, three blast radii, and `--all` confirmation rule.

## Task Commits

Each task was committed atomically:

1. **Task 1: The concurrency-3 crash-and-restart scenario** - `69bef15` (feat)
2. **Task 2: Both CI legs green, every skip attributed, and the degradations documented** - `01cfb19` (docs)

**Plan metadata:** committed with this SUMMARY (worktree mode — orchestrator commits STATE.md/ROADMAP.md centrally after the wave)

## Files Created/Modified

- `packages/manager/test/scenario/concurrency-crash-restart.test.ts` — the D-32 scenario
- `packages/manager/test/helpers/lease-audit.ts` — `collectLeaseIntervals`, `findOverlappingLeases`, `LeaseInterval`, `LeaseOverlap`
- `packages/manager/test/helpers/held-worker-entry.ts` — the never-completes worker double
- `packages/manager/test/helpers/worker-harness.ts` — `heldWorkerEntry`, `withHeldWorker`
- `test/platform-gate-discipline.test.ts` — the bare-platform-conditional scan
- `test/ci-matrix.test.ts` — two new assertions on the non-Linux leg's `pnpm -r test` reach
- `packages/manager/README.md` — rewritten for an operator (daemon config, startup sequence, Windows degradation, worker-stop mechanism)
- `packages/cli/README.md` — new (six verbs, three blast radii, confirmation rule, config resolution)

## Decisions Made

See `key-decisions` in the frontmatter — five decisions, covering why "daemon 1" is manually assembled rather than a live `startDaemon()` handle, why all three scenario workers use the new held double, how the GC-pass assertion gets a terminal-state subject with no gate pipeline yet to produce one naturally, why the process-kill assertion is Linux-gated while the state-recovery assertions are not, and why `.github/workflows/ci.yml` needed no change.

## Deviations from Plan

None — plan executed exactly as written. The plan's own `files_modified` list named `.github/workflows/ci.yml`; no edit to it was needed once a full local Windows run turned up no genuine cross-platform failure, which the plan's own Task 2 text anticipates ("Where a genuine cross-platform failure appears, fix it rather than gating it" — none appeared).

## Issues Encountered

- **`ADL_TEST_STAGE_DELAY_MS` does not reach a child forked through `createSupervisor.spawn`.** Existing tests (`test/control/kill.test.ts`) set this env var on `process.env` before spawning, but `createSupervisor`'s own `forkWorker` call passes no `env` option, and `node:child_process.fork()`'s `env` option — when supplied at all, even implicitly via `@adl/workspace`'s allowlist-only `buildWorkerEnv` — replaces rather than merges with `process.env`, so the variable never crosses into the child. This is harmless for those existing tests (their assertions tolerate the double's default ~150ms delay either way) but would have made this scenario's SIGKILL timing a race rather than a certainty. Resolved by building a new worker double (`held-worker-entry.ts`) whose stage never completes on its own, removing the timing dependency entirely rather than plumbing the env var through production code the plan's file list did not include.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Phase 3's five ROADMAP success criteria are now all covered by an automated test, and the D-32 interaction scenario proves them together rather than only individually: `adl status` (03-08), `SIGKILL` recovery within the lease TTL (03-05, reinforced here), fencing against a zombie's stale write (03-05), state/rounds/spend surviving a daemon restart (03-06, reinforced here), and pause/kill/concurrency (03-07).
- `EXEC-05` (configurable concurrency, default 1) and `EXEC-06` (state/rounds/spend/transcripts survive a daemon restart) are marked complete in `REQUIREMENTS.md` by this plan — `EXEC-03` was already complete from `03-05` and is reinforced by this plan's concurrency-3 interaction proof.
- `held-worker-entry.ts`/`withHeldWorker()` is a reusable addition to `worker-harness.ts` for any future test that needs a worker guaranteed to still be mid-round at a specific point — not scenario-specific.
- No blockers for Phase 4. Phase 3 (manager skeleton, state, leases, API, CLI) is now feature-complete against its ROADMAP entry; the phase's own `/gsd-verify-work` and transition steps are the orchestrator's next move, not this plan's.

---

_Phase: 03-manager-skeleton-state-leases-api-cli_
_Completed: 2026-08-20_

## Self-Check: PASSED

All key files (`packages/manager/test/scenario/concurrency-crash-restart.test.ts`,
`packages/manager/test/helpers/lease-audit.ts`,
`packages/manager/test/helpers/held-worker-entry.ts`,
`test/platform-gate-discipline.test.ts`, `packages/cli/README.md`) verified
present on disk. Both task commits (`69bef15`, `01cfb19`) verified present in
`git log`.
