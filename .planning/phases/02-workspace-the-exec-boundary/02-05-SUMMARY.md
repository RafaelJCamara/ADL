---
phase: 02-workspace-the-exec-boundary
plan: 05
subsystem: workspace
tags:
  [
    exec-boundary,
    credentials,
    zero-inherit-env,
    scratch-home,
    neutralisers,
    windows-case-collision,
    idempotent-teardown,
    WORK-05,
    WORK-06,
    WORK-07,
  ]

# Dependency graph
requires:
  - phase: 02-workspace-the-exec-boundary
    plan: 03
    provides: 'buildChildEnv with the zero-inherit default and undefined rejection; createScratchHome/destroyScratchHome; run() with extendEnv:false; withTempRepo; worktreeWorkspace'
  - phase: 02-workspace-the-exec-boundary
    plan: 02
    provides: 'The adl/no-direct-spawn boundary and its single packages/workspace/**/*.ts exemption, under which every file in this plan sits'
provides:
  - 'buildChildEnv, completed: the full neutraliser set pointed inside the scratch HOME, Windows case-collision rejection, and workspace-owned variables that ExecSpec.env cannot redirect'
  - 'ScratchHomeTeardown: a removed | already-absent | not-removed union returned by destroyScratchHome, replacing Promise<void>'
  - 'destroyScratchHome as a bounded-retry, never-throwing, idempotent teardown'
  - 'env-dump-child.cjs: the real child whose dumped environment the WORK-06 assertion reads'
  - 'CREDENTIAL_NAME_PATTERNS: the exported, deliberately-incomplete credential-name list the D-11 assertion scans for'
affects: [02-04, 02-06, 02-07, 02-08, phase-03-manager-worker, phase-16-backends]

actuals:
  tokens: 10700
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - 'Watched-failing verification carried forward: five guards observed failing against the exact defect each exists to catch, then restored'
    - 'Assertions gated on a reported outcome, not on a best-effort side effect — the file-absence claim runs only on the branch where teardown says it removed the directory'
    - 'A deterministic cross-platform stand-in for a platform-specific race, so the guard cannot go quiet where the race stops reproducing'

key-files:
  created:
    - packages/workspace/test/exec/env.test.ts
    - packages/workspace/test/exec/scratch-home.test.ts
    - packages/workspace/test/exec/credentials.test.ts
    - packages/workspace/test/helpers/env-dump-child.cjs
  modified:
    - packages/workspace/src/exec/env.ts
    - packages/workspace/src/exec/scratch-home.ts

key-decisions:
  - 'ExecSpec.env may not redirect a workspace-owned variable. The plan said "merge spec.env on top"; a blind merge would have made `env: { HOME: "/home/real" }` a one-line, configuration-looking opt-out of D-07 — exactly the per-call discipline this plan exists to replace with construction. Rejected by name, case-insensitively, so the rule is not bypassable by shift key. Deviation Rule 2.'
  - 'destroyScratchHome runs rm WITHOUT force:true. force swallows ENOENT, which is the only signal distinguishing already-absent from removed. Turning it off is what makes idempotency observable rather than merely true — and observable is what Task 3 needs in order to gate on it.'
  - 'The teardown REPORT in the credentials test is obtained by calling destroyScratchHome a second time after workspace.destroy(), and `already-absent` is read as the positive statement that destroy() removed the directory. Workspace.destroy() returns void and its signature lives in files plan 02-04 owns concurrently, so surfacing a report through it was out of bounds. Recorded as a carry-forward.'
  - 'The open-handle teardown test asserts "resolves and reports", not a fixed outcome. Verified locally that a Node read handle does NOT block removal on this repository’s own Windows machine — Node opens with FILE_SHARE_DELETE — so pinning `not-removed` would be red here and pinning `removed` would be red wherever the race does reproduce.'
  - 'A NUL-byte path was added as a deterministic, cross-platform driver of the not-removed branch, because the reproduced EBUSY comes from a just-exited child process holding the directory and a unit test cannot stage that reliably.'

patterns-established:
  - 'Errors at the credential boundary name the variable and never the value, asserted by a test that iterates every rejection path in the module'
  - 'A test-owned pattern list carries its own limitation in a comment naming the phase that must extend it'

