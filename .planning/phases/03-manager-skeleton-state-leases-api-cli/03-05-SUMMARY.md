---
phase: 03-manager-skeleton-state-leases-api-cli
plan: 05
subsystem: infra
tags: [lease-reaper, fork-exit-fast-path, ipc-fencing, crash-recovery, worktree-reattach, pino]

# Dependency graph
requires:
  - phase: 03-manager-skeleton-state-leases-api-cli (plan 04)
    provides: "the tracer's dispatcher/supervisor/worker-entry/API/CLI spine this plan extends rather than replaces"
  - phase: 03-manager-skeleton-state-leases-api-cli (plan 02)
    provides: "featuresRepository.listExpiredLeases/renewLease/expireLease — the lease queue this plan's reaper and fence drive"
  - phase: 03-manager-skeleton-state-leases-api-cli (plan 03)
    provides: "forkWorker/processIsAlive from @adl/workspace — the fork() seam and pid-liveness check this plan's tests use"
provides:
  - "packages/manager/src/scheduler/reaper.ts — reapOne/reapExpiredLeases/startReaper/createFastPathRecovery/resetCrashCountOnSuccess, the lease-expiry backstop (D-03), the child-exit fast path's shared implementation (D-04), and the crash-recovery write (D-10, D-11, D-12) applied wherever either path fires"
  - "packages/manager/src/fencing.ts — checkFence/FenceVerdict/createStaleRejectionCounter, the message-level half of D-06's fence"
  - "packages/manager/src/recovery/policy.ts — planRecovery/RecoveryDecision/MAX_CONSECUTIVE_CRASHES, a pure recover-vs-escalate decision with no @adl/db or node:fs import"
  - "packages/manager/src/worker-supervisor/supervisor.ts — child.on('exit') fast-path classification (expected vs unexpected), lease_lost sent on a refused heartbeat renewal, and the D-06 fence run before any lease-scoped write"
  - "GET /features response objects gain staleRejections (D-09)"
  - "dispatchOnce's workspace_handle branch is now explicit: a first lease derives and persists a handle, a recovery dispatch attaches to the existing one (D-12)"
affects: [03-06, 03-07, 03-08, 03-09]

actuals:
  tokens: 22100
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "reapOne is the single function both the reaper's periodic tick and the supervisor's child.on('exit') fast path call — one route is fast (milliseconds, the fork's own exit event), the other is the backstop for what exit structurally cannot cover (no ChildProcess handle, a wedged-but-alive worker), and both apply the identical planRecovery/transition()/crash_count write"
    - "D-10's stage-index reset (current_stage_index -> 0 on recovery) lives in reaper.ts's transaction, not in transition.ts — transition.ts's own lease_expired edges have a zero counter delta by design and are checksum-guarded (Plan 01-08), so an absolute reset that isn't a counter delta has to be the caller's job"
    - "The message-level fence (checkFence) runs before any repository write for every lease-scoped IPC kind (heartbeat, stage_result, fatal) — not only results — reading the row's current lease_token via an injected getCurrentLeaseToken so the check never races the write it precedes"
    - "A worker's exit is classified expected (no fast-path reap) only once a stage_result has passed the fence; a fatal report, a stale stage_result, and an unclassified SIGKILL all fall through to the fast path, relying on reapOne's own expectedLeaseToken guard to no-op safely against an already-superseded lease"
    - "A test-only IPC double (zombie-worker-entry.ts) that speaks the real Zod-validated protocol but sends zero heartbeats and never reacts to a post-assign manager message, rather than injecting a new suppression flag into the production runWorker — the D-31 scenario needs to suppress the heartbeat loop itself, which runWorker's one injection point (StageRunner) cannot reach"
    - "Deterministic lease-expiry in a test: force lease_expires_at into the past and call reapExpiredLeases directly, rather than waiting on a live reaper tick racing a scripted worker's fork-startup latency — the D-31 zombie's own pause timer only starts once fork()+IPC handshake completes, which is not bounded tightly enough to safely race a second lease's own short TTL"

