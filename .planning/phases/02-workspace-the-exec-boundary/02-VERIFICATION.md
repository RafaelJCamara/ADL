---
phase: 02-workspace-the-exec-boundary
verified: 2026-08-18T22:15:00Z
status: gaps_found
score: 4/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "No code path anywhere launches a process except through the workspace exec path, enforced by a lint rule that fails the build on a direct spawn outside the workspace module. (ROADMAP SC2; 02-02-PLAN must_have: 'A static import of node:child_process, child_process, execa, or simple-git anywhere outside packages/workspace fails pnpm lint at severity 2')"
    status: partial
    reason: >-
      The runtime property holds today — verified repo-wide, the only import of `execa`
      is `packages/workspace/src/exec/run.ts` and no `child_process` use exists anywhere.
      The ENFORCEMENT half does not. The `adl/no-direct-spawn` entry is registered with
      `files: ['**/*.ts']`, so a `.mts`, `.cts` or `.tsx` file anywhere outside
      `packages/workspace` may `import { execa }` and `pnpm lint` stays green.
      Demonstrated empirically, not inferred: a probe file `packages/db/src/probe.mts`
      containing `import { execa } from 'execa'` produced ZERO `no-restricted-imports`
      and ZERO `no-restricted-syntax` errors, while the base recommended rules
      (`@typescript-eslint/no-unused-vars`) fired on the same file — proving ESLint did
      process it and the architecture rule simply never matched. The identical content
      in a `.ts` file reports at severity 2. This is 02-REVIEW.md WR-11, classified a
      Warning, left "Not touched" by the remediation pass, and NOT recorded in
      `deferred-items.md` — so it currently has no reproduction, no owning phase, and no
      acceptance decision. The same glob gap also silences the two source-tree guards in
      `test/contract/workspace-contract.test.ts`, whose `typescriptSources()` walker
      filters on `entry.name.endsWith('.ts')`.
    artifacts:
      - path: "eslint.config.js"
        issue: "`adl/no-direct-spawn` and `adl/no-simple-git-in-workspace-src` are registered with `files: ['**/*.ts']` / `['packages/workspace/src/**/*.ts']`; `.mts`, `.cts`, `.tsx` (and `.js`/`.mjs`/`.cjs`) are outside the rule's reach."
      - path: "packages/workspace/test/contract/workspace-contract.test.ts"
        issue: "`typescriptSources()` filters on `.ts` only, so the registry sole-construction-site guard and the `simple-git` source scan would both miss a `.mts` module under `src/`."
    missing:
      - "Extend the spawn-ban globs to `**/*.{ts,tsx,mts,cts}` (and the workspace-src carve-out to `packages/workspace/src/**/*.{ts,tsx,mts,cts}`)."
      - "Extend `typescriptSources()` in the contract suite to the same extension set."
      - "Add a `.mts` deliberate-violation fixture beside the four existing `test/lint/fixtures/spawn-*.ts` fixtures, so the extension coverage has its own regression guard."
      - "If the gap is instead accepted (repo is `.ts`-only by policy), record it in `deferred-items.md` with the reproduction above and an owning phase, rather than leaving it only in a SUMMARY's 'Not touched' list."
deferred:
  - truth: "An agent can run git inside its own worktree on a provisioned Linux deployment"
    addressed_in: "Phase 4"
    evidence: >-
      `deferred-items.md` § D-2-08-1. Phase 4 goal: "Claude Code headless makes a real
      commit through the workspace, streamed live" — the first phase in which an agent
      runs git in its worktree, and the phase whose success criteria this blocks. It
      fails no WORK-01..07 wording: WORK-01 promises the feature *gets* a worktree
      (it does, created by the daemon), not that the dropped worker can run git in it.
