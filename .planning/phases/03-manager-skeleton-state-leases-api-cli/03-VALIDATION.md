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

*Populated by the planner — one row per task once PLAN.md files exist. The table below records the mapping that must hold; task IDs are filled in during planning.*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | EXEC-01 | — | N/A | integration | `pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | EXEC-02 | — | Worker holds exactly one lease; never opens the DB (D-01) | integration | `pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | EXEC-03 | — | Crash recovery preserves committed work and the spend ledger | integration | `pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | EXEC-04 | T-3-fencing | Stale-token write rejected at both the IPC check and the SQL predicate (D-06) | integration | `pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | EXEC-05 | — | Concurrency cap enforced at dispatch; lowering drains (D-16) | integration | `pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | EXEC-06 | T-3-schema-gate | Daemon refuses a newer schema; copies the DB before migrating (D-37) | integration | `pnpm --filter @adl/manager test` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | OBS-01 | — | N/A | integration | `pnpm --filter @adl/cli test` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | OBS-03 | — | Pause brakes dispatch; in-flight round completes (D-26) | integration | `pnpm --filter @adl/cli test` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | OBS-04 | T-3-blast-radius | `--all` requires confirmation unless `--yes` (D-29) | integration | `pnpm --filter @adl/cli test` | ❌ W0 | ⬜ pending |

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