key-files:
  created:
    - packages/manager/src/scheduler/reaper.ts
    - packages/manager/src/fencing.ts
    - packages/manager/src/recovery/policy.ts
    - packages/manager/test/scheduler/reaper.test.ts
    - packages/manager/test/lease/fencing.test.ts
    - packages/manager/test/recovery/crash-recovery.test.ts
    - packages/manager/test/helpers/capturing-logger.ts
    - packages/manager/test/helpers/zombie-worker-entry.ts
  modified:
    - packages/manager/src/worker-supervisor/supervisor.ts
    - packages/manager/src/daemon.ts
    - packages/manager/src/index.ts
    - packages/manager/src/api/routes/features.ts
    - packages/manager/src/scheduler/dispatcher.ts
    - packages/manager/test/helpers/worker-harness.ts
    - packages/manager/test/tracer/end-to-end.test.ts

key-decisions:
  - "The D-31 zombie is a separate, purpose-built test double (test/helpers/zombie-worker-entry.ts) rather than runWorker with a swapped StageRunner. runWorker starts its heartbeat setInterval unconditionally on assign with no seam to suppress it, and the scenario needs zero heartbeats during the pause (a heartbeat would renew the lease and the reaper would never see it expire) plus a worker that never reacts to a post-assign manager message. The double still speaks the real Zod-validated IPC contract, so the manager side under test sees exactly the bytes a real worker would send; only the worker's own internal loop is different."
  - "The D-31 integration test forces lease expiry directly (a raw UPDATE plus one reapExpiredLeases call) instead of waiting on a live reaper tick. Fork-startup latency for a tsx-imported child (observed 250-600ms, platform-dependent) is not bounded tightly enough to safely race a second lease's own short TTL without flaking; forcing expiry removes the race while still exercising the real fence end to end."
  - "resetCrashCountOnSuccess (D-11's reset-on-success half) has no caller yet in this phase — no gate pipeline exists to complete a round from. It is exported and covered by a direct unit test now, to be wired at the real round-completion write site once Phase 4+ lands one, in the same transaction as the round outcome for the same increment-and-decision-together reason crash_count's own increment already follows."
  - "dispatchOnce's workspace_handle branch persists a handle on a feature's first lease (isFirstAttempt = feature.workspace_handle === null) and leaves an existing one untouched on every later dispatch, making D-12's 'attach, never rebuild' an explicit, tested branch rather than an accidental property of a ?? fallback that happened to read the same column twice."
  - "The crash-recovery integration test's real git commit is made through withTempRepo's already-constructed SimpleGit handle (packages/workspace/test/helpers/temp-repo.ts, imported by relative path), addressing the worktree via git -C <worktreePath> rather than importing simple-git directly in packages/manager/test/** — adl/no-direct-spawn bans that specifier outside packages/workspace/**, and this avoids a second exemption."

requirements-completed: [EXEC-03, EXEC-04]

