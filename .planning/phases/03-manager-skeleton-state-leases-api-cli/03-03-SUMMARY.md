---
phase: 03-manager-skeleton-state-leases-api-cli
plan: 03
subsystem: infra
tags: [fork, child_process, ipc, eslint, no-restricted-imports, workspace-boundary]

# Dependency graph
requires:
  - phase: 03-manager-skeleton-state-leases-api-cli
    provides: "03-01's @adl/manager/@adl/cli scaffolding; 02's run()/buildChildEnv/WorkspaceError discipline this plan restates for a second launcher"
provides:
  - "forkWorker/ForkedWorker/ForkWorkerOptions/WORKER_ENV_ALLOWLIST — the manager→worker fork() seam, exported from @adl/workspace's barrel"
  - "A measured (not argued) proof that the spawn-ban exemption count stays at exactly one after adding a second sanctioned process-launch primitive"
  - "An updated Phase 2 T-2-40 contract guard (workspace-contract.test.ts) that recognises fork.ts as the second sanctioned launcher"
affects: [03-04, 03-05, 03-06, 03-07, 03-08, 03-09]

actuals:
  tokens: 8900
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "A second process-launch primitive inside packages/workspace is a sibling file (fork.ts beside run.ts), never a modification of the existing one, and is proven — not just argued — to stay inside the one adl/no-direct-spawn exemption via a resolved-config count assertion"
    - "A forked worker's environment is built from a small named allowlist (WORKER_ENV_ALLOWLIST: PATH, plus SystemRoot on win32) merged with caller-supplied env — restating buildChildEnv's zero-inherit discipline for a boundary with no scratch HOME or git-config neutralisation to apply"
    - "fork() does not validate its entry module synchronously or raise a spawn-level 'error' event for a missing path — verified locally (exit(1,null), no 'error' event) — so forkWorker synchronously existsSync-checks and queueMicrotask-emits a WorkspaceError-wrapped 'error' event naming the path"

key-files:
  created:
    - packages/workspace/src/exec/fork.ts
    - packages/workspace/test/exec/fork.test.ts
    - packages/workspace/test/fixtures/echo-worker.js
    - test/lint/fixtures/manager-fork-direct.ts
  modified:
    - packages/workspace/src/index.ts
    - packages/workspace/test/contract/workspace-contract.test.ts
    - test/lint/no-restricted-imports.test.ts
    - eslint.config.js

key-decisions:
  - "WORKER_ENV_ALLOWLIST is its own small list (PATH; +SystemRoot on win32) rather than a reuse of env.ts's buildChildEnv — the latter is scoped to an ExecSpec and to scratch-HOME/git-config neutralisers a worker fork has no use for, since the worker is ADL's own code, not an agent's."
  - "forkWorker detects a missing entry module via a synchronous existsSync check and reports it through a queueMicrotask-deferred 'error' event on the child, because fork() itself never raises a native spawn-level error for this case (verified empirically: exit(1, null), no 'error' event) — the failure only otherwise surfaces as an opaque non-zero exit."
  - "packages/workspace/test/contract/workspace-contract.test.ts (Phase 2's T-2-40 guard, previously hard-coded to 'exactly one module may launch a process') was updated to recognise fork.ts as a second SANCTIONED launcher rather than left stale or dropped — its whole purpose (catch a THIRD, unreviewed launcher) still needed a live assertion after this plan's deliberate second one landed."
  - "WORKSPACE_EXEMPTION in eslint.config.js gained an `export` keyword (Task 2's own escape hatch, used because the count assertion could not otherwise be expressed against the exported config shape without duplicating the glob string) — no rule, glob, or severity changed, confirmed by `git diff eslint.config.js` showing only the export addition."

requirements-completed: [EXEC-02]

