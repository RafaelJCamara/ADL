---
phase: 03-manager-skeleton-state-leases-api-cli
verified: 2026-08-20T10:15:00Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/5
  gaps_closed:
    - "G-03-3 / OBS-03: global pause now persists to a `meta` row (write-then-flip) and restores at boot before the API binds or the first dispatch tick — proven by two real `startDaemon` processes sharing one database file across a restart (packages/manager/test/control/pause-persistence.test.ts, 6/6 passing)."
    - "EXEC-01 flagged assumption (single-instance guard) ratified: lease fence accepted as sufficient for v1, documented in packages/manager/README.md § 'No single-instance guard (accepted for v1)'."
    - "EXEC-02 flagged assumption (one-worker-one-lease as intended contract, not incidental) ratified by maintainer."
    - "OBS-04 flagged assumption (scope of `adl kill --all`) ratified: stopping every leased feature AND parking every queued one is the correct, intended reading."
    - "adl status readability: truncateId and column-padding defects found and fixed (commit 048ad85); daemon-down error message verified correct as-is."
    - "REQUIREMENTS.md bookkeeping: OBS-01 checkbox (line 125) and traceability row (line 264) flipped to Complete/`[x]` (commit 7ecc058) — the one requirement ID the UAT sign-off pass had missed. All 9 phase-3 requirement IDs now show Complete."
  gaps_remaining: []
  regressions: []
gaps: []
---

# Phase 03: Manager Skeleton — State, Leases, API, CLI Verification Report

**Phase Goal:** A crash-surviving control plane the maintainer can watch and interrupt, proven with a fake worker and no AI anywhere in the loop.
**Verified:** 2026-08-20T10:15:00Z
**Status:** passed
**Re-verification:** Yes — after UAT resolution, gap-closure plan 03-10 (G-03-3), and the OBS-01 REQUIREMENTS.md bookkeeping fix

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Maintainer runs `adl status` and sees every feature's state, current stage, and round | ✓ VERIFIED | `packages/cli/src/commands/status.ts` → `GET /features` → `packages/manager/src/api/routes/features.ts` → live `featuresRepository` rows. Regression-checked: `pnpm --filter @adl/manager test` 137/137, `pnpm --filter @adl/cli test` 21/21, both run directly on this machine. UAT item 5 (readability defects: truncateId collapsing near-simultaneous ULIDs, unaligned columns) found and fixed in commit `048ad85`, confirmed present in `git log`. |
| 2 | A worker SIGKILLed mid-run is detected within the lease TTL, feature recovered, committed work preserved, burned spend retained | ✓ VERIFIED | Unchanged since initial verification: `packages/manager/test/scheduler/reaper.test.ts`, `packages/manager/test/scenario/concurrency-crash-restart.test.ts` — both still present and passing in the 137/137 run. No files in this area were touched by 03-10. |
| 3 | A zombie worker that wakes after lease expiry cannot overwrite newer state — write rejected on the fencing token | ✓ VERIFIED | Unchanged since initial verification: `packages/manager/src/fencing.ts`, `packages/manager/test/lease/fencing.test.ts` — present and passing. Not touched by 03-10. EXEC-02's one-worker-one-lease flagged assumption is now a ratified decision (03-UAT.md test 2: "acquire-then-fork ordering ... and the per-feature active-worker map ... are the correct, intended enforcement points"), not just implemented behaviour. |
| 4 | Feature state, rounds, spend, and transcripts are consistent after a daemon restart | ✓ VERIFIED | `packages/manager/test/boot/daemon-restart.test.ts`, `packages/manager/test/boot/startup-gate.test.ts` — present and passing. EXEC-01's single-instance-guard flagged assumption is now ratified as accepted-for-v1 and documented in `packages/manager/README.md` § "No single-instance guard (accepted for v1)" (confirmed present, lines 235-254). |
| 5 | Maintainer can pause/kill one feature, one repo, or everything; concurrency configurable, defaults to 1 | ✓ VERIFIED (behaviourally, incl. the closed gap) | Feature/repo/all kill and pause/resume scopes unchanged and still covered by `packages/manager/test/control/pause.test.ts`, `kill.test.ts`. **G-03-3 closed:** a *global* pause now survives a daemon restart — `packages/db/src/repository/meta.ts` (`GLOBAL_PAUSE_KEY`, discriminated `GlobalPauseResult`), `packages/manager/src/control/state.ts` (`setGlobalPause` persists to the `meta` row *before* flipping the in-memory flag; `GlobalPausePersistError` on a failed write leaves memory untouched), `packages/manager/src/boot/startup.ts` (`restoreGlobalPause`, read-only, never writes back). Wiring confirmed by direct read of `daemon.ts`: `restoreGlobalPause` (line 191) → `createControlState` (192) → `createSupervisor` (194) → `createApi` (280) → dispatch `setInterval` (324) — the restore lands before both the API bind and the first dispatch tick, matching the plan's acceptance criteria exactly. Ran `packages/manager/test/control/pause-persistence.test.ts` directly: 6/6 passing, including the tracer test that starts two real `startDaemon` processes against the same database file across a stop/restart and proves both the negative half (still queued, no lease, no worker forked) and the non-vacuity resume half. OBS-04's `--all` scope-of-kill flagged assumption is now ratified (03-UAT.md test 4). |