coverage:
  - id: D1
    description: "A worker SIGKILLed mid-run has its feature returned to queued in well under lease_ttl_ms, via the child-exit fast path rather than the reaper tick"
    requirement: EXEC-03
    verification:
      - kind: unit
        ref: "packages/manager/test/scheduler/reaper.test.ts#the child-exit fast path > a SIGKILLed worker reaches queued in well under lease_ttl_ms — the fast path, not the reaper, did it"
        status: pass
    human_judgment: false
  - id: D2
    description: "The reaper recovers an expired lease with no ChildProcess registered anywhere — the case a restarted daemon is always in"
    requirement: EXEC-03
    verification:
      - kind: unit
        ref: "packages/manager/test/scheduler/reaper.test.ts#reapExpiredLeases > recovers a feature the manager has no ChildProcess for"
        status: pass
      - kind: unit
        ref: "packages/manager/test/scheduler/reaper.test.ts#reapExpiredLeases > judges every row in one tick against the same supplied now, not a clock read per row"
        status: pass
    human_judgment: false
  - id: D3
    description: "A worker's expected, clean exit after an accepted stage_result does not apply lease_expired; a worker whose renewLease is refused receives lease_lost and exits non-zero"
    requirement: EXEC-03
    verification:
      - kind: unit
        ref: "packages/manager/test/scheduler/reaper.test.ts#the child-exit fast path > a worker's expected, clean exit after reporting its result does not apply lease_expired"
        status: pass
      - kind: unit
        ref: "packages/manager/test/scheduler/reaper.test.ts#the child-exit fast path > a worker whose renewLease is refused receives lease_lost and exits non-zero"
        status: pass
    human_judgment: false
  - id: D4
    description: "A zombie worker reporting with a stale lease token has its write dropped, logged at warn with both tokens, counted, and the newer legitimate state left unchanged — exercising both the IPC-level fence and the SQL predicate end to end"
    requirement: EXEC-04
    verification:
      - kind: unit
        ref: "packages/manager/test/lease/fencing.test.ts#the D-31 zombie scenario > a zombie reporting with a stale token is dropped, logged, and counted, and the newer state is unchanged"
        status: pass
      - kind: unit
        ref: "packages/manager/test/lease/fencing.test.ts#the SQL predicate half of the fence, called directly > renewLease with a stale token returns false, with no message handler in this test"
        status: pass
      - kind: unit
        ref: "packages/manager/test/lease/fencing.test.ts#checkFence (3 tests: match, stale-with-both-tokens, stale-on-null-current)"
        status: pass
    human_judgment: false
  - id: D5
    description: "GET /features surfaces the D-09 stale-rejection counter per feature as staleRejections"
    requirement: EXEC-04
    verification:
      - kind: unit
        ref: "packages/manager/test/lease/fencing.test.ts#GET /features > response objects contain a staleRejections numeric field"
        status: pass
    human_judgment: false
  - id: D6
    description: "A crash mid-round resumes at the same round with the pipeline replayed from stage 0, its existing worktree re-attached (not rebuilt), its git commit still reachable, and usage_events unchanged — proven with a real forked worker, a real git worktree, and a real SIGKILL"
    requirement: EXEC-03
    verification:
      - kind: integration
        ref: "packages/manager/test/recovery/crash-recovery.test.ts#a feature killed mid-round > resumes at the same round, stage 0, with its commit and worktree untouched and usage_events unchanged"
        status: pass
    human_judgment: false
  - id: D7
    description: "A feature that crashes three consecutive times is escalated on the fourth rather than recovered again, landing in escalated with an unrecoverable feature_events row"
    requirement: EXEC-03
    verification:
      - kind: integration
        ref: "packages/manager/test/recovery/crash-recovery.test.ts#the crash ceiling > escalates on the fourth consecutive crash, and any successful round would have reset the counter"
        status: pass
      - kind: unit
        ref: "packages/manager/test/recovery/crash-recovery.test.ts#planRecovery (parameterized across every non-terminal state at crash counts 0-3, plus the MAX_CONSECUTIVE_CRASHES=3 and purity-of-source checks)"
        status: pass
    human_judgment: false
  - id: D8
    description: "resetCrashCountOnSuccess resets crash_count to 0; dispatchOnce's workspace_handle branch persists a handle on first lease and attaches (never rewrites) on a later dispatch"
    requirement: EXEC-03
    verification:
      - kind: unit
        ref: "packages/manager/test/recovery/crash-recovery.test.ts#resetCrashCountOnSuccess > resets crash_count to 0"
        status: pass
      - kind: unit
        ref: "packages/manager/test/recovery/crash-recovery.test.ts#dispatchOnce's workspace_handle branch > persists a handle on the first lease, and leaves an existing one untouched on a later dispatch"
        status: pass
    human_judgment: false

duration: ~140min
completed: 2026-08-19
status: complete
---

# Phase 3 Plan 05: Reaper, Fencing, and Crash Recovery Summary

