---
phase: 03-manager-skeleton-state-leases-api-cli
verified: 2026-08-20T06:16:31Z
status: human_needed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Resolve the EXEC-01 flagged assumption: two `adl daemon start` processes started against the same database file."
    expected: "A decision on whether v1 needs a single-instance guard (PID file / advisory lock), or whether the lease fence's per-row protection is accepted as sufficient for now."
    why_human: "03-06-PLAN.md's own `<flagged_assumptions>` block classifies this `unclassified` and explicitly defers it to reviewer judgment; the code deliberately does not add a guard, so no test can pass/fail on it — REQUIREMENTS.md correctly still shows EXEC-01 as Pending pending this call."
  - test: "Resolve the EXEC-02 flagged assumption: confirm the one-worker-one-lease mapping (no feature ever served by two workers, no worker ever holding two leases) is the intended contract, not just the implemented one."
    expected: "Sign off that the dispatcher's acquire-then-fork ordering and the supervisor's per-feature active-worker map are the correct enforcement points."
    why_human: "03-04-PLAN.md flags this `unclassified`; the D-32 scenario test's 'no feature was ever double-leased' assertion is the observable proof, but the mapping's correctness as a *design* decision (vs. a stated requirement) is still marked assumption, not decision."
  - test: "Resolve the OBS-03 flagged assumption: should a global `adl pause` survive a daemon restart, or is in-memory-only (current behaviour: a restart silently resumes dispatch) acceptable for v1?"
    expected: "A decision recorded either accepting the in-memory behaviour or requiring persistence via a `meta` row."
    why_human: "03-07-PLAN.md explicitly flags this as a real behavioural choice with operational consequences (an operator who pauses then restarts gets work restarting) that the requirement text does not resolve."
  - test: "Resolve the OBS-04 flagged assumption: confirm `adl kill --all` should stop every leased feature AND park every queued one (implemented), rather than stopping only what is in flight."
    expected: "A decision recorded on which of the two equally-consistent readings of 'kill everything' is correct."
    why_human: "03-07-PLAN.md flags this as `unclassified` with two behaviourally different, equally valid readings of the requirement text."
  - test: "adl status table readability and the daemon-down error message wording (deferred human-verify items harvested from 03-08-PLAN.md's <verify><human-check> blocks)."
    expected: "Running `adl status` with >=5 features in mixed states in a <=100-column terminal renders without wrapping and with distinguishable states; `adl status` against a stopped daemon prints a message naming the address and suggesting `adl daemon start`, with a non-zero exit code."
    why_human: "Visual/terminal presentation quality — 03-08-PLAN.md's own UAT table marks both as human judgment calls, with the automated tests covering only the underlying `--json` fields and the exit code."
---

# Phase 03: Manager Skeleton — State, Leases, API, CLI Verification Report