human_verification:
  - test: >-
      Run D-2-R-1's cross-feature reproduction on the Linux CI runner: provision two
      worktrees under the scratch root for features `feat-a` and `feat-b`, then as the
      `adl-worker` identity attempt `echo x >> /srv/adl/scratch/feat-b/src/index.ts`.
    expected: >-
      Confirm whether the write succeeds (exploit confirmed) or is refused (exploit
      refuted). `deferred-items.md` marks this "[NOT YET REPRODUCED ON A LINUX HOST —
      derived from the code and the mode bits]" and explicitly says to run it before
      treating the exploit as confirmed AND before treating it as refuted.
    why_human: >-
      Requires a provisioned Linux host with two live workspaces and a real uid drop.
      The maintainer's machine is Windows, where the drop does not apply at all. The
      whole finding currently rests on code reading, which is exactly the "control
      assessed for the wrong reason" shape this phase keeps producing.
  - test: >-
      Decide whether D-2-R-1 (one worker identity for every concurrent feature, so
      feature A's agent can read and rewrite feature B's worktree and scratch HOME) is
      an acceptable residual for Phase 2 to ship on.
    expected: >-
      An explicit accept/reject. Verifier assessment: it does NOT contradict WORK-05 or
      SC4 as written — both say "a dedicated unprivileged OS user with a per-run scratch
      HOME", singular, and both are delivered. It IS a real supply-chain path from an
      untrusted spec (D-22) into a human-approved PR. It is stated at the definition
      (`WorkerIdentity` docblock), in `README.md` § "What is not isolated", and in
      `deferred-items.md` with a proposed pool design.
    why_human: >-
      A scope/risk acceptance, not a code fact. Phase 3 SC5 ("concurrency is
      configurable and defaults to one feature in flight") materially bounds the
      exposure and is the natural owner, but nothing in Phase 3's success criteria
      names per-feature worker identities, so it is not automatically covered.
  - test: >-
      Decide the owner for the WR-12 residual: a committed `.gitattributes` selecting an
      attacker-named `filter.<driver>.clean` executes an arbitrary program during ADL's
      own `snapshot()`, with the full `NEUTRALISE_ARGS` set in force.
    expected: >-
      An owning phase, or an explicit acceptance. The residual is honestly recorded
      (`NEUTRALISATION_RESIDUAL_RISK`) and — unusually and commendably — *demonstrated*
      by a passing test that asserts the hole is open
      (`test/git/neutralisation-residual-risk.test.ts`, with a `git check-attr` control
      so it cannot pass vacuously). Phase 15's success criteria are about write
      auditing, secret scanning, egress and a published threat model; none of them names
      git config neutralisation, so the match is too tangential to auto-defer.
    why_human: >-
      Requires a judgement about whether "agent-written configuration cannot affect
      ADL's own git operations" (WORK-07) is satisfied by covering the eight fixed-name
      keys plus an OS layer that is Linux-only, with the wildcard driver family open on
      every other platform.
  - test: >-
      Confirm the disposition of the six review findings the remediation pass left
      untouched and that are absent from `deferred-items.md`: WR-01 (`exec()` never
      validates `ExecSpec.cwd` against the workspace root), WR-02 (`buildChildEnv` does
      not reserve `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`), WR-07
      (`assertWithinRoot` TOCTOU), WR-13 (workspace tests are never typechecked), WR-14
      (CI is Linux-only so Windows branches are unverified), and every `IN-*`.
    expected: >-
      Each either fixed, or recorded in `deferred-items.md` with an owning phase, on the
      same standard the seven items already there meet.
    why_human: >-
      These are currently recorded only in a prose "Not touched" paragraph at the end of
      `02-07-SUMMARY.md`. That is an audit-trail decision, not a code fact. WR-01 and
      WR-02 are the two that touch this phase's own subject matter: `exec()`'s `cwd` is
      unguarded while `read()`/`write()` are guarded by `assertWithinRoot`, and
      `env.ts`'s own docblock names `GIT_CONFIG_COUNT` as arbitrary code execution while
      not reserving it.
---

# Phase 2: Workspace & the Exec Boundary — Verification Report

**Phase Goal:** Every process ADL launches — including agent CLIs — runs through one swappable workspace, with the worker's blast radius bounded before any adapter exists to break the rule.
**Verified:** 2026-08-18T22:15:00Z
**Status:** gaps_found (one gap; see the verdict at the end — the goal is substantively achieved)
**Re-verification:** No — initial verification
**Verified against:** `8ccbd9a` (working tree clean apart from two untracked research-cache files; identical to the SHA CI run `32179487755` executed)

## Method note

Every claim below was checked against source or against a command I ran, never against a SUMMARY. Where a must-have rests on a test, I state whether that test could actually fail — and in two cases I proved it by breaking the code and watching the suite go red, or by constructing the violation the rule claims to catch.

`ROADMAP.md` marks this phase `Mode: mvp`, but its goal is not a User Story (`As a …, I want to …, so that ….`). MVP-mode User Flow Coverage was therefore not applied; the phase's five Success Criteria are a complete and well-formed contract and were used as the must-have set, merged with the eight PLANs' `must_haves.truths`. Flagging the mode/goal mismatch as an observation, not a defect — Phase 1 and Phases 3–18 carry the same `Mode: mvp` line with non-User-Story goals, so this is a project-wide default rather than anything this phase did.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Each feature gets its own git worktree, and a finished feature leaves behind no worktree and no branch — verified by running many features and then a GC pass | ✓ VERIFIED | `test/worktree/gc.test.ts:203` creates **8** features reaching the end by two different real routes (clean terminal transition ×6, crashed-with-directory-deleted ×2), sweeps, then asserts **both halves independently**: `git worktree list` names no path under the scratch root, `listManagedWorktrees()` returns `[]`, AND `git branch --list 'adl/*'` is empty. The test's own comment records that plan 02-03 proved the first assertion passes while the second fails — i.e. the second half is there because it caught a real defect. Idempotency, prefix-collision (`feat-1` vs `feat-1-evil`), and per-entry-failure-continues cases all present. Ran green on Linux CI at this SHA. |
| 2 | No code path anywhere launches a process except through the workspace exec path, enforced by a lint rule that fails the build on a direct spawn outside the workspace module | ⚠️ PARTIAL — enforcement gap | **Runtime half TRUE**, verified repo-wide: the only `execa` import in source is `packages/workspace/src/exec/run.ts`; zero `child_process` uses anywhere; the only non-`.ts` files in the repo are `eslint.config.js` and one test helper `.cjs`, neither of which spawns. **Enforcement half INCOMPLETE** — see Gaps. |
| 3 | A second workspace backend is registered and the loop runs against it unchanged — proven with an in-repo stub backend and zero call-site edits | ✓ VERIFIED | `registry.ts` is the sole factory site; `test/contract/workspace-contract.test.ts` proves it by reading every `src/` file and reporting offenders by filename, **with a positive control** ("confirms registry.ts really does name both, so the guard is not vacuous" — without it, deleting both backends would make the guard pass). `test/helpers/contract.ts` contains **zero backend-id branching** (grep for `worktree`/`stub`/`host-git` hits only prose in comments) and its 10 cases run twice via `describeWorkspaceContract('worktree', …)` / `('stub', …)`. Ran locally: **36 passed**. Both backends call the *same* `assertWithinRoot` against a *real* root — the stub's is `await realpath(await mkdtemp(…))`, so the guard's realpath step is not vacuous on the stub. |
| 4 | The worker runs as a dedicated unprivileged OS user with a per-run scratch `HOME`; agent-written `.npmrc`, `.gitconfig`, or hooks-path configuration does not survive the run and never affects ADL's own git operations | ✓ VERIFIED | Both clauses, at depth — see the dedicated section below. Linux CI at this SHA: **183 passed, 0 skipped, zero `[ADL][SKIPPED]` lines** on both node 22 and node 24. |
| 5 | Forge tokens and model API keys are absent from the worker's ambient environment — asserted by dumping a child process's environment in a test | ✓ VERIFIED | `test/exec/credentials.test.ts` sets real sentinels in the *parent* (`ghp_adl0205…`, `sk-ant-adl0205…`), spawns a real `.cjs` child that dumps its own environment, and asserts nine credential-name patterns and both literal values absent — **with a positive control** (`expect(dumped).toContain('PATH')`) so an empty dump cannot satisfy it. The scoping case asserts **from both sides**: a key named on one `ExecSpec` is present in that child and absent from a sibling — so "the key never reached anything" cannot pass either. `buildChildEnv` reads `process.env` **never**; `execa` is called with `extendEnv: false`. |

**Score: 4/5 truths verified.**

### Success Criterion 4, in detail — the phase's own subject matter

The brief warned that this phase's recurring defect is controls that pass for the wrong reason. Each control below is reported with what would make it fail.

**Would the Linux privilege evidence fail if the drop were broken?** Yes, four independent ways:

- `test/helpers/platform.ts` `linuxOnly()` **throws** — not skips — on a Linux runner with `ADL_WORKER_USER` or `ADL_WORKER_GROUP` unset. A CI job that forgot provisioning goes red instead of green-and-empty. Verified in source at `platform.ts:75-89`.
- CI log for run `32179487755` at this exact SHA contains **zero** `[ADL][SKIPPED]` lines and reports 183/183 with 0 skipped, so the two Linux-only cases genuinely executed.
- The T-2-30 supplementary-group assertion is guarded against vacuity by `expect(daemonOnly.length).toBeGreaterThan(0)` — if the runner's user carried no group the worker lacks, the case fails rather than passing on an empty comparison. CI runs the suite under `sg adl-worker -c "pnpm -r test"` with the runner user `usermod --append`-ed into the group, so `daemonOnly` is genuinely non-empty.
- The assertion is on the child's **group list**, not its uid — stated in the module docblock precisely because a uid comparison passes cleanly on the `execa({uid, gid})` implementation that does not call `setgroups`.

**Would the "worker cannot write `.git/config`" negative control fail if layer 2 were removed?** Partially. It is asserted from both sides — non-zero exit *and* `readFile(config)` not containing the marker — so a shell that reports a redirect failure oddly cannot satisfy it. But note honestly: on a default-umask repository `.git/config` is `0644` and owner-writable only, so the denial would hold even if `protectFromWorker()` never ran. The control proves the *property*; it does not isolate *which layer* delivers it. `protectFromWorker`'s value is the permissive-umask case, and that case is not covered by a test.

**Would the config-neutralisation evidence fail if the fix were reverted?** Yes — I proved it. I mutated `src/git/adl-git.ts` to build `argv: [...binary, ...args]` (dropping `NEUTRALISE_ARGS`) and re-ran the git suites:

```
× runs the identical status through adlGit with nothing planted executing
× creates and destroys a worktree with nothing planted executing
× takes a snapshot inside the agent's own worktree with nothing planted executing
× inventories the repository through the neutralised path
Tests  4 failed | 16 passed (20)
```

Reverted; working tree clean. These are real controls, not decoration. `test/git/adl-git.test.ts` additionally carries a **CONTROL that requires the planted hook to fire** through a bare `simpleGit` handle — the shipped-and-reverted code, verbatim — before concluding anything from its absence on the `adlGit` path.

**Is each neutralised key proven individually?** Yes. `test/git/poisoned-config.test.ts` drives its loop off `NEUTRALISED_CONFIG` itself, so deleting an entry deletes its own proof rather than leaving an aggregate assertion that still passes. All 8 keys, each poisoned into the *main* repository from inside a *linked worktree*, each read back through `client.effectiveConfig()`. The suite carries a CONTROL requiring the `post-index-change` hook to actually execute under an unneutralised `git status` — without it the neutralised case would pass against a hook that never fires for unrelated reasons. It also asserts the poison is **still in the file** afterwards, forbidding a "detect and clean up" implementation.

**Does the Linux drop make that suite vacuous?** No — and this is the sharpest thing in the phase. Under the drop the agent *cannot* write `.git/config`, so `poisonFromWorktree()` branches. The branch is an **assertion, not a skip**: it requires the agent's write to be *refused* (layer 2 asserted rather than assumed) and then re-performs the write from the same linked worktree as the repository owner, because the claim under test — that a worktree write lands in the main repo — is about git's layout, not about uid. And `beforeAll` runs `git --version` as the dropped worker and **throws** if it fails, so "refused" cannot be satisfied by a broken launcher. That is precisely the "passes for the wrong reason" failure mode, anticipated and closed.

**CR-01 / CR-02 (the criticals):** genuinely closed. `grep -rn "simple-git" packages/workspace/src/` returns only comments. `execa` is imported in exactly one file. Three independent guards: the ESLint rule (verified firing, below), a source-tree scan in the contract suite with its own positive control (`expect(chokepoint).toContain('export function adlGit(')`), and a third guard that pins the *exact list* of modules calling `adlGit(` to `['worktree/backend.ts', 'worktree/lifecycle.ts', 'worktree/list.ts']` so a fourth quiet call site is a visible diff.

**WR-05 (`Number('') === 0` → gid 0):** closed at `privilege.ts:431` with `/^\d+$/` plus `Number.isSafeInteger`, and the test enumerates all six field shapes `Number()` accepts that the file format does not (`''`, `' 12 '`, `'0x10'`, `'1e3'`, `'-1'`, `'12abc'`), with a positive control proving a well-formed line still parses (a parser that rejected everything would satisfy the negative case and break every real host), and an end-to-end case proving `applyWorkerAccess` **degrades** rather than chowning to gid 0 and reporting `applied`.

**WR-06 (orphaned scratch HOMEs):** closed. `sweepScratchHomes` exists with pid-liveness policy, and the owner marker lives *beside* the home rather than inside it — because the home is group-writable and a marker the worker could rewrite would be a way to ask the sweep to delete a live feature's HOME. Fail-safe direction is correct: no marker ⇒ do not collect.

**WR-03 (locale-dependent idempotency):** closed by `ADL_GIT_LOCALE = { LC_ALL: 'C', LANG: 'C' }` at the chokepoint, with a test that runs teardown "in a translated locale".

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/core/src/stage/workspace.ts` | Workspace/ExecSpec/NetworkPolicy declarations, no `node:` imports | ✓ VERIFIED | `readonly argv: readonly string[]`; **no field accepts a shell command string**; `readonly path: string` is required (missing PATH is a compile error, not a Linux-only ENOENT); `networkPolicy: NetworkPolicy` and `resources: ResourceLimits` present from day one as the ROADMAP Notes require |
| `packages/workspace/src/exec/run.ts` | The one process launch | ✓ VERIFIED | Sole `execa` import repo-wide; `extendEnv: false`; sole caller of `buildChildEnv`, always with both args; `killDescendants`, `forceKillAfterDelay`, `buffer: false`, `reject: false` each stated with reasoning |
| `packages/workspace/src/exec/env.ts` | Zero-inherit builder | ✓ VERIFIED | Never reads `process.env`; neutralisers all point *inside* the scratch home (so config both works and dies with the directory); Windows `USERPROFILE` branch honestly labelled a dev nicety, not a guarantee; case-fold collision detection for the Windows env-key hazard; `undefined` value rejected by name, never by value |
| `packages/workspace/src/exec/privilege.ts` | Launcher-based drop | ✓ VERIFIED | `sudo --preserve-env --non-interactive --user <u> --`, each flag load-bearing and documented; four-member `PrivilegeMode` so the banner names the right fix; `applyWorkerAccess` skips symlinks (never follows), never sets a world bit, preserves setuid/setgid/sticky |
| `packages/workspace/src/exec/scratch-home.ts` | Per-run disposable HOME | ✓ VERIFIED | `mkdtemp` under a daemon-owned `0700` `<tmp>/adl-homes`; owner marker beside, not inside; `scratchHomeRoot()` is a function so `TMPDIR` is read at call time |
| `packages/workspace/src/git/adl-git.ts` | The single ADL-side git chokepoint | ✓ VERIFIED | Routes through `run(spec, home, collect, {}, 'adl')`; splices `NEUTRALISE_ARGS` **before** the subcommand (`-c` is a top-level option); forces `C` locale; returns an exit code; mutation-tested |
| `packages/workspace/src/git/manager-git.ts` | Neutralisation list + client | ✓ VERIFIED | `NEUTRALISED_CONFIG` frozen, 8 keys, each with a stated reason; `NEUTRALISATION_RESIDUAL_RISK` names what is *not* covered |
| `packages/workspace/src/registry.ts` | Named backend registry | ✓ VERIFIED | Three ids; unknown id throws naming the id and listing registered ids; **no credential field anywhere on the config type** — asserted structurally by `manager-git.test.ts` |
| `packages/workspace/src/stub/backend.ts` | Second backend | ✓ VERIFIED | Real `realpath(mkdtemp())` root, same `assertWithinRoot` |
| `packages/workspace/src/paths.ts` | D-02 containment guard | ✓ VERIFIED | Resolve + separator guard + realpath of the *deepest existing* ancestor (not just `dirname`, which `root/link -> /etc` would defeat) |
| `packages/workspace/src/worktree/{lifecycle,list,gc}.ts` | Lifecycle, inventory, sweep | ✓ VERIFIED | `gc.ts` reaches feature state through an injected `FeatureStateLookup`; `@adl/db` is a **devDependency only** in `package.json`, so the swappable backend really is database-free |
| `eslint.config.js` | The spawn boundary | ⚠️ PARTIAL | Correct and firing for `.ts` (proven); glob does not reach `.mts`/`.cts`/`.tsx` (proven) |
| `.github/workflows/ci.yml` | Linux privilege provisioning | ✓ VERIFIED | Creates group + system user, `usermod --append`, `visudo --check` before `install`, `NOPASSWD:SETENV:` entry, `Defaults>adl-worker !secure_path`, exports both env vars, runs the suite under `sg adl-worker` |
| `packages/workspace/README.md` | Install story | ✓ VERIFIED | Sudoers rule stated up front ("Read the sudoers section before you install"); `§ What is not isolated: one worker identity for every feature` present and linked from the top |
| `packages/plugin-sdk/src/index.ts` | Reference-identity re-export | ✓ VERIFIED | `type Workspace` re-exported from `@adl/core/stage`; the forward declaration in `stage.ts` is gone (`stage.ts:22` now `import type { Workspace } from './workspace.js'`) |

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| `src/exec/run.ts` | `src/exec/env.ts` | `buildChildEnv(spec, scratchHome)` — one call site, both args | ✓ WIRED |
| `src/worktree/backend.ts` | `src/exec/run.ts` | `run(execSpec, scratchHome.path, log, worker)` — worker identity travels with the instance, no caller sees the seam | ✓ WIRED |
| `src/git/adl-git.ts` | `src/git/manager-git.ts` | `NEUTRALISE_ARGS` imported, not re-declared — one list, one proof loop | ✓ WIRED |
| `src/worktree/{lifecycle,list,backend}.ts` | `src/git/adl-git.ts` | `adlGit()` — all three, pinned by a test that asserts the exact module list | ✓ WIRED |
| `src/registry.ts` | `src/{worktree,stub,git}/…backend.ts` | Sole factory site, guarded with a positive control | ✓ WIRED |
| `src/worktree/gc.ts` | `@adl/core` `TERMINAL_STATES` | Runtime value imported, not a transcribed list | ✓ WIRED |
| `test/exec/credentials.test.ts` | `test/helpers/env-dump-child.cjs` | Real child, real dump — not the record the builder returned | ✓ WIRED |
| `src/exec/privilege.ts` `privilegeModeMismatch()` | *(no caller)* | Detector shipped, wiring deferred as D-2-R-2 | ⚠️ ORPHANED — documented, non-blocking (requires a PATH that differs between daemon and child in whether it contains `sudo`; no current call site produces one) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Spawn ban fires outside `packages/workspace` for all 4 specifiers × 4 import forms | `npx eslint packages/core/src/probe.ts` (probe with static/require/dynamic/execa forms) | 5 errors, severity 2, all forms reported | ✓ PASS |
| `execa` permitted inside `packages/workspace` | `npx eslint packages/workspace/src/probe.ts` | `execa` clean | ✓ PASS |
| `simple-git` re-banned inside `packages/workspace/src` | same probe | 1 error naming CR-01/CR-02 | ✓ PASS |
| `simple-git` still permitted in `packages/workspace/test` | `npx eslint packages/workspace/test/probe.ts` | 0 errors (fixtures legitimately hold handles) | ✓ PASS |
| **Spawn ban on `.mts`/`.cts`/`.tsx`** | `npx eslint packages/db/src/probe.mts` with `import { execa }` | **0 architecture errors** while `no-unused-vars` fired on the same file — ESLint processed it, the rule never matched | ✗ **FAIL** — see Gaps |
| Contract suite runs both backends | `npx vitest run test/contract/… test/registry.test.ts` | 2 files, **36 passed** | ✓ PASS |
| Git neutralisation suites | `npx vitest run test/git/{adl-git,poisoned-config,neutralisation-residual-risk}.test.ts` | 3 files, **22 passed** | ✓ PASS |
| **Mutation: remove `NEUTRALISE_ARGS` from `adlGit`** | same command against mutated source | **4 failed** | ✓ PASS (control is load-bearing) |
| Linux privilege assertions executed, not skipped | `gh run view 32179487755 --log` at HEAD SHA | 183 passed / 0 skipped, **0** `[ADL][SKIPPED]` lines, both node 22 and 24 | ✓ PASS |
| CI SHA identical to working tree | `git merge-base --is-ancestor $SHA HEAD` + `git diff --stat` | Same commit `8ccbd9a`, no drift | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plans | Status | Evidence |
|-------------|--------------|--------|----------|
| **WORK-01** — Each feature gets its own git worktree | 02-01, 02-03, 02-04, 02-06 | ✓ SATISFIED | `createWorktree` on `adl/<featureId>`; duplicate-feature refusal; prefix-collision separation (`feat-1` vs `feat-1-evil`); id validation rejects empty/whitespace/separator-bearing ids |
| **WORK-02** — Every process launch, including agent CLIs, goes through the workspace's exec path | 02-01, 02-02, 02-03, 02-08 | ⚠️ **PARTIALLY SATISFIED** | Runtime property true and verified repo-wide, including ADL's *own* git (D-17's host-rooted backend is a third registry entry rather than a second lint exemption — the bypass that would have lived inside the one exempt directory). Lint enforcement does not cover `.mts`/`.cts`/`.tsx`. |
| **WORK-03** — Backend swappable for a container/sandbox implementation without changes to the loop | 02-06 | ✓ SATISFIED | Registry + parameterised contract suite over two backends with zero branching; `networkPolicy`/`resources` on `ExecSpec` from the first commit as the ROADMAP Notes require, so the container backend is a value change |
| **WORK-04** — Worktrees and branches reclaimed after a feature finishes | 02-04 | ✓ SATISFIED | `destroy()` is the primary path (D-14), `sweepOrphans` the crash backstop (D-15); collection keyed on **feature state only** — never mtime or lock files — so a slow feature is never mistaken for an abandoned one |
| **WORK-05** — Worker runs as a dedicated unprivileged OS user with a per-run scratch home | 02-05, 02-07 | ✓ SATISFIED **as worded** | Both clauses delivered and proven on Linux CI. The residual D-2-R-1 (one identity shared across concurrent features) does **not** contradict this wording: the requirement says "a dedicated unprivileged OS user" — singular, per deployment — and "a per-run scratch home directory", which *is* per-run (`mkdtemp` per workspace instance under a `0700` root). Flagged for human acceptance, not scored as unmet. |
| **WORK-06** — Credentials never enter the worker's ambient environment; model keys reach only the model subprocess | 02-03, 02-05 | ✓ SATISFIED | Zero-inherit by construction plus a real-child dump proof; per-`ExecSpec` allowlist proven scoped from both sides; structurally reinforced — `manager-git.test.ts` asserts there is *no field* on `WorkspaceRegistryConfig` or on the worker backend's options through which a forge token could be supplied |
| **WORK-07** — Agent-written configuration cannot persist to the host or affect ADL's own git operations | 02-05, 02-07, 02-08 | ✓ SATISFIED against SC4's enumeration; residual open | All three items SC4 names are closed: `.npmrc` (`npm_config_userconfig` + `npm_config_cache` into the scratch home), `.gitconfig` (`GIT_CONFIG_GLOBAL` into the scratch home; ADL's own git uses `~/.adl/git-home`, outside every scratch root), hooks-path (`core.hooksPath=` proven per-key with a firing control). Residual: the wildcard `filter.<driver>` / `diff.<driver>` family, which is *demonstrated open* by a passing test — routed to human decision. |
| WORK-08, WORK-09 | — | n/a | Mapped to Phase 15 in `REQUIREMENTS.md`. Correctly not claimed here. **No orphaned requirements** — every ID `REQUIREMENTS.md` maps to Phase 2 is claimed by at least one plan. |

`REQUIREMENTS.md` still shows WORK-01..07 as `Pending` in the traceability table. That is bookkeeping for the orchestrator, not a code gap.

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `packages/workspace/**` | `TBD` / `FIXME` / `XXX` | — | **NONE.** Zero debt markers across `src/`, `test/`, `packages/core/src/stage`, `packages/plugin-sdk/src`, `eslint.config.js`, `ci.yml`. The debt-marker gate passes cleanly. |
| `packages/workspace/**` | `TODO` / `HACK` / `PLACEHOLDER` / stub prose | — | **NONE.** |
| `packages/workspace/package.json` | `simple-git@3.36.0` is a runtime `dependency` although `src/` no longer uses it | ℹ️ INFO | Post-CR-01 it is a test-only dependency. Shipping it as a runtime dep means consumers install a spawn primitive the package no longer calls, and the `description` field still reads "The only package that touches execa and simple-git." Cosmetic; move to `devDependencies` when convenient. |

## Gaps Summary

**One gap, and it is narrow.**

The phase's headline enforcement mechanism — Success Criterion 2's lint rule, described in `eslint.config.js`'s own words as "a BUILD property, not a review property" — has a file-extension hole. `files: ['**/*.ts']` does not match `.mts`, `.cts`, or `.tsx`. I demonstrated it rather than inferring it: a `.mts` file outside `packages/workspace` importing `execa` produces zero architecture errors while the base rules fire on the same file, proving ESLint processed it and the rule simply never applied. The same `.ts`-only assumption silences the contract suite's two source-tree guards, whose directory walker filters on `endsWith('.ts')`.

The *outcome* the criterion protects is currently true — no code path outside `packages/workspace` launches a process, verified repo-wide — because the repository happens to contain only `.ts` files. So this is a rot risk rather than a live breach, and the fix is one glob per rule plus one fixture. But it is exactly the shape this phase has been fighting: a control that is green for a reason that does not generalise. It was found by the code review as WR-11, classified a Warning, left "Not touched", and — unlike the seven items in `deferred-items.md` — never given a reproduction, an owning phase, or an acceptance decision. Closing it or recording it properly is a small job.

**Everything else holds, and holds for the right reasons.** Four of five success criteria are verified, each with non-vacuity controls I checked individually rather than taking on trust. The two criticals from `02-REVIEW.md` are genuinely closed — I confirmed by reverting the fix and watching four tests go red. The Linux-only WORK-05 evidence really executed: the gate throws rather than skips on a misprovisioned runner, the CI log at this exact SHA carries zero skip lines, and the supplementary-group assertion carries its own anti-vacuity guard.

The remaining items are honest, well-documented residuals, and the quality of that documentation is worth saying plainly: `deferred-items.md` records reproductions, marks D-2-R-1 explicitly `[NOT YET REPRODUCED ON A LINUX HOST]` and says to run it before treating the exploit as confirmed *or* refuted, and `neutralisation-residual-risk.test.ts` asserts that a hole is *open* with instructions on what to do if it ever goes green. That is the opposite of a control passing for the wrong reason. Four items need a human decision (listed in frontmatter), of which two — D-2-R-1's acceptance and the WR-12 owner — are genuine scope calls, and one is an audit-trail tidy-up for six review findings recorded only in a SUMMARY paragraph.

**Verdict on the goal.** *"Every process ADL launches — including agent CLIs — runs through one swappable workspace, with the worker's blast radius bounded before any adapter exists to break the rule."* Achieved. One workspace, one exec primitive, one child-environment builder, one ADL-side git chokepoint; a second backend registered and passing the same suite unchanged; the blast radius bounded by a real uid drop proven from inside a real child on Linux. The gap is in how durably that is *enforced against future edits*, not in whether it is *true today*.

---

_Verified: 2026-08-18T22:15:00Z_
_Verifier: Claude (gsd-verifier)_