requirements-completed: [WORK-05, WORK-06, WORK-07]

coverage:
  - id: D8
    description: 'A real child launched through Workspace.exec() dumps an environment containing no forge-token and no model-key name or value, while both are set in the parent'
    requirement: WORK-06
    verification:
      - kind: integration
        ref: 'packages/workspace/test/exec/credentials.test.ts#hands a child neither a forge token nor a model key it did not name'
        status: pass
    human_judgment: false
  - id: D9
    description: 'A model key named on one ExecSpec reaches that child and no other child of the same workspace'
    requirement: WORK-06
    verification:
      - kind: integration
        ref: 'packages/workspace/test/exec/credentials.test.ts#scopes a model key to exactly the one exec that named it'
        status: pass
    human_judgment: false
  - id: D10
    description: 'git config --global and npm config resolve against the scratch directory, and what a child writes there another child reads back'
    requirement: WORK-07
    verification:
      - kind: integration
        ref: 'packages/workspace/test/exec/credentials.test.ts#lands agent-written git and npm configuration inside the disposable HOME'
        status: pass
    human_judgment: false
  - id: D11
    description: 'Teardown is idempotent, reports its outcome, and never throws'
    requirement: WORK-07
    verification:
      - kind: unit
        ref: 'packages/workspace/test/exec/scratch-home.test.ts#is safe to call twice, reporting the second as already absent'
        status: pass
      - kind: unit
        ref: 'packages/workspace/test/exec/scratch-home.test.ts#reports an unremovable path instead of throwing'
        status: pass
    human_judgment: false
  - id: D12
    description: 'Concurrent runs never share a scratch HOME, and tearing one down leaves the other intact'
    requirement: WORK-05
    verification:
      - kind: unit
        ref: 'packages/workspace/test/exec/scratch-home.test.ts#never shares a directory between concurrent runs'
        status: pass
    human_judgment: false
  - id: D13
    description: 'An undefined env value, a case-colliding pair, and an attempt to redirect a workspace-owned variable are each rejected by name and never by value'
    requirement: WORK-06
    verification:
      - kind: unit
        ref: 'packages/workspace/test/exec/env.test.ts — four rejection tests, one of which iterates every rejection path asserting the value never appears'
        status: pass
    human_judgment: false

duration: 41min
completed: 2026-08-18
status: complete
---

# Phase 02 Plan 05: The Credential Boundary and the Disposable HOME Summary

**A child process launched through `Workspace.exec()` and asked to dump its own environment shows neither the forge token nor the model API key that are live in the parent while it runs; a key named on one `exec()` reaches that child and no sibling; and the `.gitconfig` and `.npmrc` an agent writes land in a directory that stops existing — with the "they are gone" claim gated on teardown actually reporting that it removed it.**

## Performance

- **Duration:** ~41 min
- **Tasks:** 3
- **Commits:** 3
- **Files:** 6 changed (4 created, 2 modified), 937 insertions

## Task Commits

1. **Task 1: Complete the child-environment builder** — `47aba0c` (feat)
2. **Task 2: The scratch HOME is disposable, idempotent, and never shared** — `6a9f5e0` (feat)
3. **Task 3: Prove the boundary from inside a real child process** — `4b528b0` (test)

## Accomplishments

- **The environment has one door, and the door is now locked from the inside.** `buildChildEnv` remains reachable from exactly two files, and it now rejects three classes of caller mistake by name rather than absorbing them: an `undefined` value (which Node would drop silently), a case-colliding pair (which Windows would resolve by sort order), and any attempt to redirect a workspace-owned variable (which would have been a one-line opt-out of D-07).
- **The neutralisers point into the scratch directory rather than at a sink**, so WORK-07's two halves both hold: the agent's configuration does not reach the host, *and* the agent can still read back what it wrote. Proven by a second child reading the first child's `git config --global user.email` and `npm config get registry`.
- **`destroyScratchHome` no longer returns `void`.** It returns which of three things happened, it retries the Windows handle race a bounded number of times, and it never throws. That change is what made Task 3's gate possible at all — you cannot condition an assertion on an outcome that was discarded.
- **Five guards were watched failing** against the exact defects they exist to catch, then restored. Two of them are new information about this repository, recorded below.
- **The D-11 phrasing survived contact with the implementation.** The assertion checks for absence of credential *patterns*, not emptiness of the environment, and carries a comment citing the Pitfall 6 reproduction so the next person to read a Windows failure does not "tighten" it.