coverage:
  - id: D1
    description: "forkWorker starts a real child Node process with a live IPC channel: send/receive round-trips, stdout/stderr are piped rather than inherited, and the pid is exposed"
    requirement: EXEC-02
    verification:
      - kind: unit
        ref: "packages/workspace/test/exec/fork.test.ts#forkWorker > opens a live IPC channel: a sent message reaches the child and its reply reaches a parent listener"
        status: pass
      - kind: unit
        ref: "packages/workspace/test/exec/fork.test.ts#forkWorker > pipes stdout and stderr to the caller rather than inheriting the daemon's own streams"
        status: pass
      - kind: unit
        ref: "packages/workspace/test/exec/fork.test.ts#forkWorker > exposes the child's pid"
        status: pass
    human_judgment: false
  - id: D2
    description: "The forked worker's environment is constructed explicitly (WORKER_ENV_ALLOWLIST + options.env) — a variable set in the parent and not named is absent from the child"
    requirement: EXEC-02
    verification:
      - kind: unit
        ref: "packages/workspace/test/exec/fork.test.ts#forkWorker > constructs the child environment from the allowlist plus options.env — a parent-only variable never crosses"
        status: pass
      - kind: unit
        ref: "packages/workspace/test/exec/fork.test.ts#forkWorker > carries an explicit options.env entry through to the child"
        status: pass
    human_judgment: false
  - id: D3
    description: "Forking a path that does not exist emits a discoverable error naming that path, rather than leaving the handle in an indeterminate state"
    requirement: EXEC-02
    verification:
      - kind: unit
        ref: "packages/workspace/test/exec/fork.test.ts#forkWorker > rejects or emits an error carrying the path when the entry module does not exist"
        status: pass
    human_judgment: false
  - id: D4
    description: "A direct fork/child_process import from packages/manager (or anywhere outside packages/workspace) is a lint error, and the exemption that lets fork.ts import it stays at exactly one entry"
    requirement: EXEC-02
    verification:
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts#architecture rules fail on deliberate violations > test/lint/fixtures/manager-fork-direct.ts is reported by no-restricted-imports"
        status: pass
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts#the fork() seam does not need — and did not receive — a second exemption > packages/workspace/src/exec/fork.ts lints clean under the spawn ban rule ids"
        status: pass
      - kind: unit
        ref: "test/lint/no-restricted-imports.test.ts#the fork() seam does not need — and did not receive — a second exemption > exactly one flat-config entry clears the spawn rules for packages/workspace, and its glob names it"
        status: pass
      - kind: other
        ref: "pnpm lint (repo-wide, exit 0); git diff eslint.config.js shows only a named-export addition"
        status: pass
    human_judgment: false
  - id: D5
    description: "The pre-existing Phase 2 T-2-40 contract guard (workspace-contract.test.ts) still holds after a second sanctioned launcher was added"
    requirement: EXEC-02
    verification:
      - kind: unit
        ref: "packages/workspace/test/contract/workspace-contract.test.ts#exactly the sanctioned modules in this package can launch a process (all rows)"
        status: pass
    human_judgment: false

duration: 51min
completed: 2026-08-19
status: complete
---

# Phase 3 Plan 03: Manager→Worker fork() Seam Summary

**`forkWorker` lands as a named export of `@adl/workspace` — the second and last process-launch primitive in the repository, with a live IPC channel, piped stdio, and a constructed (never inherited) environment — and the spawn-ban exemption count is now measured at exactly one rather than argued in a comment.**

## Performance

- **Duration:** 51 min active work (15:26–16:18 across two dispatches; a session-quota interruption paused work for ~47 min between Task 1's commit and Task 2's resumption — the orchestrator preserved in-progress Task 2 edits in a `wip` commit so no work was lost)
- **Started:** 2026-08-19T15:00:00Z (approx)
- **Completed:** 2026-08-19T16:18:00Z (approx)
- **Tasks:** 2
- **Files modified:** 8 (4 created, 4 modified)

## Accomplishments

