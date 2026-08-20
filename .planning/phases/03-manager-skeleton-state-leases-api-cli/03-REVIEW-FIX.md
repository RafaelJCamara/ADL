---
phase: 03-manager-skeleton-state-leases-api-cli
fixed_at: 2026-08-20T08:11:00Z
review_path: .planning/phases/03-manager-skeleton-state-leases-api-cli/03-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 03: Code Review Fix Report

**Fixed at:** 2026-08-20T08:11:00Z
**Source review:** .planning/phases/03-manager-skeleton-state-leases-api-cli/03-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 5 (CR-01, WR-01, WR-02, WR-03, WR-04 — IN-01 excluded per fix_scope)
- Fixed: 5
- Skipped: 0

All fixes were applied and committed directly on the main working tree (no worktree
isolation for this fix pass, per the orchestrator's instruction — it runs after Phase
03's plans are all merged), using normal commits with hooks (no `--no-verify`).

## Fixed Issues

### CR-01: `compareAndSwapState`'s optimistic-concurrency result is discarded at every call site

**Files modified:** `packages/manager/src/scheduler/dispatcher.ts`,
`packages/manager/src/control/state.ts`, `packages/manager/src/scheduler/reaper.ts`
**Commits:** `3064a60`, `eb69437`, `177be81` (one per call site, per the atomic-commit
requirement — three separate findings-worth of surface area sharing one review ID)

**Applied fix:** At all three call sites, the transaction callback now captures
`compareAndSwapState`'s boolean return and returns it from the transaction; the caller
branches on the result:

- **`dispatcher.ts` (`dispatchOnce`):** on a lost CAS, the transaction skips the event
  append and the config-snapshot write, then — outside the transaction — the dispatcher
  releases the lease it had just acquired via `repo.releaseLease(...)` (since
  `acquireLease` never checks `state`, only `lease_token`/`lease_expires_at`, it can
  still succeed against a row a concurrent pause/kill already moved out of `queued`;
  without this release the row would be left holding a stray lease until it timed out)
  and returns `{ dispatched: false }` instead of forking a worker.
- **`control/state.ts` (`applyControlEvent`):** on a lost CAS, the transaction skips the
  event append and the lease release, and the function returns `false` (the same
  "benign no-op" signal it already used for `transition()` rejections) instead of the
  previously-unconditional `true`.
- **`reaper.ts` (`reapOne`):** on a lost CAS, the transaction skips the `crash_count`
  increment, the event append, and the lease expiry, logs at `warn`, and the function
  returns `undefined` (the same "nothing to do" signal it already used for the token
  guard and for `transition()` rejections) instead of reporting a recovery that never
  actually applied.

This closes the race the review demonstrated: a feature a concurrent `pause`/`kill`
moves out of `queued` can no longer be dispatched to a worker, have a phantom audit
event written for it, or have its `crash_count` bumped for a recovery that silently
lost the race.

**Verification:** Tier 1 (re-read) + Tier 2 (`pnpm --filter @adl/manager typecheck`,
clean) after each of the three edits, plus the full `pnpm --filter @adl/manager test`
suite (130/130 passing) after the third. No test asserted on the internal transaction
shape, only on outcomes, so none needed updating.

### WR-01: `mergeConfig`'s clamp/discard audit trail is computed and then thrown away

**Files modified:** `packages/manager/src/scheduler/dispatcher.ts`,
`packages/manager/src/daemon.ts`
**Commit:** `b5604c6`

**Applied fix:** `dispatchOnce` now destructures `report` alongside `config` from
`mergeConfig(...)` and logs at `warn` (keyed by `feature.id`, carrying `clamped` and
`discarded`) whenever either array is non-empty. `DispatcherDeps` gained an **optional**
`logger?: Logger` field (`pino`'s `Logger` type) rather than a required one — optional
so every earlier plan's tests keep constructing `DispatcherDeps` without one, matching
this file's existing precedent for `controlState` ("absent, dispatch is never paused").
`daemon.ts`'s dispatch tick now passes its own real `logger` into `dispatchOnce(...)`.

**Verification:** Tier 1 + Tier 2 (typecheck clean) + full manager test suite
(130/130 passing).

### WR-02: `expectingExit` set only after an async DB round-trip that can lose the race against the child's own `exit` event

**Files modified:** `packages/manager/src/worker-supervisor/supervisor.ts`,
`packages/manager/test/control/pause.test.ts`
**Commit:** `6eb69ab`

**Applied fix:** `expectingExit.set(feature.id, true)` for a `stage_result` message is
now set **synchronously**, in the message handler's synchronous branch, before the
`void (async () => {...})()` IIFE that contains `await deps.getCurrentLeaseToken(...)`
even starts — removing the race window between that await and the child's own
near-immediate `exitNow(0)`. The now-redundant `expectingExit.set(...)` inside the async
block (after the fence check) was removed, leaving only the `onRoundBoundary` callback
there. Marking unconditionally (even if the fence later rejects the message as stale)
is safe: a stale token means some other writer already moved the lease, so suppressing
this worker's own fast-path call costs nothing — the reaper's `expectedLeaseToken` guard
already treats that case as a no-op.

Per the review's regression-test suggestion, `test/control/pause.test.ts`'s round-boundary
test (previously the one test exercising this path, but constructed **without**
`getCurrentLeaseToken`, which caused the `await` to be skipped entirely) now supplies a
real async `getCurrentLeaseToken` (`featuresRepository(db).findById(...)`) and asserts
`unexpectedExitCalls === 0` — so the exact ordering this finding describes is now
actually asserted rather than incidentally true.

**Verification:** Tier 1 + Tier 2 (typecheck clean) + full manager test suite
(130/130 passing, including the strengthened regression test).

### WR-03: `@adl/manager` and `@adl/cli` have no `tsconfig.test.json` — `test/` never typechecked

**Files modified:** `packages/manager/tsconfig.test.json` (new),
`packages/cli/tsconfig.test.json` (new), `packages/manager/package.json`,
`packages/cli/package.json`, `packages/manager/test/lease/fencing.test.ts`,
`packages/manager/test/tracer/end-to-end.test.ts`,
`packages/manager/test/scheduler/reaper.test.ts`
**Commit:** `8bf6af4`

**Applied fix:**
- Added `packages/manager/tsconfig.test.json` and `packages/cli/tsconfig.test.json`,
  mirroring `packages/db/tsconfig.test.json`'s shape (`extends` the package's own
  `tsconfig.json`, `noEmit: true`, `composite: false`, `include` adds `test/**/*.ts`).
  Both packages' own `tsconfig.json` set `rootDir: "src"` (unlike `@adl/db`, which is
  rooted at `.`), so `test/` — a sibling of `src/`, not a descendant — needed an
  explicit `rootDir` override in the new file. `@adl/cli`'s test suite stays entirely
  within its own package, so `rootDir: "."` (the package root) was enough. `@adl/manager`'s
  test suite reaches across package boundaries by relative path to reuse
  `@adl/db`'s and `@adl/workspace`'s own test helpers and, for the in-process tracer,
  `@adl/cli`'s source directly (`../../../db/test/helpers/temp-db.js`,
  `../../../workspace/test/helpers/temp-repo.js`, `../../../cli/src/http-client.js`), so
  its override is `rootDir: ".."` — the workspace's `packages/` directory, the narrowest
  root containing every file the program actually pulls in.