## Verification observations (the watched-failing evidence)

All five were run during execution and then restored.

**1. Zero-inherit, at the unit level.** With `...process.env` spread into the base record — the shape an "inherit minus a denylist" refactor produces — only the inheritance test went red:

```
× inherits nothing the caller did not name
AssertionError: expected 'must-not-be-inherited-a91f' to be undefined
```

**2. Zero-inherit, at the real-child level.** With `extendEnv: true` in `run.ts` and nothing else changed, the D-11 assertion went red on the far side of the boundary:

```
× hands a child neither a forge token nor a model key it did not name
AssertionError: expected '{"AI_AGENT":"claude-code_2-1-227_agen…' not to match /GITHUB_TOKEN/i
```

The scoping test **stayed green** through this, which is the useful part: the two assertions measure different things, and a combined one would have been satisfied by either.

**3. The two new rejection guards discriminate.** With the case-fold lookup stubbed to `undefined` — the state the code was in before this plan — exactly the three tests that exist for it failed and the other five passed:

```
× rejects two case-colliding caller keys, naming both spellings
× refuses to let a caller redirect a workspace-owned variable
× never puts a credential value in an error message
```

**4. `force: true` destroys the idempotency signal.** Restoring `rm(dir, { recursive: true, force: true })`:

```
× is safe to call twice, reporting the second as already absent
AssertionError: expected 'removed' to be 'already-absent'
```

This is the whole argument for turning `force` off: with it on, teardown is still idempotent, but nothing can *observe* that it is — and Task 3's gate needs to observe it.

**5. The npm neutraliser is load-bearing, not redundant with `HOME`.** Pointing `npm_config_userconfig` one directory above the scratch home made the "the `.npmrc` is inside the scratch directory" assertion red:

```
× lands agent-written git and npm configuration inside the disposable HOME
AssertionError: expected false to be true   (credentials.test.ts:272)
```

Worth stating because the opposite was plausible: `HOME` already points at the scratch directory, so it would have been reasonable to assume npm would land there anyway and that the neutraliser was belt-and-braces. It is not — npm honoured `npm_config_userconfig` over `HOME`.

## New information about this repository

**An open Node file handle does not block directory removal on this machine.** The plan asked for a test exercising "destroy over a directory holding an open handle reports not-removed rather than throwing." Probed directly:

```
open-handle teardown: {"outcome":"removed","attempts":1}
after close:          {"outcome":"already-absent"}
```

Node opens with `FILE_SHARE_DELETE`, so the `EBUSY`/`EPERM` path Pitfall 6 reproduced comes from a **just-exited child process** holding the directory (cwd, or a mapped executable image), not from anything a unit test can stage with `fs.open`. The test was therefore written to assert *"resolves and reports one of the two outcomes"* rather than pinning either — pinning `not-removed` would be red here, and pinning `removed` would be red wherever the race does reproduce. A second test drives the `not-removed` branch deterministically and identically on every platform (a NUL-byte path), so the "returns a reason, never throws" contract keeps a guard that cannot go quiet.

**The `destroy()` teardown reported `already-absent` on every run here**, meaning `Workspace.destroy()` did remove the scratch home and the file-absence branch is the one that executed. The `not-removed` branch is written, asserted, and unexercised on this machine — by design.

## Decisions Made

See `key-decisions` in the frontmatter. The two worth expanding:

**Rejecting a workspace-owned variable, rather than merging over it.** The plan's wording was "then merge `spec.env` on top", and a literal reading gives `env: { HOME: '/home/real' }` the power to opt a child out of the disposable HOME. That is precisely the failure mode the plan's own objective names — "true by construction, not per-call discipline" — and the diff for such a call site would look like configuration, not like a bypass. The rejection is case-insensitive because on Windows `Home` and `HOME` are the same variable, and a case-sensitive rule against a case-insensitive platform is a rule with a documented workaround. Taken under deviation Rule 2 (missing critical functionality, security).