**Score:** 5/5 truths verified

### Gap Closure — G-03-3 (03-10-PLAN.md)

| Item | Status | Evidence |
|---|---|---|
| Persisted `global_pause` meta row | ✓ VERIFIED | `packages/db/src/repository/meta.ts:19` (`GLOBAL_PAUSE_KEY`), `:44` (`GlobalPauseResult` union `absent`/`valid`/`invalid`), `:115-131` (`getGlobalPause`/`setGlobalPause`). Re-exported from `packages/db/src/repository/index.ts`. No new migration file (`packages/db/migrations/` unchanged — confirmed via `git log -1`); `DAEMON_SCHEMA_VERSION` untouched. |
| Boot-time restore before dispatch | ✓ VERIFIED | `restoreGlobalPause` in `boot/startup.ts`, wired at the correct D-37 slot in `daemon.ts` (line 191, before supervisor/API/dispatch — see truth 5 evidence). Read-only (asserted by test, never re-writes `updated_at`). |
| Write-through, persist-before-flip | ✓ VERIFIED | `control/state.ts`'s `setGlobalPause`: `await metaRepository(deps.db).setGlobalPause(...)` before `globalPaused = paused`; a rejected write throws `GlobalPausePersistError` and leaves `globalPaused` untouched — read directly, matches 03-10-PLAN.md design decision 3. |
| Two failure edges (unreadable value, failed write) | ✓ VERIFIED | `pause-persistence.test.ts` and `packages/db/test/repos-meta.test.ts` — both run directly, all green. `invalid` boots paused (fail-safe direction), logged at `error`; a real forced write failure (unmigrated in-memory Kysely handle, not a stub) rejects with `GlobalPausePersistError`, leaves `isGlobalPaused()` unchanged, and a subsequent `dispatchOnce` still dispatches. |
| Route-level 500 on persistence failure, with server-side logging | ✓ VERIFIED | `packages/manager/src/api/routes/control.ts:333-350` (`/control/pause`) and `:368-387` (`/control/resume`) both catch `GlobalPausePersistError`, log via `deps.logger?.error(...)` (03-10-REVIEW.md's WR-01 finding), then answer `500`. Confirmed this is not merely claimed: `git log` shows commit `7c64d10 fix(03-10): log GlobalPausePersistError server-side before returning 500 (WR-01)`, and the code at HEAD contains the logger call — read directly, not inferred from the commit message. |
| README documents the asymmetry | ✓ VERIFIED | `packages/manager/README.md:212` "A global pause survives a restart; a repo-scoped pause does not." plus the startup-sequence restore step (lines ~133-138). |

**03-10-REVIEW.md status:** `issues_found` (0 critical, 1 warning [WR-01], 2 info). WR-01 was fixed in a follow-up commit (`7c64d10`) that lands after the review — confirmed fixed in the current codebase, not merely claimed in a SUMMARY. The two info-level notes (IN-01: duplicated discriminated get/set pattern; IN-02: incomplete boot-order comment) are non-blocking style notes, left as-is, consistent with the review's own "not urgent" framing.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/db/src/repository/meta.ts` | `GLOBAL_PAUSE_KEY`, `GlobalPauseResult`, `getGlobalPause`/`setGlobalPause` | ✓ VERIFIED | Present, substantive, exported via barrel, exercised by `repos-meta.test.ts`. |
| `packages/manager/src/control/state.ts` | `ControlStateDeps`, persist-then-flip `setGlobalPause`, `GlobalPausePersistError` | ✓ VERIFIED | Read directly — matches plan exactly (see truth 5 evidence). |
| `packages/manager/src/boot/startup.ts` | `restoreGlobalPause` | ✓ VERIFIED | Read-only restore, wired into `daemon.ts` at the correct slot. |
| `packages/manager/test/control/pause-persistence.test.ts` | Tracer test proving restart survival + both failure edges | ✓ VERIFIED | 6/6 tests passing, run directly on this machine. |
| `packages/manager/README.md` | Documents startup-sequence restore step and pause-persistence asymmetry | ✓ VERIFIED | Both sections present and read directly. |
| All previously-verified Phase 3 artifacts (dispatcher, reaper, fencing, boot/startup, control/state pause-kill surface, API routes, CLI commands, D-32 scenario test) | Unchanged, still present and wired | ✓ VERIFIED | Full regression run: `@adl/manager` 137/137 (up from 130/130 — the +7 are the new pause-persistence/repos-meta cases), `@adl/cli` 21/21, `@adl/db` 75/75, root-project suite (incl. `platform-gate-discipline`) 63/63, `pnpm -r typecheck` clean across all 6 packages. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `packages/manager/src/daemon.ts` | `boot/startup.ts`'s `restoreGlobalPause` | Awaited before `createControlState`, `createSupervisor`, `createApi`, and the dispatch `setInterval` | ✓ WIRED | Confirmed by direct line-numbered read of `daemon.ts` (191 → 192 → 194 → 280 → 324). |
| `packages/manager/src/control/state.ts`'s `setGlobalPause` | `packages/db/src/repository/meta.ts`'s `metaRepository(db).setGlobalPause` | Write-through, awaited before the in-memory flag flips | ✓ WIRED | Confirmed by direct read; a rejected write throws before the flip line executes. |
| `packages/manager/src/api/routes/control.ts` | `GlobalPausePersistError` | Caught specifically in both `/control/pause` and `/control/resume` handlers, logged, then 500 | ✓ WIRED | Confirmed by direct read; matches 03-10-REVIEW.md's WR-01 fix. |
| All Key Links verified in the initial 03-VERIFICATION.md pass (status→API, features→repository, dispatcher/reaper/control→shared CAS contract, supervisor→fencing, CLI control verbs→control routes) | Unchanged | — | ✓ WIRED (regression) | None of these files were touched by 03-10; confirmed still present and exercised by the passing 137/137 `@adl/manager` suite. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `restoreGlobalPause` | `initialGlobalPause: boolean` | `metaRepository(db).getGlobalPause()` — live SQLite `meta` row read at boot | Yes — asserted `false` for `absent`, the stored boolean for `valid`, `true` (fail-safe) for `invalid` | ✓ FLOWING |
| `POST /control/pause` (scope `all`/`repo`) | persisted `meta` row | `pauseScope` → `setGlobalPause` → `metaRepository(db).setGlobalPause` | Yes — asserted directly in `pause.test.ts`'s new meta-row assertion | ✓ FLOWING |
| `GET /features`, `adl status --json` | `FeatureView[]` | Unchanged from initial verification — live query | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| `@adl/db` full test suite | `pnpm --filter @adl/db test` | 75/75 passing (9 files) | ✓ PASS |
| `@adl/manager` full test suite | `pnpm --filter @adl/manager test` | 137/137 passing (17 files) | ✓ PASS |
| `@adl/cli` full test suite | `pnpm --filter @adl/cli test` | 21/21 passing (3 files) | ✓ PASS |
| Root-project suite (incl. `platform-gate-discipline` guard) | `pnpm exec vitest run --project root` | 63/63 passing (4 files) | ✓ PASS |
| `pnpm -r typecheck` (all 6 packages) | — | Clean, 0 errors | ✓ PASS |
| `pause-persistence.test.ts` in isolation (the tracer + both failure edges) | `vitest run test/control/pause-persistence.test.ts` | 6/6 passing | ✓ PASS |
| `prettier --check` on the 5 files 03-10 touched most directly | — | All matched files use Prettier code style | ✓ PASS |
| WR-01 fix present at HEAD (not just claimed) | `grep -n GlobalPausePersistError packages/manager/src/api/routes/control.ts` | logger call present at both catch sites | ✓ PASS |

All suites run once each directly on this machine (not taken from SUMMARY/REVIEW claims); numbers exceed the prior pass's counts by exactly the tests 03-10 added, with no regressions.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| EXEC-01 | 03-01, 03-04, 03-06, 03-08 | Manager owns queue, state, config, credentials, accounting | ✓ SATISFIED | Functionally verified in the initial pass (unchanged). Flagged assumption (single-instance guard) now ratified — accepted for v1, documented in README. REQUIREMENTS.md: `[x]`, `Complete`. |
| EXEC-02 | 03-01, 03-02, 03-03, 03-04 | Worker as a separate OS process, one lease | ✓ SATISFIED | Functionally verified (unchanged). Flagged assumption (one-worker-one-lease as intended contract) now ratified. REQUIREMENTS.md: `[x]`, `Complete`. |
| EXEC-03 | 03-05 | Crash detection + recovery | ✓ SATISFIED | Unchanged, still passing. REQUIREMENTS.md: `[x]`, `Complete`. |
| EXEC-04 | 03-05 | Zombie fencing | ✓ SATISFIED | Unchanged, still passing. REQUIREMENTS.md: `[x]`, `Complete`. |
| EXEC-05 | 03-07 | Concurrency, default 1 | ✓ SATISFIED | Unchanged, still passing. REQUIREMENTS.md: `[x]`, `Complete`. |
| EXEC-06 | 03-02, 03-06 | State/rounds/spend/transcripts survive restart | ✓ SATISFIED | Unchanged, still passing. REQUIREMENTS.md: `[x]`, `Complete`. |
| OBS-01 | 03-01, 03-04, 03-08 | See what every feature is doing now | ✓ SATISFIED | `adl status` fully implemented, tested against real data, and its only outstanding UAT item (table readability + daemon-down message) resolved with a fix landed in `048ad85`. `.planning/REQUIREMENTS.md` flipped to Complete in commit `7ecc058`. |
| OBS-03 | 03-07, 03-10 | Pause work | ✓ SATISFIED | G-03-3 closed by 03-10 — global pause now survives a restart, proven by a real two-process test. REQUIREMENTS.md: `[x]`, `Complete`. |
| OBS-04 | 03-07, 03-08 | Kill one/repo/all | ✓ SATISFIED | Flagged assumption (scope of `--all`) now ratified. REQUIREMENTS.md: `[x]`, `Complete`. |

**No orphaned requirements** — every ID REQUIREMENTS.md maps to Phase 3 appears in at least one plan's `requirements:` frontmatter, including 03-10's `[OBS-03]`.

**All 9 requirement IDs show `Complete` in REQUIREMENTS.md.**

### Anti-Patterns Found

None. Scanned the files 03-10 modified (`packages/db/src/repository/meta.ts`, `packages/manager/src/control/state.ts`, `packages/manager/src/boot/startup.ts`, `packages/manager/src/daemon.ts`, `packages/manager/src/api/routes/control.ts`, `packages/manager/src/index.ts`, `packages/manager/README.md`) for `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` and "not yet implemented"/"coming soon" phrasing — zero matches. The prior pass's scan of the rest of `packages/manager/src`, `packages/cli/src`, `packages/db/src/repository`, `packages/workspace/src/exec` remains valid (none of those files were touched by 03-10).

### Human Verification Required

None. All five items from the prior `human_verification` list (EXEC-01, EXEC-02, OBS-03, OBS-04 flagged assumptions; adl status readability + daemon-down message) are resolved per `03-UAT.md` (5/5 passed) and independently re-confirmed against the codebase above — not merely trusted from the UAT narrative. No new human-judgment items were introduced by 03-10 (its own SUMMARY's `D4` coverage item, README documentation quality, is a judgment call the maintainer already exercised in accepting the plan; it does not gate this phase's five ROADMAP success criteria).

One item was explicitly noted as *found but out of scope* during UAT and is not a gap of this phase: `adl status` prints a raw Node stack trace instead of a friendly message when `.adl/daemon.json` has never been created (as opposed to "daemon down but config exists," which was verified correct). This was flagged by the maintainer during UAT as a future fix, not a blocker for this phase's success criteria.

### Gaps Summary

None. The phase goal is fully achieved: all 5 ROADMAP success criteria are VERIFIED against real, passing tests re-run directly on this machine (75/75 `@adl/db`, 137/137 `@adl/manager`, 21/21 `@adl/cli`, 63/63 root-project), the one substantive gap identified in the prior pass (G-03-3 — global pause not surviving a restart) is closed and behaviourally proven by a real two-daemon-process restart test, the code-review warning on the gap-closure plan itself (WR-01) was independently confirmed fixed at HEAD, and the one bookkeeping gap (OBS-01's REQUIREMENTS.md row) has been fixed (commit `7ecc058`). All 9 phase-3 requirement IDs now show Complete.

---

_Verified: 2026-08-20T10:05:00Z_
_Verifier: Claude (gsd-verifier)_