- Wired both packages' `typecheck` scripts to `tsc --noEmit && tsc --noEmit -p
  tsconfig.test.json`, matching `@adl/db`'s existing pattern. `@adl/manager`'s
  `pretypecheck` was widened from `tsc -b ../core` to `tsc -b ../core ../db ../workspace`
  (matching its own `pretest` script's dependency graph) so the wider test program's
  cross-package type references resolve.
- Fixed the two stale `FeatureView` literals the review identified
  (`test/lease/fencing.test.ts:200-211`, `test/tracer/end-to-end.test.ts:294-305`),
  replacing the non-existent `stageIndex`/`pipelineLength` fields with the real
  `stage: StageCell` field, using a representative `StageCell` fixture
  (`{ state, position, pipelineLength, name, label }`).
- Compiling `test/` under the new program surfaced two additional latent issues the
  review didn't call out by line, both real drift/errors that `vitest` (types-stripped,
  never typechecked) had been silently letting through:
  - `test/tracer/end-to-end.test.ts` had a second, independent assertion
    (`expect(Object.keys(body[0]!).sort()).toEqual([...])`) hardcoding the same stale
    `stageIndex`/`pipelineLength` field names as an explicit key list — updated to
    `stage` in place of the two.
  - `test/scheduler/reaper.test.ts`'s `'ReaperDeps declares no clock member'` test called
    `.sort()` directly on a `readonly (keyof ReaperDeps)[]`-typed array, which is not a
    method `ReadonlyArray<T>` exposes (`.sort()` mutates in place) — a real `TS2339`
    compile error once the file was actually compiled. Fixed to `[...keys].sort()`
    (sort a mutable copy), matching the same copy-then-sort pattern already used
    elsewhere in this test suite (`dispatcher.test.ts`).

**Verification:** Tier 1 + Tier 2 (`pnpm --filter @adl/manager typecheck` and
`pnpm --filter @adl/cli typecheck`, both clean) + `pnpm --filter @adl/manager build`
and `pnpm --filter @adl/cli build` (both clean, confirming the new test-only tsconfig
doesn't affect the shipped build) + full test suites for both packages
(`@adl/manager`: 130/130 passing; `@adl/cli`: 21/21 passing).

### WR-04: No non-empty guard on the API bearer token at the trust boundary

**File modified:** `packages/manager/src/api/app.ts`
**Commit:** `4d4f7dc`

**Applied fix:** `createApi(deps)` now throws at the top of the function (before
constructing the `Hono` app) when `deps.apiToken.length === 0`, so a misconfigured
empty token is a startup-time failure rather than a live authentication bypass —
`timingSafeTokenEqual` would otherwise accept an equally-empty presented token
(`Authorization: Bearer ` with nothing after the prefix) as a match against an empty
configured token, authenticating any such request.

**Verification:** Tier 1 + Tier 2 (typecheck clean) + full manager test suite
(130/130 passing — every existing test already supplies a non-empty `apiToken`, so
none needed changes).

## Skipped Issues

None — all five in-scope findings (CR-01, WR-01, WR-02, WR-03, WR-04) were fixed.
IN-01 was intentionally excluded per `fix_scope: critical+warning`.

## Final Verification

Run in the main working tree (no worktree isolation for this fix pass, per the
orchestrator's explicit instruction):

| Command | Result |
|---|---|
| `pnpm --filter @adl/manager typecheck` | clean (0 errors) |
| `pnpm --filter @adl/manager test` | 130/130 passing (16 test files) |
| `pnpm --filter @adl/manager build` | clean |
| `pnpm --filter @adl/cli typecheck` | clean (0 errors) |
| `pnpm --filter @adl/cli test` | 21/21 passing (3 test files) |
| `pnpm --filter @adl/cli build` | clean |

**Note on WR-02's logic-classification:** the CR-01 fix (branching on
`compareAndSwapState`'s result at all three call sites) and the WR-02 fix (moving
`expectingExit.set(...)` before the fence-check's `await`) both correct concurrency/race
logic rather than a pure syntax defect. Both passed typecheck and the full test suite —
including, for WR-02, a strengthened regression test that now exercises the exact
`await` the race sits behind and asserts the fast path never misfires — but per this
agent's verification protocol, logic-class fixes should still get a human read of the
reasoning in this report before the phase is considered fully closed, even though
automated verification found nothing wrong.

---

_Fixed: 2026-08-20T08:11:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
