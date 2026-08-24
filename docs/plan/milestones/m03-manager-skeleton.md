# M03 — Manager Skeleton: State, Leases, API, CLI

**Status:** ✅ Done · 2026-08-20
**Depends on:** M02
**Requirements:** EXEC-01…06, OBS-01, OBS-03, OBS-04 (9)

**Goal:** a crash-surviving control plane the maintainer can watch and interrupt, proven
with a fake worker and no AI anywhere in the loop.

Testing recovery semantics with zero AI in the loop is the cheapest this will ever be.

---

## Done when

- [x] `adl status` shows what every feature is doing right now — state, current stage, round.
- [x] A worker `SIGKILL`ed mid-run is detected within the lease TTL and its feature
      recovered, with committed work preserved and burned spend still on the ledger.
- [x] A zombie worker that wakes after its lease expired cannot write stale results over
      newer state — its write is rejected on the fencing token.
- [x] Feature state, rounds, spend and transcripts are all present and consistent after a
      daemon restart.
- [x] The maintainer can pause work and kill one feature, one repository, or everything;
      concurrency is configurable and defaults to one feature in flight.

---

## What shipped

- **Two new packages plus a three-leg CI matrix** — `@adl/manager` (hono, pino, croner,
  ulid) and `@adl/cli` (commander + `bin`). The CLI **structurally cannot resolve**
  `@adl/db` or `@adl/manager` under pnpm's strict `node_modules`, asserted by a
  `require()`-based check. CI runs ubuntu/22, ubuntu/24, windows/22.
- **The lease queue is SQL, not manager logic** — `packages/db/src/repository/features.ts`.
  Each lease op is a conditional `UPDATE` returning a boolean, never throwing for a lost
  race. `leaseToken` is **required, never optional** on every lease-scoped input, proven
  by a `@ts-expect-error` test verified in both directions.
- **The manager→worker fork seam** — `packages/workspace/src/exec/fork.ts`. `forkWorker`
  with an explicit `WORKER_ENV_ALLOWLIST` and a synthetic `'error'` event for a missing
  entry module (verified: `fork()` raises none). The spawn-ban exemption count is
  *measured* at exactly one.
- **Zod-validated IPC** — `packages/manager/src/ipc/protocol.ts`. Two discriminated
  unions plus a frozen `IPC_MESSAGE_KINDS` with compile-time exhaustiveness; parse
  failures return `{ok: false, reason}` and an unparseable message triggers **no**
  repository call.
- **Crash recovery, fencing and the reaper share one code path** —
  `src/scheduler/reaper.ts`'s `reapOne` is called by both the periodic tick and the
  supervisor's `child.on('exit')` fast path. `src/fencing.ts`'s `checkFence` runs before
  **any** repository write, for every lease-scoped message kind. The zombie in the test is
  a real second process speaking the real protocol with zero heartbeats.
- **Daemon boot sequence** — fixed order in `daemon.ts`: schema gate → `reconcileRepos` →
  `killBootOrphans` → `expireAllLeasesAtBoot` → `restoreGlobalPause` → supervisor → API
  bind → dispatch tick. `runStartupGate` refuses a newer schema **writing nothing**, and
  copies-then-migrates an older one to a `.pre-<version>-<timestamp>` file that is never
  deleted.
- **Concurrency and control plane** — `src/scheduler/dispatcher.ts`. Inclusive global cap
  plus optional per-repo override; in-flight counted from `listLeased()` so a restarted
  daemon counts correctly; FIFO by lowest queued ULID. **Lowering the cap drains, never
  revokes.** `stopWorker` is the single `soft_stop`-then-`SIGKILL` implementation (never
  `SIGTERM` — a Windows forked child ignores it).
- **HTTP surface** — bearer middleware using `timingSafeEqual` against a same-length decoy
  on length mismatch; `UNAUTHENTICATED_PATHS` asserted to have exactly one entry
  (`GET /health`); loopback bind asserted.
- **Six CLI verbs** — `status | pause | resume | kill | gc | daemon`, all through
  `http-client.ts` only. Only `--all` prompts, and a non-interactive context without
  `--yes` **refuses outright**.
- **Global pause survives a restart** — persist-then-flip in `control/state.ts`; an
  unreadable persisted value boots **paused** (fail-safe). Proven by two real
  `startDaemon` processes sharing one database file.
- **The interaction scenario** — `test/scenario/concurrency-crash-restart.test.ts`. Three
  features leased and forked at concurrency 3, one SIGKILLed mid-run, the other two
  orphaned and recovered by a real unmodified `startDaemon()`. Closes with zero
  overlapping lease intervals reconstructed from the append-only `feature_events` log.

## Deliberately excluded

- **`adl daemon start` does not boot the daemon** — it prints an honest gap message and
  exits 1. `StartDaemonOptions.resolveAdlYml` has no production implementation until
  M05's feature detection lands. **This is M05's job to close.**
- **No single-instance guard** for two managers against one database — accepted for v1
  and documented in `packages/manager/README.md`.
- **Repo-scoped pause deliberately does not survive a restart** (only the global flag
  does); the asymmetry is documented.
- **No budget gate** — `dispatchOnce`'s check-before-dispatch cap shape is the template
  M06 is meant to *extend*, not restructure.
- `resetCrashCountOnSuccess` is exported and unit-tested but has no caller — there is no
  gate pipeline to complete a round from yet. It belongs at M05's round-completion write
  site, in the same transaction as the round outcome.

## Still open

Nothing blocking. Two cosmetic items in [`DEBT.md`](../DEBT.md): `adl status` prints a raw
stack trace when `.adl/daemon.json` has never been created, and pre-migration `.pre-*`
database copies accumulate without bound.
