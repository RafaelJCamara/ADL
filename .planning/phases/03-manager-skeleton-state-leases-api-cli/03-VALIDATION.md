---
phase: 3
slug: manager-skeleton-state-leases-api-cli
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-19
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.10 (already installed at the workspace root and in every package) |
| **Config file** | Per-package `vitest.config.ts` + root `--project root` (see root `package.json` test script) |
| **Quick run command** | `pnpm --filter <package> test` |
| **Full suite command** | `pnpm test` (runs `pnpm -r test && vitest run --project root`) |
| **Estimated runtime** | ~60–120 seconds once the multi-process integration tests land (single-process unit tests are seconds) |

**New packages this phase adds test surface to:** `@adl/manager`, `@adl/cli`, and the worker entry point. Each needs its own Vitest config following the pattern already established in `packages/core`, `packages/db`, and `packages/workspace`.

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter <package> test` for the package the task touched
- **After every plan wave:** Run `pnpm test` (full workspace suite)
- **Before `/gsd-verify-work`:** Full suite must be green **on both Linux and Windows** (D-33)
- **Max feedback latency:** ~15 seconds for the per-package quick run; the concurrency-3 scenario test is deliberately excluded from the quick loop

**Timing note:** lease tests run with `lease_ttl_ms ≈ 200` / `heartbeat_interval_ms ≈ 50` (D-02, D-31) so real timers are exercised without slow tests. No fake clock.

---

## Per-Task Verification Map

*Populated by the planner, 2026-08-19. Task IDs are `{plan}-T{n}`, numbering tasks in the order they appear in each PLAN.md. Threat refs are the `T-3-NN` ids in each plan's `<threat_model>`.*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 03-01-T1 | 03-01 | 1 | EXEC-01 | T-3-SC | Blocking human verification of the two `[SUS]` packages before any install | checkpoint | *(human gate — no automated command)* | ❌ W0 | ⬜ pending |
| 03-01-T2 | 03-01 | 1 | EXEC-01, EXEC-02 | T-3-SC | `@adl/cli` structurally cannot resolve `@adl/db` or `@adl/manager` (D-18, D-21) | integration | `pnpm -r typecheck && pnpm --filter @adl/manager test && pnpm --filter @adl/cli test` | ❌ W0 | ⬜ pending |
| 03-01-T3 | 03-01 | 1 | EXEC-03 | T-3-10, T-3-18 | Windows CI leg exists; a platform skip writes a stated reason (D-33) | unit + config | `pnpm vitest run --project root && pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| 03-02-T1 | 03-02 | 2 | EXEC-04 | T-3-06, T-3-20 | Lease-scoped `UPDATE` carries `WHERE lease_token = ?`; the token is a required parameter (D-06, D-08) | unit | `pnpm --filter @adl/db test` | ❌ W0 | ⬜ pending |
| 03-02-T2 | 03-02 | 2 | EXEC-06 | T-3-21 | `getSchemaVersion` reports a non-integer distinguishably rather than as `NaN` (D-37) | unit | `pnpm --filter @adl/db test` | ❌ W0 | ⬜ pending |
| 03-02-T3 | 03-02 | 2 | EXEC-06 | T-3-11 | WAL + `busy_timeout` asserted, not assumed | unit | `pnpm --filter @adl/db test` | ❌ W0 | ⬜ pending |
| 03-03-T1 | 03-03 | 2 | EXEC-02 | T-3-12, T-3-22, T-3-23 | The forked worker's environment is constructed from an allowlist, never inherited (WORK-06) | integration | `pnpm --filter @adl/workspace test` | ❌ W0 | ⬜ pending |
| 03-03-T2 | 03-03 | 2 | EXEC-02 | T-3-12 | Exactly one spawn exemption, asserted by the lint suite | unit | `pnpm vitest run --project root && pnpm lint` | ❌ W0 | ⬜ pending |
| 03-04-T1 | 03-04 | 3 | EXEC-01 | T-3-01, T-3-02 | Human decision on token generation, storage, and `/health` exemption (D-19, one-way) | checkpoint | *(human gate — no automated command)* | ❌ W0 | ⬜ pending |
| 03-04-T2 | 03-04 | 3 | EXEC-01, EXEC-02, OBS-01 | T-3-01, T-3-02, T-3-07, T-3-08 | Bearer token with constant-time compare, loopback bind, Zod-validated IPC (D-01, D-19, D-20) | e2e (tracer) | `pnpm --filter @adl/manager test && pnpm --filter @adl/cli test` | ❌ W0 | ⬜ pending |
| 03-04-T3 | 03-04 | 3 | EXEC-02 | T-3-25 | The worker entry cannot import `@adl/db` — lint rule with a violation fixture (D-01) | unit | `pnpm lint && pnpm vitest run --project root` | ❌ W0 | ⬜ pending |
| 03-05-T1 | 03-05 | 4 | EXEC-03 | T-3-13 | Reaper recovers with no child handle; the fast path recovers in milliseconds (D-03, D-04, D-05) | integration | `pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| 03-05-T2 | 03-05 | 4 | EXEC-04 | T-3-06, T-3-27, T-3-29 | Stale-token write rejected at both the IPC check and the SQL predicate, and the rejection is logged and counted (D-06, D-09, D-31) | integration | `pnpm --filter @adl/manager test && pnpm --filter @adl/db test` | ❌ W0 | ⬜ pending |
| 03-05-T3 | 03-05 | 4 | EXEC-03 | T-3-13, T-3-28 | Crash recovery preserves committed work and the spend ledger; three crashes escalate (D-10, D-11, D-12) | integration | `pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| 03-06-T1 | 03-06 | 5 | EXEC-06 | T-3-05 | Human decision on the version source, the copy destination, and retention (D-37, one-way) | checkpoint | *(human gate — no automated command)* | ❌ W0 | ⬜ pending |
| 03-06-T2 | 03-06 | 5 | EXEC-01 | T-3-04, T-3-30 | One config schema, extended in place; TTL ≥ 3× interval enforced at parse (D-02, D-36) | unit | `pnpm --filter @adl/core test && pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| 03-06-T3 | 03-06 | 5 | EXEC-01, EXEC-06 | T-3-05, T-3-32 | Daemon refuses a newer schema writing nothing; copies before migrating an older one (D-35, D-37) | integration | `pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| 03-06-T4 | 03-06 | 5 | EXEC-06 | T-3-03, T-3-31 | A boot orphan kill signals only an attributable PID; shutdown gives a real grace window on both platforms (D-13, D-14, D-28 as amended, D-37) | integration | `pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| 03-07-T1 | 03-07 | 6 | EXEC-05 | T-3-14 | Concurrency cap enforced at dispatch as an inclusive ceiling; lowering drains (D-15, D-16, D-17) | integration | `pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| 03-07-T2 | 03-07 | 6 | OBS-03 | T-3-01 | Pause brakes dispatch; the in-flight round completes before parking (D-26) | integration | `pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| 03-07-T3 | 03-07 | 6 | OBS-04 | T-3-09, T-3-33, T-3-34 | Soft stop over IPC then `SIGKILL`; a killed feature lands in `paused`; `actor` recorded (D-27, D-28 as amended, D-29) | integration | `pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| 03-08-T1 | 03-08 | 7 | OBS-01 | T-3-35 | The status view reports persisted state and computes none; no spend field (D-22, D-23, D-24, D-25) | e2e | `pnpm --filter @adl/manager test && pnpm --filter @adl/cli test` | ❌ W0 | ⬜ pending |
| 03-08-T2 | 03-08 | 7 | OBS-03, OBS-04 | T-3-09, T-3-15 | `--all` requires confirmation unless `--yes`, and refuses outright when non-interactive (D-29); the token never reaches argv or output | integration | `pnpm --filter @adl/cli test` | ❌ W0 | ⬜ pending |
| 03-08-T3 | 03-08 | 7 | EXEC-01 | T-3-16, T-3-01 | Both sweeps bound, never re-derived; the lookup resolves real persisted state (D-34) | integration | `pnpm --filter @adl/manager test && pnpm --filter @adl/cli test` | ❌ W0 | ⬜ pending |
| 03-09-T1 | 03-09 | 8 | EXEC-03, EXEC-05, EXEC-06 | T-3-36 | The five D-32 closing assertions; double-leasing proven from the append-only event log | scenario | `pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| 03-09-T2 | 03-09 | 8 | EXEC-03 | T-3-17, T-3-37, T-3-03 | Every platform skip is visible and attributed; both CI legs carry the phase's evidence (D-33) | integration + docs | `pnpm test` | ❌ W0 | ⬜ pending |

**Sampling continuity:** no three consecutive tasks lack an `<automated>` verify. The three
checkpoint rows (`03-01-T1`, `03-04-T1`, `03-06-T1`) are each isolated between automated tasks.

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Success-Criterion → Observable Validation Map

The five ROADMAP success criteria, each mapped to how it is observably proven. This is the Nyquist contract for the phase — every criterion must have a test that would fail if the criterion were false.

| # | Success Criterion | How it is observably validated |
|---|---|---|
| 1 | `adl status` shows state, current stage, and round for every feature | CLI integration test against a live daemon with seeded features. Asserts on `--json` output fields (D-24), **not** on table formatting. Stage renders as `gating 2/4 (test)` — index, pipeline length, and the name resolved from the snapshotted pipeline (D-22). |
| 2 | A `SIGKILL`ed worker is detected within the lease TTL and recovered, committed work preserved, burned spend still on the ledger | Multi-process test: fork a real worker (scripted stage runner, D-30), let it commit, `SIGKILL` it mid-run. Assert (a) the feature returns to `queued` within `lease_ttl_ms`, (b) the commit is still reachable on `adl/<feature-id>`, (c) `usage_events` rows written before the crash are unchanged. Both the `child.on('exit')` fast path (D-04) and the reaper backstop (D-03) get their own case — the reaper case must run with no child handle to prove it stands alone. |
| 3 | A zombie worker cannot write stale results over newer state — rejected on the fencing token | Live zombie: scripted worker sleeps past `lease_ttl_ms` with self-termination suppressed, then reports (D-31). Assert the result is dropped, the warn log fires with both tokens, the rejection counter increments, and the newer state is intact. **Two assertions, not one** — the IPC-level rejection *and* the SQL predicate (D-06), the latter tested by calling the repository directly with a stale token so the guarantee is proven independent of the message handler. |
| 4 | Feature state, rounds, spend, and transcripts are present and consistent after a daemon restart | Start daemon, run features to a known state, stop and restart. Assert state/rounds/`usage_events` survive, all leases were expired at boot, orphans were killed (D-13), and `feature_events` has no gap or duplicate in its `seq` sequence. Also covers the schema-version gate (D-37): a daemon refuses a DB whose `meta.schema_version` is newer than itself, and copies the file before migrating an older one. |
| 5 | Pause, and kill one feature / one repo / everything; concurrency configurable, defaults to 1 | CLI tests for each scope. Pause: assert dispatch stops but the in-flight round completes before parking (D-26). Kill: assert the feature lands in `paused` (D-27), not `escalated`. Concurrency: assert the default is 1 with no config, that a cap of 3 admits exactly 3, and that lowering mid-flight drains rather than kills (D-16). `--all` without `--yes` must prompt. |

**The integration scenario (D-32)** exercises 1–5 together: 3 concurrent features, one `SIGKILL`ed, daemon restarted mid-flight. Closing assertions: all three features accounted for, committed work intact, spend ledger unchanged by the crash, zero orphan worktrees, no feature ever double-leased. This is the test that catches interaction bugs the per-criterion tests each individually miss.

---

## Wave 0 Requirements

Nothing in this phase has an existing test file, because `@adl/manager`, `@adl/cli`, and the worker entry point do not exist yet. Wave 0 must therefore establish infrastructure before any behaviour is asserted:

- [ ] `packages/manager/vitest.config.ts` + `packages/manager/test/` — following the pattern in `packages/workspace`
- [ ] `packages/cli/vitest.config.ts` + `packages/cli/test/`
- [ ] Shared test helper: temp SQLite database per test, migrated and torn down (extend `packages/db/test/helpers/` rather than writing a second one)
- [ ] Shared test helper: ephemeral-port allocation for the API server, so concurrent test files never collide
- [ ] Shared test helper: forked-worker harness with a deterministic mid-run `SIGKILL`
- [ ] **`.github/workflows/ci.yml` gains a `windows-latest` matrix leg** — D-33 requires the recovery suite on both platforms, and research confirmed the workflow currently runs `ubuntu-latest` only. This is infrastructure work, not a follow-up.
- [ ] Platform-gated test helper that **skips with a visible reason** rather than passing vacuously (Phase 2 D-21's rule, extended here)

*Vitest itself is already installed workspace-wide — no framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `adl status` table is *readable* — column alignment, truncation of long feature ids, colour legibility | OBS-01 | Formatting quality is a judgement call; the automated test asserts `--json` fields (D-24) precisely so the human check is about presentation only | Run `adl status` with ≥5 features in mixed states against a terminal ≤100 columns; confirm nothing wraps and states are distinguishable |
| `--all` confirmation prompt wording and the `--yes` bypass | OBS-04 | Interactive TTY prompt; the automated test covers the `--yes` path and the non-TTY refusal | Run `adl kill --all` in a real terminal; confirm the prompt names the blast radius and that declining changes nothing |
| Daemon-down error message is actionable | OBS-01 | Message wording is specified in CONTEXT.md D-25 but its usefulness is a human judgement | Stop the daemon, run `adl status`, confirm the message names the address and suggests `adl daemon start`, and that `echo $?` is non-zero |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references — including the `windows-latest` CI leg
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s for the per-package quick run
- [ ] Every one of the 5 success criteria has at least one test that would fail if the criterion were false
- [ ] Platform-gated tests skip with a visible reason, never pass vacuously
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
