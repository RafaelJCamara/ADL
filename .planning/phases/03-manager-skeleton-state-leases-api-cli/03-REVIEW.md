---
phase: 03-manager-skeleton-state-leases-api-cli
reviewed: 2026-08-20T00:00:00Z
depth: standard
files_reviewed: 95
files_reviewed_list:
  - .github/workflows/ci.yml
  - eslint.config.js
  - package.json
  - packages/cli/package.json
  - packages/cli/README.md
  - packages/cli/src/commands/daemon.ts
  - packages/cli/src/commands/gc.ts
  - packages/cli/src/commands/kill.ts
  - packages/cli/src/commands/pause.ts
  - packages/cli/src/commands/resume.ts
  - packages/cli/src/commands/status.ts
  - packages/cli/src/confirm.ts
  - packages/cli/src/http-client.ts
  - packages/cli/src/index.ts
  - packages/cli/src/render/status-table.ts
  - packages/cli/test/control-verbs.test.ts
  - packages/cli/test/smoke.test.ts
  - packages/cli/test/status.test.ts
  - packages/cli/tsconfig.json
  - packages/cli/vitest.config.ts
  - packages/core/src/config/effective-config.ts
  - packages/core/src/config/index.ts
  - packages/core/test/config/daemon-config-schema.test.ts
  - packages/db/package.json
  - packages/db/src/index.ts
  - packages/db/src/migrator.ts
  - packages/db/src/repository/features.ts
  - packages/db/src/repository/index.ts
  - packages/db/src/repository/meta.ts
  - packages/db/src/repository/repos.ts
  - packages/db/src/time.ts
  - packages/db/test/helpers/temp-db.ts
  - packages/db/test/lease.test.ts
  - packages/db/test/pragmas.test.ts
  - packages/db/test/repos-meta.test.ts
  - packages/db/test/schema-drift.test.ts
  - packages/db/tsconfig.test.json
  - packages/manager/package.json
  - packages/manager/README.md
  - packages/manager/src/api/app.ts
  - packages/manager/src/api/routes/control.ts
  - packages/manager/src/api/routes/features.ts
  - packages/manager/src/api/routes/gc.ts
  - packages/manager/src/api/routes/health.ts
  - packages/manager/src/boot/orphans.ts
  - packages/manager/src/boot/shutdown.ts
  - packages/manager/src/boot/startup.ts
  - packages/manager/src/config/daemon-config.ts
  - packages/manager/src/control/state.ts
  - packages/manager/src/daemon.ts
  - packages/manager/src/fencing.ts
  - packages/manager/src/index.ts
  - packages/manager/src/ipc/protocol.ts
  - packages/manager/src/recovery/policy.ts
  - packages/manager/src/scheduler/dispatcher.ts
  - packages/manager/src/scheduler/gc-schedule.ts
  - packages/manager/src/scheduler/reaper.ts
  - packages/manager/src/stage-name.ts
  - packages/manager/src/worker-entry/index.ts
  - packages/manager/src/worker-supervisor/lifecycle.ts
  - packages/manager/src/worker-supervisor/supervisor.ts
  - packages/manager/test/api/features-view.test.ts
  - packages/manager/test/boot/daemon-restart.test.ts
  - packages/manager/test/boot/orphans.test.ts
  - packages/manager/test/boot/startup-gate.test.ts
  - packages/manager/test/config/daemon-config.test.ts
  - packages/manager/test/control/kill.test.ts
  - packages/manager/test/control/pause.test.ts
  - packages/manager/test/helpers/capturing-logger.ts
  - packages/manager/test/helpers/ephemeral-port.ts
  - packages/manager/test/helpers/held-worker-entry.ts
  - packages/manager/test/helpers/ignores-stop-worker-entry.ts
  - packages/manager/test/helpers/lease-audit.ts
  - packages/manager/test/helpers/platform.test.ts
  - packages/manager/test/helpers/platform.ts
  - packages/manager/test/helpers/scripted-worker-entry.ts
  - packages/manager/test/helpers/worker-harness.ts
  - packages/manager/test/helpers/zombie-worker-entry.ts
  - packages/manager/test/lease/fencing.test.ts
  - packages/manager/test/recovery/crash-recovery.test.ts
  - packages/manager/test/scenario/concurrency-crash-restart.test.ts
  - packages/manager/test/scheduler/dispatcher.test.ts
  - packages/manager/test/scheduler/gc-schedule.test.ts
  - packages/manager/test/scheduler/reaper.test.ts
  - packages/manager/test/smoke.test.ts
  - packages/manager/test/tracer/end-to-end.test.ts
  - packages/manager/tsconfig.json
  - packages/manager/vitest.config.ts
  - packages/workspace/src/exec/fork.ts
  - packages/workspace/src/index.ts
  - packages/workspace/test/contract/workspace-contract.test.ts
  - packages/workspace/test/exec/fork.test.ts
  - packages/workspace/test/fixtures/echo-worker.js
  - pnpm-lock.yaml
  - test/ci-matrix.test.ts
  - test/lint/fixtures/manager-fork-direct.ts
  - test/lint/fixtures/worker-entry-imports-db.ts
  - test/lint/no-restricted-imports.test.ts
  - test/platform-gate-discipline.test.ts