**Phase Goal:** A crash-surviving control plane the maintainer can watch and interrupt, proven with a fake worker and no AI anywhere in the loop.
**Verified:** 2026-08-20T06:16:31Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Maintainer runs `adl status` and sees every feature's state, current stage, and round | ✓ VERIFIED | `packages/cli/src/commands/status.ts` calls `GET /features`; `packages/manager/src/api/routes/features.ts` returns `state`, `round`, `stage: StageCell` sourced live from `featuresRepository` rows via `resolveStageCell` (`daemon.ts:242-259`). `packages/manager/test/api/features-view.test.ts` (9 tests: field completeness, no dedupe, ULID ordering, empty state, determinism) and `packages/cli/test/status.test.ts` both pass. Ran the suites directly: 130/130 (`@adl/manager`), 21/21 (`@adl/cli`). |
| 2 | A worker SIGKILLed mid-run is detected within the lease TTL, feature recovered, committed work preserved, burned spend retained | ✓ VERIFIED | Fast path: `packages/manager/test/scheduler/reaper.test.ts:215` ("reaches queued in well under lease_ttl_ms"). Reaper path (no `ChildProcess` available — the restarted-daemon case): `reaper.test.ts:156`. End-to-end with a real forked worker, real git commit, and real `usage_events` row, asserted intact after SIGKILL: `packages/manager/test/scenario/concurrency-crash-restart.test.ts` (closing assertions 1-3). |
| 3 | A zombie worker that wakes after lease expiry cannot overwrite newer state — write rejected on the fencing token | ✓ VERIFIED | `packages/manager/src/fencing.ts` (`checkFence`) plus the repository-level CAS. Proven independent of the message handler: `packages/manager/test/lease/fencing.test.ts:168` calls `renewLease` directly with a stale token and asserts `false`, "with no message handler in this test." The D-31 zombie scenario (`fencing.test.ts:241`) additionally asserts a `warn` log line and an incremented `staleRejections` counter. |
| 4 | Feature state, rounds, spend, and transcripts are consistent after a daemon restart | ✓ VERIFIED | `packages/manager/test/boot/daemon-restart.test.ts:149` — "boot recovers a dangling lease to queued, and leaves rounds/usage_events/feature_events intact and gap-free." Startup gate (schema version refuse-newer / copy-before-migrate) independently verified in `packages/manager/test/boot/startup-gate.test.ts`. Transcripts do not exist yet (Phase 4/OBS-02) — `03-06-PLAN.md`'s own flagged assumption records this as "satisfied by construction because there is nothing to lose," an accepted scope note, not a gap. |
| 5 | Maintainer can pause/kill one feature, one repo, or everything; concurrency configurable, defaults to 1 | ✓ VERIFIED | `packages/manager/src/scheduler/dispatcher.ts:113-132` enforces `concurrency.global` (`ConcurrencySchema.global` defaults to 1, `.min(1)` rejects 0 — `packages/core/src/config/effective-config.ts:120-139`) as an inclusive ceiling before every dispatch. `packages/cli/src/commands/pause.ts`/`kill.ts`/`resume.ts` reach `POST /control/{pause,resume,kill}` and `POST /features/:id/{pause,resume,kill}` (`packages/manager/src/api/routes/control.ts`). `packages/manager/test/control/pause.test.ts` and `kill.test.ts` cover feature/repo/all scopes; `packages/cli/test/control-verbs.test.ts` covers the CLI's `--all` interactive-confirm / `--yes` bypass / non-interactive refusal. |

**Score:** 5/5 truths verified

### Code Review Findings — Fix Verification (not re-discovered, cross-checked against the fix commits)

The phase's own `03-REVIEW.md` found one critical (CR-01) and four warnings (WR-01..04). `03-REVIEW-FIX.md` claims all five fixed. Each fix was independently re-read against the actual diff (not the SUMMARY claim):

