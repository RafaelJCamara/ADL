---
phase: 2
slug: workspace-the-exec-boundary
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-18
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Filled from `02-RESEARCH.md § Validation Architecture`, which is the authoritative source.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.10 (`catalog:`) |
| **Config file** | `packages/workspace/vitest.config.ts` — does not exist yet; created by plan `02-03` Task 1. Auto-enrolled by the root `projects: ['packages/*/vitest.config.ts']` glob, so **no root config edit is required** |
| **Quick run command** | `pnpm vitest run --project workspace` |
| **Full suite command** | `pnpm test` (`pnpm -r test && vitest run --project root`) |
| **Estimated runtime** | ~30 seconds — the git-integration tests dominate; reuse one temp repository per file via a `beforeAll` fixture rather than one per test |

---

## Sampling Rate

- **After every task commit:** Run `pnpm vitest run --project workspace` (or `--project root` for plan `02-02`, which touches no package suite)
- **After every plan wave:** Run `pnpm test && pnpm lint && pnpm typecheck`
- **Before `/gsd-verify-work`:** Full suite green **on Linux CI** — two acceptance criteria cannot execute on the Windows development machine (D-21)
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 2-01-01 | 01 | 1 | WORK-01, WORK-02 | T-2-SC | Package identity confirmed on the public registry before the first install | manual gate | n/a — blocking human checkpoint | n/a | ⬜ pending |
| 2-02-01 | 02 | 1 | WORK-02 | T-2-01 / T-2-02 / T-2-03 | Direct spawn banned in all three import forms outside `packages/workspace` | lint-as-test | `pnpm lint` | ✅ | ⬜ pending |
| 2-02-02 | 02 | 1 | WORK-02 | T-2-01 / T-2-02 / T-2-02b | Each form **and each specifier** is watched failing against a committed fixture | lint-as-test | `pnpm vitest run --project root` | ⚠️ 4 new fixtures | ⬜ pending |
| 2-02-03 | 02 | 1 | WORK-02 | T-2-03 / T-2-02b / T-2-05 | Phase 1's purity bans survive; every banned specifier has syntax coverage; the exemption is proven from both sides | lint-as-test | `pnpm vitest run --project root` | ⚠️ new cases | ⬜ pending |
| 2-03-01 | 03 | 2 | WORK-01, WORK-02, WORK-06 | T-2-10 | Published type surface + package scaffolding; `argv` arrays only, `PATH` required by the type | compile-time (build + typecheck) | `pnpm -r build` | ✅ | ⬜ pending |
| 2-03-02 | 03 | 2 | WORK-01, WORK-02, WORK-06 | T-2-06 / T-2-07 / T-2-09 / T-2-SC | **Tracer.** Zero-inherit env; killed descendants; tagged streaming; both halves of teardown | integration (real git, temp repo) | `pnpm vitest run --project workspace` | ❌ W0 | ⬜ pending |
| 2-03-03 | 03 | 2 | WORK-02 | — | The published surface is a re-export, never a redeclaration | unit | `pnpm vitest run --project plugin-sdk` | ✅ | ⬜ pending |
| 2-04-01 | 04 | 3 | WORK-01, WORK-04 | T-2-11 / T-2-13 / T-2-14 | Both worktree and branch reclaimed, in the forced order, idempotently | integration | `pnpm vitest run --project workspace -t "lifecycle"` | ❌ W0 | ⬜ pending |
| 2-04-02 | 04 | 3 | WORK-01, WORK-04 | T-2-14 | Inventory scoped to ADL's own worktrees, ordered and stable | unit + integration | `pnpm vitest run --project workspace -t "list"` | ❌ W0 | ⬜ pending |
| 2-04-03 | 04 | 3 | WORK-04 | T-2-12 / T-2-15 | Collection decided by feature state only; `escalated` spared | integration (temp DB + temp repo) | `pnpm vitest run --project workspace -t "gc"` | ❌ W0 | ⬜ pending |
| 2-05-01 | 05 | 3 | WORK-06, WORK-07 | T-2-16 / T-2-18 / T-2-19 / T-2-22 | One env builder; nothing inherited; no prefix pass-through | unit | `pnpm vitest run --project workspace -t "env"` | ❌ W0 | ⬜ pending |
| 2-05-02 | 05 | 3 | WORK-05, WORK-07 | T-2-17 / T-2-20 / T-2-21 | Fresh unpredictable scratch HOME per run; idempotent teardown | integration | `pnpm vitest run --project workspace -t "scratch home"` | ❌ W0 | ⬜ pending |
| 2-05-03 | 05 | 3 | WORK-06 | T-2-16 / T-2-19 | No credential pattern in a real child's dumped environment | integration | `pnpm vitest run --project workspace -t "credentials"` | ❌ W0 | ⬜ pending |
| 2-06-01 | 06 | 4 | WORK-01 | T-2-23 / T-2-24 / T-2-25 / T-2-28 | Path traversal and symlink escape rejected at the interface | unit | `pnpm vitest run --project workspace -t "containment"` | ❌ W0 | ⬜ pending |
| 2-06-02 | 06 | 4 | WORK-03 | T-2-26 / T-2-27 | Unknown backend id fails loudly; snapshot refuses partial capture | integration | `pnpm vitest run --project workspace` | ❌ W0 | ⬜ pending |
| 2-06-03 | 06 | 4 | WORK-03 | T-2-27 | One suite over two backends; registry is the sole construction site | contract (parameterised) | `pnpm vitest run --project workspace -t "workspace contract"` | ❌ W0 | ⬜ pending |
| 2-07-01 | 07 | 5 | WORK-05, WORK-07 | T-2-29 / T-2-30 / T-2-31 / T-2-32 / T-2-35 | Supplementary groups dropped; config file not worker-writable | integration | `pnpm vitest run --project workspace` | ❌ W0 | ⬜ pending |
| 2-07-02 | 07 | 5 | WORK-05 | T-2-30 / T-2-33 | Skip is loud; a misconfigured Linux run fails rather than skips | integration, **Linux-only, skips visibly elsewhere** | `pnpm vitest run --project workspace -t "privilege"` | ❌ W0 — cannot run on this machine | ⬜ pending |
| 2-07-03 | 07 | 5 | WORK-05 | T-2-33 / T-2-34 | The `adl-worker` provisioning, the exported worker variables, and the sudoers documentation all exist — asserted, not assumed | config | `node -e` compound assertion over `ci.yml`, the README, and the manifest | ⚠️ `ci.yml` exists | ⬜ pending |
| 2-07-04 | 07 | 5 | WORK-05 | T-2-33 | The Linux evidence has actually been produced on Linux | manual gate | n/a — blocking human checkpoint | n/a | ⬜ pending |
| 2-08-01 | 08 | **6** | WORK-02, WORK-07 | T-2-39 / T-2-40 | ADL's git runs through the one exec boundary, from an ADL-owned home | integration | `pnpm vitest run --project workspace` | ❌ W0 | ⬜ pending |
| 2-08-02 | 08 | **6** | WORK-07 | T-2-36 / T-2-37 | No reachable git invocation without the neutralisation prefix | unit | `pnpm vitest run --project workspace -t "manager git"` | ❌ W0 | ⬜ pending |
| 2-08-03 | 08 | **6** | WORK-07 | T-2-36 / T-2-37 / T-2-38 / T-2-41 | A poisoned hooks path does not fire; each key proven individually | integration | `pnpm vitest run --project workspace -t "poisoned"` | ❌ W0 | ⬜ pending |