findings:
  critical: 1
  warning: 4
  info: 1
  total: 6
status: issues_found
---

# Phase 03: Code Review Report

**Reviewed:** 2026-08-20T00:00:00Z
**Depth:** standard
**Files Reviewed:** 95
**Status:** issues_found

## Summary

The phase implements the manager daemon's core write paths (dispatch, pause/resume/kill,
lease expiry/recovery), its HTTP control surface, the worker supervisor/IPC fence, and the
`adl` CLI. The individual pieces are carefully specced and mostly well-tested, but one defect
recurs across all three of the daemon's optimistic-concurrency write paths (dispatch,
control-event application, and lease reaping): the `compareAndSwapState` boolean result — the
mechanism the codebase's own docs describe as the guarantee against two writers racing the same
row — is never inspected by any of its three callers. Concretely, this lets the dispatcher fork
a worker for a feature a concurrent `pause`/`kill` request just moved out of `queued`, which
contradicts this project's own explicit product promise ("`adl pause` — a brake on new work,
never a kill", `packages/cli/README.md`). That is this review's one blocker. The remaining
findings are lower-severity: a discarded config-clamp audit trail, an unexercised exit-race in
the worker supervisor, and a test-typechecking gap that has already let real API-shape drift
into two test files undetected.

## Critical Issues

### CR-01: `compareAndSwapState`'s optimistic-concurrency result is discarded at every call site — a paused/killed feature can still be dispatched to a worker

**File:** `packages/manager/src/scheduler/dispatcher.ts:204-239`, `packages/manager/src/control/state.ts:130-162`, `packages/manager/src/scheduler/reaper.ts:149-188`

**Issue:**

`FeaturesRepository.compareAndSwapState` (`packages/db/src/repository/features.ts:174-201`) is
documented as the whole safety mechanism for concurrent writers: *"Two workers that both read
version 4 cannot both write version 5 — the second update matches no row and reports `false`,
which is a caller-visible loss rather than a silent overwrite of the first worker's
transition."* It returns `Promise<boolean>`.

None of its three production call sites check that boolean:

```ts
// packages/manager/src/scheduler/dispatcher.ts:204-239
await deps.db.transaction().execute(async (trx) => {
  const trxRepo = featuresRepository(trx);
  await trxRepo.compareAndSwapState({ /* ... */ });   // <-- result discarded
  const [effect] = outcome.effects;
  if (effect !== undefined) {
    await trxRepo.appendEvent({ /* ... */ });          // written unconditionally
  }
  await trx.updateTable('features').set({ /* ... */ }).where('id', '=', feature.id).execute();
});
// ...
deps.spawnWorker({ /* ... */ });                        // fired unconditionally
return { dispatched: true, featureId: feature.id, leaseToken };
```

The same pattern repeats verbatim in `applyControlEvent` (`control/state.ts:130-164`, ending in
an unconditional `return true;`) and in `reapOne` (`reaper.ts:149-195`, where `crash_count` is
*also* incremented unconditionally in the same transaction, independent of whether the CAS
actually matched a row).