- `packages/workspace/src/exec/fork.ts`: `forkWorker(entryPath, options)` — a sibling of `run.ts`, not a modification of it — returns a `ForkedWorker` with a live IPC channel (`stdio: ['ignore','pipe','pipe','ipc']`), piped `stdout`/`stderr`, and an explicitly constructed environment (`WORKER_ENV_ALLOWLIST` merged with caller-supplied `options.env`, never `process.env` spread).
- `packages/workspace/src/index.ts` re-exports `forkWorker`, `ForkedWorker`, `ForkWorkerOptions`, and `WORKER_ENV_ALLOWLIST` with a "why public" comment: publishing the seam is what keeps the spawn-ban exemption count at one.
- `test/lint/fixtures/manager-fork-direct.ts` + `test/lint/no-restricted-imports.test.ts`: a deliberate-violation fixture proving `fork` from `node:child_process` is still banned outside `packages/workspace`, plus two new tests proving the real `fork.ts` lints clean under the spawn rules and that **exactly one** flat-config entry clears those rules for `packages/workspace` (the assertion the whole task exists for, per `WORKSPACE_EXEMPTION`'s own docblock).
- `packages/workspace/test/contract/workspace-contract.test.ts`: the pre-existing Phase 2 T-2-40 guard (previously hard-coded "exactly one module in this package can launch a process") was updated to recognise `fork.ts` as the second SANCTIONED launcher, with its own vacuity check ("confirms the fork() launcher really is still the process launch"), while continuing to fail on any third, unreviewed one.
- `git diff --stat packages/workspace/src/exec/run.ts` is empty — `run.ts` was not touched, per the plan's explicit requirement.

## Task Commits

Each task was committed atomically:

1. **Task 1: forkWorker — the second process-launch primitive, in the one package allowed to have one** — `ba32698` (feat)
2. **Task 2: Prove the exemption count is still one** — `937ceba` (test), with in-progress work from the same task preserved by the orchestrator in `6217521` (wip, not authored by this executor) after a session-quota interruption

**Plan metadata:** committed with this SUMMARY (worktree mode — orchestrator commits STATE.md/ROADMAP.md centrally after the wave)

_Note: this plan had no `tdd="true"` tasks, so there is no RED/GREEN/REFACTOR sequence to report._

## Files Created/Modified

- `packages/workspace/src/exec/fork.ts` — `forkWorker`/`ForkedWorker`/`ForkWorkerOptions`/`WORKER_ENV_ALLOWLIST`, the manager→worker fork() seam
- `packages/workspace/src/index.ts` — barrel re-export of the new seam, with the "why public" rationale
- `packages/workspace/test/exec/fork.test.ts` — behaviour coverage: IPC round-trip, piped stdio, pid, env allowlist (positive and negative), missing-path error
- `packages/workspace/test/fixtures/echo-worker.js` — dependency-free IPC echo child forked by the test suite
- `packages/workspace/test/contract/workspace-contract.test.ts` — updated T-2-40 guard: two sanctioned launchers instead of one, with a fork-side vacuity check added
- `test/lint/fixtures/manager-fork-direct.ts` — deliberate-violation fixture: `import { fork } from 'node:child_process'`
- `test/lint/no-restricted-imports.test.ts` — new fixture row; new "the fork() seam does not need — and did not receive — a second exemption" describe block (positive lint-clean check + exemption-count measurement)
- `eslint.config.js` — `WORKSPACE_EXEMPTION` gained an `export` keyword only; no rule, glob, or severity changed

## Decisions Made

- `WORKER_ENV_ALLOWLIST` is a small, purpose-built list (`PATH`; `+SystemRoot` on Windows) rather than a reuse of `env.ts`'s `buildChildEnv` — the latter is scoped to an `ExecSpec` and to scratch-HOME/git-config neutralisers a worker fork has no use for, since the worker is ADL's own code, not an agent's. The divergence is recorded in `fork.ts`'s own docblock rather than left implicit.
- `forkWorker` detects a missing entry module via a synchronous `existsSync` check and reports it through a `queueMicrotask`-deferred `'error'` event on the returned `child`, because empirical testing (`node -e` against a real nonexistent path) confirmed `fork()` never raises a native spawn-level `'error'` event for this case — it only produces `exit(1, null)` with a "Cannot find module" line on stderr, which is otherwise indistinguishable from a legitimate early exit.
- Updated `packages/workspace/test/contract/workspace-contract.test.ts` (Phase 2's T-2-40 guard) rather than leaving it to fail or dropping it — its purpose (no THIRD, unreviewed process launcher arrives silently) is still live and still needed after this plan's deliberate second launcher landed. This was not in the plan's declared `<files>` list for Task 1, but was required to keep `pnpm --filter @adl/workspace test` at exit 0 without weakening a security-relevant guard (documented as a deviation below).
- `WORKSPACE_EXEMPTION` in `eslint.config.js` gained an `export` keyword — exactly the escape hatch Task 2's own `<action>` anticipated ("If assertion 3 cannot be expressed against the exported config shape as it stands, export the minimum additional named constant") — so the exemption-count test measures the real glob by value instead of a hand-copied string that could drift.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug / Rule 3 - Blocking] Updated the pre-existing T-2-40 contract test to recognise fork.ts as a second sanctioned launcher**
- **Found during:** Task 1 (`pnpm --filter @adl/workspace test` failed after adding `fork.ts`)
- **Issue:** `packages/workspace/test/contract/workspace-contract.test.ts` (shipped in Phase 2) hard-coded the invariant "exactly one module in this package may import a process-launch primitive," with `run.ts` as that one module and `child_process`'s `soleNamer` set to `undefined` (nothing may import it). Adding `fork.ts` — this plan's explicit, settled deliverable — correctly tripped that guard, since the guard could not distinguish "a deliberate, reviewed second launcher" from "an unreviewed bypass" without being told about the new one.
- **Fix:** Added a `FORK_PRIMITIVE` constant, changed `child_process`'s `soleNamer` from `undefined` to `FORK_PRIMITIVE`, updated the section title/docblock/offender messages to describe "the sanctioned set" (now two) rather than "the one module," added a `fork.ts` vacuity check mirroring the existing `run.ts` one ("confirms the fork() launcher really is still the process launch"), and made the "no bare import statement" offender message primitive-aware instead of hard-coding `SOLE_EXEC_PRIMITIVE` for every case.
- **Files modified:** `packages/workspace/test/contract/workspace-contract.test.ts`
- **Verification:** `pnpm --filter @adl/workspace test` — 214 passed, 4 skipped (0 failed); `pnpm --filter @adl/workspace typecheck` exits 0.
- **Committed in:** `ba32698` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug/blocking — a pre-existing guard needed updating for a deliberate architectural change this plan itself specified)
**Impact on plan:** Necessary to keep a real security-relevant test suite green without weakening what it protects. The updated guard still fails the instant a THIRD, unreviewed process-launch primitive appears anywhere in `packages/workspace` — the property T-2-40 exists for is unchanged, only the sanctioned count moved from one to two, exactly as this plan intended.

## Issues Encountered

- A provider session-quota limit terminated the previous dispatch mid-Task-2, after the `manager-fork-direct.ts` fixture, the `WORKSPACE_EXEMPTION` export, and a partial edit to `test/lint/no-restricted-imports.test.ts` had been written but not committed. The orchestrator (worktree lifecycle owner) preserved that state in a `wip(03-03)` commit (`6217521`) so no work was lost across the interruption. This dispatch verified the preserved state was correct and complete (the `FIXTURES` row for `manager-fork-direct.ts` was already present), then added the remaining "the fork() seam does not need — and did not receive — a second exemption" describe block and committed it normally on top — no history-rewriting commands were used.
- `pnpm` is not on `PATH` in this sandbox; all invocations in this dispatch used `corepack pnpm ...`, matching the pattern already recorded in `03-01-SUMMARY.md`.
- Empirically verified on this Windows dev machine (not merely asserted) that `fork()` against a nonexistent module path produces `exit(1, null)` with no native `'error'` event — this directly informed `forkWorker`'s missing-path detection design (`existsSync` + `queueMicrotask`-emitted synthetic error) rather than relying on a spawn-level error that does not occur for this failure mode.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `@adl/manager` can now obtain a forked worker with a live IPC channel by importing `forkWorker` from `@adl/workspace` — no direct `node:child_process` import, and no second lint exemption. Remaining Phase 3 plans (03-04 through 03-09) that build the manager's process supervision, lease reaper, or HTTP API can depend on this seam directly.
- Stop/kill escalation (D-28 as amended, the SIGTERM-then-SIGKILL-via-IPC pattern 03-RESEARCH.md's Pattern 2/Pitfall 1 and Pitfall 3 describe) is deliberately NOT implemented here — it is manager policy, to be built in `@adl/manager` against the `ForkedWorker.child` handle this plan exposes.
- No blockers for the rest of Phase 3's plans. `run.ts` was untouched, so plan 03-02 (which owns `packages/db/**` in this same wave) had no file-scope overlap with this plan.

---
*Phase: 03-manager-skeleton-state-leases-api-cli*
*Completed: 2026-08-19*

## Self-Check: PASSED

All created files (packages/workspace/src/exec/fork.ts, packages/workspace/test/exec/fork.test.ts, packages/workspace/test/fixtures/echo-worker.js, test/lint/fixtures/manager-fork-direct.ts, this SUMMARY.md) verified present on disk. All task commit hashes (ba32698, 937ceba, 9d9404f) verified present in git log.