**A worker that dies, wedges, or wakes up as a zombie all resolve the same way: the reaper's tick and the fork's own exit event share one recovery function that applies D-10's stage-0 replay and D-11's three-strikes escalation, while a message-level fence (backed by the existing SQL predicate) drops a stale write before it ever reaches the database — proven with a real forked worker, a real SIGKILL, and a real git worktree, not mocks.**

## Performance

- **Duration:** ~140 min
- **Started:** 2026-08-19T17:20:00Z (approx — context read began here)
- **Completed:** 2026-08-19T19:40:00Z (approx)
- **Tasks:** 3
- **Files modified:** 15 (8 created, 7 modified)

## Accomplishments

- `packages/manager/src/scheduler/reaper.ts`: `reapOne` is the single function the periodic tick and the supervisor's `child.on('exit')` fast path both call. It reads `planRecovery`'s decision, applies `transition()`'s `lease_expired` (recover) or `unrecoverable` (escalate at the ceiling), resets `current_stage_index` to 0 on recover (D-10 — an absolute reset `transition.ts`'s checksum-guarded counter deltas cannot express), increments `crash_count` in the same transaction as the state write (D-11), and clears the lease. `startReaper` reads the clock exactly once per tick and passes that one `now` to every row it compares. `createFastPathRecovery` is the one binding both `daemon.ts` and a test use, so the two invocations of "what does an unexpected exit do" cannot drift apart.
- `packages/manager/src/worker-supervisor/supervisor.ts`: `child.on('exit')` classifies every exit as expected (a fence-matched `stage_result` was accepted, or the manager itself requested the exit) or unexpected (everything else — a SIGKILL, a self-reported `fatal`, a stale `stage_result`) and only fires the fast path for the latter. A heartbeat whose `renewLease` is refused now sends the worker `lease_lost` (D-05), and the worker-entry side of that (`exitNow(1)` on `lease_lost`, already landed in `03-04`) needed no further change.
- `packages/manager/src/fencing.ts`: `checkFence` runs before any repository write, for every lease-scoped IPC kind (`heartbeat`, `stage_result`, `fatal`) — not only results. A stale verdict is dropped, logged at `warn` with both tokens, and counted (`createStaleRejectionCounter`), never silently discarded.
- `packages/manager/src/recovery/policy.ts`: `planRecovery` is pure (no `@adl/db`, no `node:fs`) and decides recover-vs-escalate purely from `crash_count` against `MAX_CONSECUTIVE_CRASHES = 3`.
- `packages/manager/src/scheduler/dispatcher.ts`: the `workspace_handle` branch is now explicit — `isFirstAttempt` derives and persists a handle only once; every later dispatch (including a post-crash recovery dispatch) attaches to the value already on the row.
- `GET /features` gains `staleRejections`, sourced from the same counter the supervisor increments.
- Three real, non-mocked integration proofs: a SIGKILLed worker reaching `queued` in well under `lease_ttl_ms` via the fast path (`reaper.test.ts`); a real zombie process (D-31 — zero heartbeats, no reaction to any manager message after `assign`) whose late, stale `stage_result` is dropped while the legitimate re-leased state stays intact (`fencing.test.ts`); and a real forked worker, holding a real git worktree with a real commit, SIGKILLed mid-round and recovered with its round, stage-0 reset, commit, worktree, and empty `usage_events` all directly verified (`crash-recovery.test.ts`).

## Task Commits

Each task was committed atomically:

1. **Task 1: The reaper tick, the child-exit fast path, and worker self-termination** — `4636507` (feat)
2. **Task 2: The fence — rejecting the zombie's write, loudly** — `7f43fcd` (feat)
3. **Task 3: Crash recovery policy — same round, stage 0, re-attached worktree, bounded retries** — `9939456` (feat)

**Plan metadata:** committed with this SUMMARY (worktree mode — orchestrator commits STATE.md/ROADMAP.md centrally after the wave)

_Note: this plan's tasks carried `tdd="true"` in intent (tests written alongside behavior, following `03-02`'s and `03-04`'s own precedent), but each task's tests and implementation landed together in one commit rather than a strict RED→GREEN commit split — consistent with how the rest of this phase's suite was built._