This is reachable, not theoretical. `dispatchOnce` reads the candidate set with
`await repo.listQueued()`, then does a second `await repo.listLeased()`, then (for the chosen
candidate) `await repo.acquireLease(...)` before the CAS write — three separate awaits during
which the Node event loop can run an HTTP-triggered `pause`/`kill` request against the exact
same row. Critically, `acquireLease`'s own guard
(`packages/db/src/repository/features.ts:250-257`) checks only `lease_token`/`lease_expires_at`,
never `state` — so it happily grants a lease to a row a concurrent `pause` already moved to
`paused` (a paused feature has `lease_token = null`, identical to a queued one). Sequence:

1. Dispatcher reads feature F as `queued`, version 4.
2. A concurrent `POST /features/F/pause` (or `/control/pause`) reads the same row, transitions
   it to `paused`, version 5 — this happens to land first.
3. Dispatcher's `acquireLease` succeeds anyway (no state check), and its `compareAndSwapState`
   call uses the stale `expectedVersion: 4`, which matches zero rows and is a silent no-op.
4. Because the return value is never checked, the dispatcher still writes a bogus
   `feature_events` row claiming `queued → leased`, still snapshots `effective_config_json`,
   and — the operationally serious part — still calls `deps.spawnWorker(...)`, forking a real
   worker process and reporting `{ dispatched: true }`.

The result: a feature the operator just paused gets worked on anyway, directly contradicting
D-26/`packages/cli/README.md`'s "pause is a brake on new work, never a kill" guarantee. The same
missing check in `applyControlEvent` means `adl pause`/`resume`/`kill` can report a feature as
`affected` in the HTTP response and write an audit event for it even when the underlying
`features` row never actually changed (the CAS silently lost). In `reapOne`, a lost race still
permanently increments `crash_count` (a separate, unguarded write in the same transaction),
which can push a feature toward `MAX_CONSECUTIVE_CRASHES` escalation for "crashes" that were
partly phantom recoveries that never applied.

**Fix:** Capture and branch on the CAS result at all three sites; treat a `false` result the
same way `dispatchOnce`'s own comment already anticipates for `transition()` rejections — an
ordinary "lost the race" outcome, not a fatal error, and one that must skip the dependent writes
(event append, lease release/expire, `crash_count` increment, and — for the dispatcher —
`spawnWorker`):

```ts
const casApplied = await trxRepo.compareAndSwapState({ /* ... */ });
if (!casApplied) {
  // lost the race — nothing else in this transaction should proceed as if it won
  return; // (or throw a sentinel the outer function turns into `{ dispatched: false }` / `false`)
}
const [effect] = outcome.effects;
if (effect !== undefined) {
  await trxRepo.appendEvent({ /* ... */ });
}
```
For `dispatchOnce` specifically, additionally consider having `acquireLease` (or a wrapping
check) also verify `state = 'queued'` at acquire time, so a paused/killed feature can never be
leased in the first place regardless of whether the later CAS is checked.

## Warnings

### WR-01: `mergeConfig`'s clamp/discard audit trail is computed and then thrown away

**File:** `packages/manager/src/scheduler/dispatcher.ts:155-160`

**Issue:** `mergeConfig` returns `{ config, report: { clamped, discarded } }`, and
`effective-config.ts`'s own docblock states the reason it exists: *"What the daemon has
something to log, and the pull request has something to show."* `dispatchOnce` destructures only
`config`:

```ts
const { config } = mergeConfig(
  DEFAULT_CONFIG,
  deps.daemonConfig,
  deps.resolveAdlYml(feature),
);
```

`report` is silently dropped. A repository's `adl.yml` requesting `limits.budget_usd` above the
daemon's ceiling, or attempting to set `agents.developer.backend`/`.model` (D-22's explicitly
daemon-only, credential-selecting fields), is clamped/discarded correctly, but the daemon logs
nothing about it — an operator gets zero visibility that a watched repository attempted to
exceed its trust boundary, and there is no way to reconstruct this later since it's not
persisted anywhere either.

**Fix:** Log `report.clamped`/`report.discarded` (at `warn`, keyed by `feature.id`) whenever
either array is non-empty, immediately after the `mergeConfig` call in `dispatchOnce`:

```ts
const { config, report } = mergeConfig(DEFAULT_CONFIG, deps.daemonConfig, deps.resolveAdlYml(feature));
if (report.clamped.length > 0 || report.discarded.length > 0) {
  logger.warn({ featureId: feature.id, ...report }, 'adl.yml requested fields outside its trust boundary');
}
```
(`dispatchOnce` will need a `logger` dependency injected, matching the pattern every other
scheduler module already uses.)

### WR-02: `expectingExit` is set only after an async DB round-trip that can lose the race against the child's own `exit` event

**File:** `packages/manager/src/worker-supervisor/supervisor.ts:208-292`

**Issue:** On a fence-matched `stage_result`, the supervisor's message handler marks the next
exit as expected only after awaiting `deps.getCurrentLeaseToken(feature.id)`:

```ts
const current = deps.getCurrentLeaseToken
  ? await deps.getCurrentLeaseToken(feature.id)   // a real DB round-trip in production
  : undefined;
// ... fence check ...
if (kind === 'stage_result') {
  expectingExit.set(feature.id, true);            // only reached after the await above
  deps.onRoundBoundary?.({ /* ... */ });
}
```

Meanwhile the worker itself (`worker-entry/index.ts:99-117`) sends `stage_result` and then calls
`exitNow(0)` with no delay in between — the child process starts exiting essentially immediately
after the message is sent. If the parent's `'exit'` handler (`supervisor.ts:173-183`) runs before
the async IIFE above reaches `expectingExit.set(feature.id, true)`, the exit is misclassified as
unexpected and `onUnexpectedExit` fires — applying the fast-path `lease_expired` recovery to a
feature that actually completed its round cleanly. Under `daemon.ts`'s real wiring,
`getCurrentLeaseToken` performs a genuine repository read, so this is not a purely theoretical
ordering — it depends on relative scheduling of a DB-driven promise resolution versus the
child-process `'exit'` event, which is not something this code guarantees an order for.

This exact path is also not covered by the test suite: the one test exercising
`onRoundBoundary`/`parkOnRoundBoundary` (`packages/manager/test/control/pause.test.ts:365-381`)
constructs its `createSupervisor` call **without** `getCurrentLeaseToken`, which causes the
`await` to be skipped entirely (the ternary short-circuits), so the race window this finding
describes never opens in that test.

**Fix:** Mark `expectingExit` synchronously, before any `await`, as soon as the fence-matched
`stage_result` is parsed — the fence check and `onRoundBoundary` callback can still run
asynchronously after, but nothing should have to race the child's own exit to avoid a
misclassification. Add a regression test that supplies a real (even if fast) async
`getCurrentLeaseToken` to the supervisor exercising the round-boundary path, so this ordering is
actually asserted rather than incidentally true.

### WR-03: `@adl/manager` and `@adl/cli` have no `tsconfig.test.json` — `test/` is never typechecked, and real API-shape drift has already gone undetected

**File:** `packages/manager/tsconfig.json`, `packages/manager/package.json:22`,
`packages/cli/tsconfig.json`, `packages/cli/package.json`

**Issue:** `packages/core` and `packages/db` both ship a `tsconfig.test.json` specifically so
`pnpm --filter <pkg> typecheck` also compiles `test/**` —
`packages/db/tsconfig.test.json`'s own comment explains why: *"an assertion that is never
compiled asserts nothing."* `packages/manager` and `packages/cli` (both added by this phase)
have no equivalent file; their `"typecheck": "tsc --noEmit"` script runs against the default
`tsconfig.json`, whose `include` is `["src/**/*.ts"]` only. Verified directly:

```
$ corepack pnpm --filter @adl/manager typecheck
$ tsc -b ../core
$ tsc --noEmit
EXIT:0
```

— zero errors, despite `test/` containing an object literal that does not match its declared
type. Concretely, both `packages/manager/test/lease/fencing.test.ts:200-211` and
`packages/manager/test/tracer/end-to-end.test.ts:294-305` construct a `FeatureView`-typed object
using `stageIndex`/`pipelineLength` fields:

```ts
const featureView: FeatureView = {
  id: 'feature-1',
  repoId: 'repo-1',
  path: 'features/feature-1',
  state: 'developing',
  round: 0,
  stageIndex: 0,
  pipelineLength: 3,
  ageMs: 10,
  worker: null,
  staleRejections: 2,
};
```