**The teardown report is obtained by calling teardown twice.** `Workspace.destroy()` returns `Promise<void>`, and both `packages/core/src/stage/workspace.ts` and `packages/workspace/src/worktree/backend.ts` are outside this plan's `files_modified` — `backend.ts` is owned by plan `02-04`, executing concurrently. Rather than reach into another agent's files, the test calls `destroy()` (the real path, including the worktree teardown) and then calls `destroyScratchHome` again as a *report probe*. `already-absent` is then the positive statement that `destroy()` removed the directory. This is safe only because Task 2 made teardown idempotent — the two halves of this plan turned out to depend on each other in a way the plan did not anticipate.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Missing critical functionality] `ExecSpec.env` may not redirect a workspace-owned variable**

- **Found during:** Task 1
- **Issue:** A blind merge of `spec.env` over the base record lets a caller point `HOME`, `GIT_CONFIG_GLOBAL`, or any neutraliser somewhere outside the scratch directory, defeating D-07 and WORK-07 from a call site that looks like ordinary configuration.
- **Fix:** case-insensitive rejection naming the variable, with the reason stated in the error.
- **Files modified:** `packages/workspace/src/exec/env.ts`
- **Committed in:** `47aba0c`

**2. [Rule 1 — Bug] `attempts` reported the cap rather than the attempts made**

- **Found during:** Task 2, reviewing the retry loop before writing its tests
- **Issue:** A non-transient error breaks out of the loop after one attempt, but the returned `not-removed` result reported `MAX_ATTEMPTS`, sending anyone reading the log looking for a retry loop that never ran.
- **Fix:** track and report the attempts actually made; asserted by the NUL-byte test (`attempts` is exactly 1).
- **Committed in:** `6a9f5e0`

**3. [Rule 3 — Blocking] Bootstrapped pnpm in the worktree**

- **Found during:** setup
- **Issue:** no `node_modules`, and `pnpm` not on `PATH`.
- **Fix:** `$HOME/.corepack-shims` on `PATH`, `pnpm install --frozen-lockfile` (pnpm 11.22.0, the pinned version).
- **Files modified:** none — `node_modules/` is gitignored.

### Deliberate scope boundaries held

- `packages/workspace/src/worktree/*`, `src/index.ts`, and `packages/workspace/package.json` were not touched — plan `02-04` owns them and is executing concurrently.
- `reject: false` in `run.ts` was left alone, and the deferred `binary_missing` classification (`deferred-items.md` D-2-03-1) was not re-litigated. `run.ts` was modified only as a temporary probe and restored; it is byte-identical to its committed state.
- `buildChildEnv` remains absent from the package barrel.

**Total deviations:** 3 auto-fixed (1 missing-functionality, 1 bug, 1 blocking-environmental). No Rule 4 architectural changes; no scope creep.

## Threat Model Verification

| Threat ID | Disposition | Status                                                                                                                                                                                                                                                          |
| --------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-2-16    | mitigate    | **Mitigated.** Real-child dump shows neither credential name nor value; watched failing under `extendEnv: true`.                                                                                                                                                  |
| T-2-17    | mitigate    | **Mitigated.** `npm_config_userconfig` and `npm_config_cache` point inside the scratch directory — watched failing when redirected outside it — and the files are gone after teardown, gated on the teardown report.                                              |
| T-2-18    | mitigate    | **Mitigated.** Zero-inherit makes the `GIT_CONFIG_COUNT` vector unreachable; a named hazard paragraph at the builder forbids both the prefix pass-through and the inherit-minus-denylist refactor. Recorded as a `must_haves.prohibitions` item.                   |
| T-2-19    | mitigate    | **Mitigated.** A test iterates every rejection path in `env.ts` asserting the message never contains the value; the credential test uses unique greppable sentinels.                                                                                              |
| T-2-20    | mitigate    | **Mitigated.** `mkdtemp` retained, not configurable, never reused; two successive creations asserted distinct and two concurrent creations asserted distinct with one teardown leaving the other's contents readable.                                              |
| T-2-21    | mitigate    | **Mitigated.** Bounded linear-backoff retry on transient codes only, then a reported `not-removed` result. Never throws — asserted deterministically. Note the honest limit: the transient branch is unexercised on this machine (see "New information").          |
| T-2-22    | mitigate    | **Mitigated.** Case-insensitive collision detected across the merged record and rejected naming both spellings; watched failing.                                                                                                                                  |