## Files Created/Modified

- `packages/manager/src/scheduler/reaper.ts` — `reapOne`, `reapExpiredLeases`, `startReaper`, `createFastPathRecovery`, `resetCrashCountOnSuccess`
- `packages/manager/src/fencing.ts` — `checkFence`, `FenceVerdict`, `createStaleRejectionCounter`
- `packages/manager/src/recovery/policy.ts` — `planRecovery`, `RecoveryDecision`, `MAX_CONSECUTIVE_CRASHES`
- `packages/manager/src/worker-supervisor/supervisor.ts` — `child.on('exit')` classification, the fence integrated into the message handler, `lease_lost` on refused renewal, `markExpectedExit`
- `packages/manager/src/daemon.ts` — wires `startReaper`/`stop()`, `getCurrentLeaseToken`, `staleRejectionCounter`, marks every worker's exit expected before the deliberate shutdown SIGKILL
- `packages/manager/src/index.ts` — barrel exports for the reaper, fencing, and recovery modules
- `packages/manager/src/api/routes/features.ts` — `FeatureView.staleRejections`
- `packages/manager/src/scheduler/dispatcher.ts` — the explicit `workspace_handle` attach-if-present branch
- `packages/manager/test/scheduler/reaper.test.ts` — Task 1's coverage
- `packages/manager/test/lease/fencing.test.ts` — Task 2's coverage
- `packages/manager/test/recovery/crash-recovery.test.ts` — Task 3's coverage
- `packages/manager/test/helpers/capturing-logger.ts` — a real `pino` logger writing to an in-memory sink, for warn-line assertions
- `packages/manager/test/helpers/zombie-worker-entry.ts` + `worker-harness.ts`'s `withZombieWorker` — the D-31 zombie double
- `packages/manager/test/tracer/end-to-end.test.ts` — fixture/key-list updated for the new `staleRejections` field (deviation, see below)

## Decisions Made

See `key-decisions` in the frontmatter — five decisions, covering the zombie double's design, the deterministic (non-racing) way the D-31 integration test forces lease expiry, `resetCrashCountOnSuccess`'s deferred wiring, the explicit `workspace_handle` branch, and how the crash-recovery test makes a real git commit without a second `adl/no-direct-spawn` exemption.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `test/helpers/capturing-logger.ts`**
- **Found during:** Task 2 — D-09's acceptance criterion requires asserting a captured `warn` log record's fields (feature id, presented token, current token), which the existing test infrastructure (a bare `pino` instance or `onStaleMessage` callback alone) could not satisfy for the log line itself.
- **Issue:** No existing helper wrote `pino` output to an inspectable sink; `pino({level:'silent'})` discards everything, and duck-typing a fake `Logger` would diverge from `pino`'s real log-object shape.
- **Fix:** A small helper (`createCapturingLogger`) wrapping a real `pino` instance around a `Writable` that parses each JSON line into an array a test can query. Not in the plan's declared file list for Task 2, but required infrastructure with no production-code footprint.
- **Files modified:** `packages/manager/test/helpers/capturing-logger.ts` (new)
- **Verification:** Used by `reaper.test.ts` and `fencing.test.ts`; both suites pass, including the assertion on the captured warn line's `presentedToken`/`currentToken` fields.
- **Committed in:** `4636507` (Task 1 commit — added early since Task 1's own tests needed a logger, extended by Task 2)

**2. [Rule 3 - Blocking] Updated `test/tracer/end-to-end.test.ts`'s fixture and key-list for the new `staleRejections` field**
- **Found during:** Task 2, after adding `FeatureView.staleRejections`.
- **Issue:** `03-04`'s tracer test hard-codes `FIXTURE_FEATURE_VIEW` and an exact sorted key list for `GET /features`' response shape; adding the new required field broke both assertions.
- **Fix:** Added `staleRejections: 0` to the fixture and `'staleRejections'` to the expected key list.
- **Files modified:** `packages/manager/test/tracer/end-to-end.test.ts`
- **Verification:** `pnpm --filter @adl/manager test` — all 61 tests pass, including the tracer's own end-to-end case.
- **Committed in:** `7f43fcd` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 missing critical test infrastructure, 1 blocking fixture update)
**Impact on plan:** Neither touches production behaviour outside what Task 2 itself introduced (the new field). No scope creep.