The real `FeatureView` (`packages/manager/src/api/routes/features.ts:21-40`) has neither field —
it requires `stage: StageCell` (introduced by this same phase's `stage-name.ts`). This object
literal would fail TypeScript's excess-property check and "missing required property" check
(`stageIndex`/`pipelineLength` don't exist on the type; `stage` is absent) if the test tree were
ever compiled — because it isn't, `vitest` (which only strips types, it does not typecheck)
happily runs it, and the test still passes because it only asserts on the fields it put there
itself, not on the interface's actual current shape. This is exactly the drift class
`db/tsconfig.test.json` was built to prevent, now demonstrated to have already occurred in the
one package that lacks that protection.

**Fix:** Add `packages/manager/tsconfig.test.json` and `packages/cli/tsconfig.test.json`
(mirroring `packages/db/tsconfig.test.json`'s shape: `extends` the package's own `tsconfig.json`,
`noEmit: true`, `include` adds `test/**/*.ts`), wire each package's `pretest`/`typecheck` script
to build against it, and then fix the two stale `FeatureView` literals to use `stage: StageCell`
in place of `stageIndex`/`pipelineLength`.

### WR-04: No non-empty guard on the API bearer token at the trust boundary

**File:** `packages/manager/src/api/app.ts:45-53,89`, `packages/manager/src/daemon.ts:67,276`

**Issue:** `timingSafeTokenEqual` compares two equal-length buffers with `crypto.timingSafeEqual`
and returns `true` when they match — including when both are empty:

```ts
function timingSafeTokenEqual(presented: string, expected: string): boolean {
  const presentedBuf = Buffer.from(presented);
  const expectedBuf = Buffer.from(expected);
  if (presentedBuf.length !== expectedBuf.length) {
    timingSafeEqual(presentedBuf, presentedBuf);
    return false;
  }
  return timingSafeEqual(presentedBuf, expectedBuf);
}
```

`ApiConfigSchema.token` (`packages/core/src/config/effective-config.ts:169-177`) is optional with
no schema-level default, and `StartDaemonOptions.apiToken`/`ApiDeps.apiToken` are both typed as
plain `string` with no assertion anywhere in this package that the value is non-empty before it
is wired into `createApi`. Nothing in the reviewed files currently constructs an empty token in
production, but the type system and the schema both permit it, and the auth middleware in
`api/app.ts:92-108` treats an empty presented token against an empty configured token as a
`match`, authenticating the request. Since a bearer token is the *only* thing standing between a
non-loopback bind (which `ApiConfigSchema.host` explicitly allows, per its own docblock, "so
widening the bind is a deliberate, visible act") and an unauthenticated control plane, this
boundary should fail closed rather than rely on every future caller remembering to mint a
non-empty token.

**Fix:** Assert `apiToken.length > 0` at the top of `createApi` (throw, do not silently proceed)
so a misconfigured empty token is a startup-time failure rather than a live authentication
bypass.

## Info

### IN-01: Non-null assertions on `resolved.featureId` in `pause`/`resume`/`kill` commands

**File:** `packages/cli/src/commands/kill.ts:52`, `packages/cli/src/commands/pause.ts:52`,
`packages/cli/src/commands/resume.ts:49`

**Issue:** Each command does
`resolved.scope === 'feature' ? await deps.client.postFeatureControl(resolved.featureId!, ...) : ...`.
The non-null assertion is logically sound today because `resolveScope` (`confirm.ts:90-115`)
only ever sets `scope: 'feature'` together with `featureId`, but the invariant is enforced
entirely by convention between two separate functions in two separate files, with nothing at the
type level connecting `scope === 'feature'` to `featureId` being defined (a discriminated union
would let the compiler enforce it instead of a human).

**Fix:** Make `ResolvedScope` a discriminated union
(`{ scope: 'feature'; featureId: string } | { scope: 'repo'; repoId: string } | { scope: 'all' }`)
so the non-null assertions become unnecessary and a future edit to `resolveScope` that breaks the
invariant is a compile error at every call site instead of a runtime crash.

---

_Reviewed: 2026-08-20T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