| Finding | Fix commit | Verified in codebase |
|---|---|---|
| CR-01 (discarded CAS result — paused/killed feature could still dispatch) | `3064a60` (dispatcher), `eb69437` (control/state), `177be81` (reaper) | Confirmed: all three call sites now capture `compareAndSwapState`'s boolean, branch on it, skip the dependent writes (event append, config snapshot, `crash_count` increment) on a lost race, and the dispatcher additionally releases the lease it had just (state-blind) acquired. `applyControlEvent` now returns the captured `casApplied` instead of an unconditional `true`. |
| WR-01 (mergeConfig's clamp/discard report silently dropped) | `b5604c6` | Confirmed: `dispatchOnce` destructures `report` and logs at `warn` when `clamped`/`discarded` are non-empty; `DispatcherDeps.logger` is optional (backward compatible with existing test constructions); `daemon.ts` wires its real logger through. |
| WR-02 (`expectingExit` set only after an async DB round-trip, racing the child's own exit) | `6eb69ab` | Confirmed: `expectingExit.set(feature.id, true)` moved to the synchronous branch of the message handler, before the `void (async () => {...})()` IIFE containing `await deps.getCurrentLeaseToken(...)`. Regression test in `pause.test.ts` now supplies a real async `getCurrentLeaseToken` and asserts `unexpectedExitCalls === 0`. |
| WR-03 (no `tsconfig.test.json` for `@adl/manager`/`@adl/cli` — test/ never typechecked, stale `FeatureView` fixtures undetected) | `8bf6af4` | Confirmed: `packages/manager/tsconfig.test.json` and `packages/cli/tsconfig.test.json` exist; `typecheck` scripts run both configs; ran `pnpm --filter @adl/manager typecheck` directly — clean. Stale `stageIndex`/`pipelineLength` fixtures replaced with `stage: StageCell` in both flagged files. |
| WR-04 (empty API bearer token authenticates by comparing empty-to-empty) | `4d4f7dc` | Confirmed: `createApi` now throws at the top of the function when `deps.apiToken.length === 0`, before the Hono app is constructed. |

All five fixes verified by direct diff inspection, not by trusting `03-REVIEW-FIX.md`'s narrative. Ran `pnpm --filter @adl/manager typecheck` (clean), `pnpm --filter @adl/manager test` (130/130), `pnpm --filter @adl/cli test` (21/21) directly on this machine — matches the fix report's claimed numbers.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/manager/src/scheduler/dispatcher.ts` | Lease acquisition, concurrency cap, CAS-guarded dispatch | ✓ VERIFIED | Present, substantive, wired into `daemon.ts`'s dispatch tick; CAS result now checked (post-fix). |
| `packages/manager/src/scheduler/reaper.ts` | Lease expiry recovery, no-child-handle case | ✓ VERIFIED | Present, wired via `startReaper`; CAS result now checked (post-fix). |
| `packages/manager/src/fencing.ts` | Stale-token rejection | ✓ VERIFIED | `checkFence`, `createStaleRejectionCounter`; wired into `worker-supervisor/supervisor.ts` message handling and `GET /features`. |
| `packages/manager/src/recovery/policy.ts` | Crash-count escalation policy (max 3 consecutive) | ✓ VERIFIED | `MAX_CONSECUTIVE_CRASHES = 3`, `resetCrashCountOnSuccess`; covered by `crash-recovery.test.ts`. |
| `packages/manager/src/boot/startup.ts`, `orphans.ts`, `shutdown.ts` | Schema gate, orphan kill, graceful shutdown | ✓ VERIFIED | All present; `daemon-restart.test.ts`, `startup-gate.test.ts`, `orphans.test.ts` exercise them with real data. |
| `packages/manager/src/control/state.ts` | Pause/resume state, feature/repo/global scope | ✓ VERIFIED | `applyControlEvent` now branches on CAS result (post-fix); `createControlState` for in-memory pause flags. |
| `packages/manager/src/api/app.ts`, `routes/*.ts` | HTTP surface: features, control, health, gc | ✓ VERIFIED | Bearer-token auth (fails closed on empty token, post-fix), loopback bind, Zod-validated bodies. |
| `packages/cli/src/commands/*.ts`, `render/status-table.ts` | `adl status/pause/resume/kill/gc/daemon` | ✓ VERIFIED | All commands reach the daemon over HTTP only (`@adl/cli` has no `@adl/db` dependency — checked `packages/cli/package.json`). |
| `packages/manager/test/scenario/concurrency-crash-restart.test.ts` | The composite D-32 recovery scenario | ✓ VERIFIED | 597-line integration test: 3 concurrent features, 1 SIGKILL, 1 daemon restart with two independently-assembled "daemons" against the same on-disk DB; asserts state consistency, commit survival, unchanged spend ledger, no-double-lease (proven from the append-only `feature_events` log, not a snapshot), and orphan-worktree cleanup. Included in the 130/130 passing suite. |
| `packages/db/src/repository/features.ts` | `acquireLease`/`renewLease`/`expireLease`/`releaseLease`/`compareAndSwapState` | ✓ VERIFIED | Lease surface with structural fence at the SQL layer, independent of any message handler. |
| `.github/workflows/ci.yml` | Cross-platform CI matrix (Linux + Windows) | ✓ VERIFIED | `matrix.os: [ubuntu-latest, windows-latest]` confirmed present. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `packages/cli/src/commands/status.ts` | `GET /features` | `DaemonClient.getFeatures()` | ✓ WIRED | HTTP-only; no DB import in `@adl/cli`. |
| `packages/manager/src/api/routes/features.ts` | `featuresRepository` | `deps.listFeatureViews()` → `daemon.ts:242` real query | ✓ WIRED | Data flows from SQLite through Kysely to the HTTP response; not a static return. |
| `packages/manager/src/scheduler/dispatcher.ts` | `packages/manager/src/scheduler/reaper.ts`, `control/state.ts` | Shared `compareAndSwapState` contract | ✓ WIRED | All three call sites now check the CAS boolean identically (post CR-01 fix), verified by direct diff read. |
| `packages/manager/src/worker-supervisor/supervisor.ts` | `packages/manager/src/fencing.ts` | `checkFence` called before any repository write on every lease-scoped IPC message | ✓ WIRED | Confirmed in `supervisor.ts`'s message handler. |
| `packages/cli/src/commands/kill.ts`/`pause.ts`/`resume.ts` | `packages/manager/src/api/routes/control.ts` | `postFeatureControl` / `postControl` over HTTP | ✓ WIRED | Scope resolution (`feature`/`repo`/`all`) and blast-radius confirmation on the CLI side; matching scope handling server-side. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `GET /features` | `FeatureView[]` | `featuresRepository(db).listAll()`-equivalent query in `daemon.ts:listFeatureViews` | Yes — live SQLite rows | ✓ FLOWING |
| `adl status --json` | rendered rows | `deps.client.getFeatures()` → HTTP → live query | Yes | ✓ FLOWING |
| `POST /control/kill`, `.../pause` | `affected: string[]` | `applyControlEvent` writes checked against CAS result, only truly-changed ids returned | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| `@adl/manager` typecheck (incl. test/, post-WR-03 fix) | `pnpm --filter @adl/manager typecheck` | clean, 0 errors | ✓ PASS |
| `@adl/manager` full test suite | `pnpm --filter @adl/manager test` | 130/130 passing (16 files) | ✓ PASS |
| `@adl/cli` full test suite | `pnpm --filter @adl/cli test` | 21/21 passing (3 files) | ✓ PASS |
| CI matrix includes Windows leg | `grep matrix.os .github/workflows/ci.yml` | `[ubuntu-latest, windows-latest]` | ✓ PASS |
| Concurrency default / zero-rejection | `grep -n "global:" packages/core/src/config/effective-config.ts` | `.int().min(1).default(1)` | ✓ PASS |

Full suites were run once each (not filtered per must-have); results match the numbers claimed in `03-REVIEW-FIX.md`.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| EXEC-01 | 03-01, 03-04, 03-06, 03-08 | Manager owns queue, state, config, credentials, accounting | ⚠️ Functionally present, flagged assumption unresolved | Implementation present and tested (dispatch, state, config, HTTP-only credential boundary). REQUIREMENTS.md correctly still shows this Pending — every landing plan classified its EXEC-01 edge probe row `unclassified` and explicitly deferred the single-instance-guard question to human review (03-06-PLAN.md §Flagged assumptions). This is intentional under the project's Nyquist-validation process, not an oversight. |
| EXEC-02 | 03-01, 03-02, 03-03, 03-04 | Worker as a separate OS process, one lease | ⚠️ Functionally present, flagged assumption unresolved | `forkWorker`, IPC, lease-gated fork all present and tested (incl. the D-32 double-lease proof). 03-04-PLAN.md flags the one-worker-one-lease *mapping* as an implementation answer to an unstated requirement boundary, not yet a ratified decision. |
| EXEC-03 | 03-05 | Crash detection + recovery | ✓ SATISFIED | REQUIREMENTS.md already marks this Complete; confirmed via reaper/fast-path tests and the D-32 scenario. |
| EXEC-04 | 03-05 | Zombie fencing | ✓ SATISFIED | REQUIREMENTS.md already marks this Complete; confirmed via `fencing.test.ts`. |
| EXEC-05 | 03-07 | Concurrency, default 1 | ✓ SATISFIED | REQUIREMENTS.md already marks this Complete; confirmed via `ConcurrencySchema` and dispatcher cap logic. |
| EXEC-06 | 03-02, 03-06 | State/rounds/spend/transcripts survive restart | ✓ SATISFIED | REQUIREMENTS.md already marks this Complete; confirmed via `daemon-restart.test.ts`. Transcripts N/A this phase (Phase 4 scope), noted as an accepted assumption in 03-06-PLAN.md. |
| OBS-01 | 03-01, 03-04, 03-08 | See what every feature is doing now | ⚠️ Functionally present, flagged assumption unresolved | `adl status` fully implemented and tested against real data. REQUIREMENTS.md Pending status is explained by 03-01-PLAN.md's edge-probe table marking related rows `authored — verification: explicit` landing in 03-08, which is itself internally consistent — but the checkbox was never subsequently flipped, likely because the sibling EXEC-01/OBS-03/OBS-04 unresolved rows on the same tracking pass held the whole phase's REQUIREMENTS.md update back. |
| OBS-03 | 03-07 | Pause work | ⚠️ Functionally present, flagged assumption unresolved | Implemented and tested at feature/repo/global scope. 03-07-PLAN.md flags whether a global pause should survive a daemon restart (currently in-memory only, so a restart silently resumes dispatch) as an unresolved behavioural choice. |
| OBS-04 | 03-07, 03-08 | Kill one/repo/all | ⚠️ Functionally present, flagged assumption unresolved | Implemented and tested, including CLI blast-radius confirmation. 03-07-PLAN.md flags which of two equally-valid readings of "`--all`" is correct (stops in-flight + parks queued, as implemented, vs. stops only in-flight) as unresolved. |

**No orphaned requirements** — every ID REQUIREMENTS.md maps to Phase 3 (EXEC-01..06, OBS-01, OBS-03, OBS-04) appears in at least one plan's `requirements:` frontmatter.

### Anti-Patterns Found

None. Scanned `packages/manager/src`, `packages/cli/src`, `packages/db/src/repository`, `packages/workspace/src/exec` for `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` and "not yet implemented"/"coming soon" phrasing — zero matches.

### Human Verification Required

See frontmatter `human_verification`. Five items, all either (a) the phase's own explicitly-flagged, `unclassified` requirement-boundary assumptions that the planner deliberately routed to reviewer judgment rather than silently resolving (EXEC-01 single-instance guard, EXEC-02 one-worker-one-lease as a ratified contract, OBS-03 pause persistence across restart, OBS-04 the scope of `--all`), or (b) presentation-quality UAT items harvested from 03-08-PLAN.md's `<verify><human-check>` blocks (status table readability, daemon-down error message wording).

None of these block the phase goal as stated in ROADMAP.md — every success criterion is independently VERIFIED with passing automated tests against real data, and the underlying code makes a reasonable, tested, documented choice at each ambiguous point. They are surfaced because the plans themselves declined to auto-resolve them, and REQUIREMENTS.md's unchecked boxes for EXEC-01, EXEC-02, OBS-01, OBS-03, OBS-04 are the visible trace of that deferral, not evidence of missing functionality.

### Gaps Summary

No gaps. All five ROADMAP success criteria are VERIFIED against real, passing tests (130/130 `@adl/manager`, 21/21 `@adl/cli`, run directly on this machine — not taken from SUMMARY claims). The code-review's one critical finding (CR-01: discarded CAS result letting a paused/killed feature still dispatch) and four warnings were independently re-verified fix-by-fix against the actual commit diffs, not the fix report's narrative, and all five hold up. Status is `human_needed` rather than `passed` solely because five requirement IDs carry explicitly-flagged, unresolved design assumptions that the executing plans themselves routed to human judgment — a documentation/decision-sign-off gap, not a functional one.

---

_Verified: 2026-08-20T06:16:31Z_
_Verifier: Claude (gsd-verifier)_