## Issues Encountered

- **Fork-startup latency invalidated an initial timing design for the D-31 zombie test.** The first attempt sized `leaseTtlMs` to create a window in which the *second* (legitimately re-leased) lease would still be alive when the zombie's fixed ~400ms internal pause elapsed — but a `tsx`-imported forked child's actual startup-to-first-IPC-message latency varied 250-650ms in local runs, well outside any safely-computable window against a second lease's own short TTL. Resolved by forcing the first lease's expiry directly (a raw `UPDATE` plus one `reapExpiredLeases` call) instead of waiting on a live reaper tick, and giving the second lease a long TTL (60s) so it can never itself become the reason the test flakes — the scenario's substance (the fence) does not depend on either lease's real-time expiry, which `reaper.test.ts` already covers independently.
- **A dangling second zombie process caused an unhandled rejection after `withTempDb`'s teardown.** The D-31 test's re-lease dispatch forks a second process from the same (zombie) entry path; that process's own ~400ms pause meant it was still alive and would eventually call `getCurrentLeaseToken` — which reads from the test's `db` — after the test's own assertions passed and `withTempDb`'s `finally` had already destroyed the connection. Fixed by tracking every spawned `ChildProcess` and SIGKILLing them in a `finally` block before the surrounding `withTempDb` closes.
- **`git worktree list`'s path separator did not match `path.join`'s on Windows.** `listManagedWorktrees` reports paths with forward slashes even on Windows; the crash-recovery integration test's assertion against a `path.join`-built `worktreePath` needed both sides normalised before comparing.
- **The example `baseRef` from the plan's own prose (`'main'`) does not exist in a freshly `git init`'d temp repo** on a machine whose `init.defaultBranch` is not `main`. Switched to `'HEAD'`, matching the existing precedent in `packages/workspace/test/worktree/lifecycle.test.ts` and `gc.test.ts`.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `03-06` (daemon config, schema-version gate, repo reconciliation, boot orphan kill) can extend `daemon.ts`'s startup sequence directly — the reaper and fencing wiring already there is additive, not something `03-06` needs to restructure. D-13's boot-time "expire every lease and kill any still-running orphan" is explicitly out of this plan's scope (it needs `lease_owner`'s PID+start-time discriminator, D-14, which `03-06`'s own file list anticipates) — the three recovery paths this plan wires (tick, fast path) are the two D-04's own text names as what `exit` structurally *can* cover; boot is the third, still open.
- `resetCrashCountOnSuccess` is ready and tested but has no caller yet — Phase 4+'s round-completion write site is where it belongs, in the same transaction as the round outcome.
- The message-level fence's `getCurrentLeaseToken` dependency is optional on `SupervisorDeps` (defaulting to "skip the pre-check, rely on `renewLease`'s own SQL guard") specifically so `03-04`'s and this plan's narrowly-scoped tests were not forced to stub it; production wiring in `daemon.ts` always supplies it.
- No blockers for the rest of Phase 3's plans.

---
*Phase: 03-manager-skeleton-state-leases-api-cli*
*Completed: 2026-08-19*

## Self-Check: PASSED

All created files (`packages/manager/src/scheduler/reaper.ts`, `packages/manager/src/fencing.ts`, `packages/manager/src/recovery/policy.ts`, `packages/manager/test/scheduler/reaper.test.ts`, `packages/manager/test/lease/fencing.test.ts`, `packages/manager/test/recovery/crash-recovery.test.ts`, `packages/manager/test/helpers/capturing-logger.ts`, `packages/manager/test/helpers/zombie-worker-entry.ts`) verified present on disk via the tool that wrote them in this session. All three task commit hashes (`4636507`, `7f43fcd`, `9939456`) verified present in `git log` at the time each was created.