**Wave note:** plan `02-08` moved from Wave 5 to Wave 6. Its Task 3 imports the visible-skip helper `packages/workspace/test/helpers/platform.ts`, which plan `02-07` Task 2 creates; run in parallel the file would not reliably exist. Adding the dependency rather than hand-rolling a second skip helper is deliberate — a second implementation is how the silent skip D-21 exists to prevent comes back.

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Test infrastructure that must land before the assertions above can run. All of it is created inside plans rather than as a separate scaffolding pass, so no plan is blocked waiting on a preparatory one.

- [ ] `packages/workspace/package.json`, `tsconfig.json`, `vitest.config.ts` (`name: 'workspace'`) — plan `02-03` Task 1. No root `vitest.config.ts` edit: the `projects` glob auto-enrols the package
- [ ] `packages/workspace/test/helpers/temp-repo.ts` — a real temp git repository plus a scratch root, mirroring `packages/db/test/helpers/temp-db.ts` — plan `02-03` Task 2 (Task 1 is declarations + scaffolding only and touches no test files)
- [ ] `packages/workspace/test/helpers/env-dump-child.cjs` — the real child script the credential assertion spawns — plan `02-05` Task 3
- [ ] `packages/workspace/test/helpers/platform.ts` — `linuxOnly(reason)`, the visible-skip helper — plan `02-07` Task 2
- [ ] `packages/workspace/test/helpers/contract.ts` — `describeWorkspaceContract(name, factory)` — plan `02-06` Task 3
- [ ] `test/lint/fixtures/spawn-direct-import.ts`, `spawn-require.ts`, `spawn-dynamic-import.ts`, `spawn-dynamic-execa.ts` — plan `02-02` Task 2. Mandatory, not optional: the existing exhaustiveness test asserts registered rule ids exactly equal exercised ones. The fourth fixture covers the non-builtin dynamic-import bypass that the other three cannot detect