## Threat Flags

None. This plan adds no network endpoint, no auth path, and no schema change. It narrows an existing surface rather than opening one.

## Known Stubs

None. Every symbol this plan touched is fully implemented.

## Carry-forward for later plans

- **`Workspace.destroy()` discards the teardown report.** `destroyScratchHome` now returns a `ScratchHomeTeardown`, and `backend.ts` awaits it and drops it. A plan that owns `backend.ts` (or `packages/core/src/stage/workspace.ts`) should decide whether `destroy()` surfaces it — as a return value, or as a log line naming a leaked directory. Until then a leaked scratch HOME is invisible to an operator, and `credentials.test.ts` recovers the report by calling teardown a second time.
- **`ScratchHomeTeardown` and `destroyScratchHome` are not on the package barrel.** `src/index.ts` belongs to plan `02-04` and was not edited. If a later phase needs the teardown outcome outside the package, that export is the change to make.
- **`CREDENTIAL_NAME_PATTERNS` must grow when Phase 16 lands a provider.** It is exported from `credentials.test.ts` with the limitation stated inline (assumption A-E10).
- **The `not-removed` retry branch is unexercised on Windows via `fs.open`.** If a later phase gains a fixture that runs a child which holds its cwd inside the scratch directory, that is the way to exercise it for real.

## Verification

| Check                                          | Exit |
| ---------------------------------------------- | ---- |
| `pnpm vitest run --project workspace`          | 0 (18 tests, 4 files) |
| `pnpm vitest run --project workspace -t "env"` | 0    |
| `pnpm vitest run --project workspace -t "scratch home"` | 0 |
| `pnpm vitest run --project workspace -t "credentials"`  | 0 |
| `pnpm vitest run --project root`               | 0 (30 tests) |
| `pnpm -r test`                                 | 0    |
| `pnpm -r typecheck`                            | 0    |
| `pnpm -r build`                                | 0    |
| `pnpm lint`                                    | 0    |
| `pnpm format`                                  | 0    |

Acceptance criteria spot-checks:

- `grep -rl 'buildChildEnv' packages/workspace/src --include=*.ts` → exactly two files (`exec/env.ts`, `exec/run.ts`). The boundary still has one door.
- `node packages/workspace/test/helpers/env-dump-child.cjs` → exit 0, one JSON line.
- `grep -c 'emptiness' packages/workspace/test/exec/credentials.test.ts` → 3.
- Every neutraliser name present in `src/exec/env.ts`.

Against `<success_criteria>`:

- Forge tokens and model API keys are absent from a real child's environment, proven by dumping it. ✅ (watched failing under `extendEnv: true`)
- A model key reaches exactly the one `exec()` that named it. ✅ (asserted from both sides)
- Agent-written `.gitconfig` and `.npmrc` land in the disposable directory, and the file-absence claim is gated on the teardown report. ✅

## Self-Check

**PASSED**

- `packages/workspace/src/exec/env.ts` — FOUND
- `packages/workspace/src/exec/scratch-home.ts` — FOUND
- `packages/workspace/test/exec/env.test.ts` — FOUND
- `packages/workspace/test/exec/scratch-home.test.ts` — FOUND
- `packages/workspace/test/exec/credentials.test.ts` — FOUND
- `packages/workspace/test/helpers/env-dump-child.cjs` — FOUND
- Commit `47aba0c` — FOUND
- Commit `6a9f5e0` — FOUND
- Commit `4b528b0` — FOUND
- No file deletions in any commit — CONFIRMED
- No file outside this plan's `files_modified` changed — CONFIRMED (`git diff --stat` against the base lists exactly the six files above; the `run.ts` probe was restored and shows no diff)
- Probe file `probe-scratch.mts` — removed, never tracked

---

_Phase: 02-workspace-the-exec-boundary_
_Completed: 2026-08-18_