### Not Wave 0 — Linux worker-user provisioning

`.github/workflows/ci.yml`'s `adl-worker` provisioning lands in **Wave 5**, in plan `02-07` Task 3 — the same plan as the privilege tests that consume it. A previous revision of this file listed it under Wave 0; that label was wrong and is corrected here.

It is not Wave 0 scaffolding and does not need to be. **The workflow already exists and already runs on `ubuntu-latest` across Node 22 and 24** (`02-PATTERNS.md`'s claim that no workflow directory exists is stale — extend the existing job, do not create a second). Because the provisioning ships in the same plan as the assertions that depend on it, no test can green vacuously while waiting for it: plan `02-07` Task 2's `linuxOnly` helper *fails* rather than skips when the platform is Linux and the worker user is unset, so a Linux run without the provisioning step goes red. D-21's "Wave 0 scaffolding" framing refers to the Linux CI *job* as a phase-level prerequisite — which the existing workflow already satisfies — not to this step's wave assignment.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `execa` and `simple-git` are the packages the research names | WORK-01, WORK-02 | A `[SUS]` legitimacy verdict is never auto-approvable; only a human comparing the registry page to the intended package closes it | Plan `02-01` Task 1 — open both package pages, confirm the canonical source repository and the version |
| The Linux-only privilege assertions actually executed and passed | WORK-05 | A green local suite and a green CI suite are indistinguishable from inside the repository; only reading the workflow run shows whether the cases ran or skipped | Plan `02-07` Task 4 — open the CI run, expand the Test step in both matrix legs, confirm the privilege cases are reported passed rather than skipped |
| The Pitfall-1 regression guard, the per-specifier selector-coverage assertion, and the sole-construction-site assertion have been watched failing | WORK-02, WORK-03 | A guard nobody has watched fail is a guard that ships mis-scoped — the failure this repository's lint suite exists to prevent. The coverage assertion in particular was added because the first draft of `02-02` shipped syntax selectors covering only `child_process`, leaving `execa` and `simple-git` reachable by dynamic `import()` with `pnpm lint` green | Plans `02-02` Task 3 (twice: wrong entry order, then hand-written `child_process`-only selectors) and `02-06` Task 3 — deliberately break each property once, observe red, restore, record in the SUMMARY |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] Linux CI has run the privilege assertions green (D-21)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
