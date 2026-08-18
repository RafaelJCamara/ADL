---
phase: 02-workspace-the-exec-boundary
plan: 03
subsystem: workspace
tags:
  [
    exec-boundary,
    worktree,
    execa,
    simple-git,
    zero-inherit-env,
    scratch-home,
    tracer,
    plugin-sdk,
  ]

# Dependency graph
requires:
  - phase: 02-workspace-the-exec-boundary
    plan: 01
    provides: 'Human-approved legitimacy verdict and exact pins for execa@10.0.1 and simple-git@3.36.0, installed here verbatim with no fresh version resolution'
  - phase: 02-workspace-the-exec-boundary
    plan: 02
    provides: 'The adl/no-direct-spawn lint boundary and its single packages/workspace/**/*.ts exemption, which this plan is the first code to sit inside'
  - phase: 01-core-contracts
    provides: 'LogChunk, StageContext.signal, the CommandSpecSchema argv shape, the LoadError class shape, and the @adl/core purity ban'
provides:
  - 'Workspace, ExecSpec, ExecResult, RestoreHandle, NetworkPolicy, NETWORK_POLICIES, ResourceLimits as real published types in @adl/core/stage — the Workspace forward declaration is gone'
  - 'The @adl/workspace package — the only package in the repository that imports execa or simple-git'
  - 'run(spec, scratchHome, log): the single process-launch site, with extendEnv:false, killDescendants, forceKillAfterDelay and buffer:false stated explicitly'
  - 'buildChildEnv: zero-inherit child environment, undefined values rejected by name'
  - 'createWorktree / destroyWorktree and the adl/<featureId> branch convention, torn down in the order git forces'
  - 'worktreeWorkspace: the first Workspace implementation'
  - 'withTempRepo: a real temp git repository plus scratch root, for every later workspace test'
  - 'The workspace surface republished through @adl/plugin-sdk by reference identity'
affects:
  [02-04, 02-05, 02-06, 02-07, 02-08, phase-03-manager-worker, phase-05-harnesses]

actuals:
  tokens: 13200
  tasks: 3
  commits: 3

tech-stack:
  added:
    - 'execa@10.0.1 — the one process launcher, in packages/workspace only'
    - 'simple-git@3.36.0 — git worktree lifecycle, in packages/workspace only'
  patterns:
    - 'Watched-failing guards: every load-bearing assertion in the tracer was observed failing against the exact defect it exists to catch, then restored'
    - 'Containment by absence of an export: buildChildEnv is deliberately not on the package barrel, so a second env-assembly site cannot be reached from outside'
    - 'Stub interface methods declare no parameters, rather than naming them with a leading underscore and buying a lint exception that would outlive the stub'

key-files:
  created:
    - packages/core/src/stage/workspace.ts
    - packages/workspace/package.json
    - packages/workspace/tsconfig.json
    - packages/workspace/vitest.config.ts
    - packages/workspace/src/index.ts
    - packages/workspace/src/errors.ts
    - packages/workspace/src/exec/env.ts
    - packages/workspace/src/exec/run.ts
    - packages/workspace/src/exec/scratch-home.ts
    - packages/workspace/src/worktree/lifecycle.ts
    - packages/workspace/src/worktree/backend.ts
    - packages/workspace/test/helpers/temp-repo.ts
    - packages/workspace/test/tracer.test.ts
    - .planning/phases/02-workspace-the-exec-boundary/deferred-items.md
  modified:
    - packages/core/src/stage/stage.ts
    - packages/core/src/stage/index.ts
    - packages/plugin-sdk/src/index.ts
    - packages/plugin-sdk/test/reexport-identity.test.ts
    - pnpm-lock.yaml

key-decisions:
  - 'reject:false on the execa call. A non-zero exit is DATA at this boundary — ExecResult.exitCode is declared number|null in @adl/core, and without this that field is unreachable for the single most common outcome (a gate whose command legitimately fails). Added under deviation Rule 2.'
  - 'The binary-missing / command-failed distinction was deliberately NOT built. Verified locally that on Windows a missing binary returns exitCode:1 with code undefined — byte-for-byte identical to a real exit 1 — because cross-spawn routes through cmd.exe. A guard keyed on exitCode===undefined works on Linux and silently does nothing on the maintainer machine. Deferred with the evidence rather than shipped half-working.'
  - "Named import { simpleGit } rather than the default import CLAUDE.md's ESM/CJS row prescribes. simple-git's .d.ts is CJS-classified under nodenext and this repo leaves esModuleInterop off, so the default import resolves to the module namespace and simpleGit(repo) fails to typecheck."
  - 'buildChildEnv is not re-exported from the package barrel. It is an implementation detail of run, its only caller; publishing it would invite a second env-assembly site, which is the two-doors failure the boundary exists to prevent.'
  - 'Stub read/write/snapshot declare no parameters at all, so no lint exception is needed and none can leak into the real implementations in 02-06.'

patterns-established:
  - 'Watched-failing verification for behavioural guards, carried over from plan 02-02 into runtime code'
  - 'withTempRepo: realpath the mkdtemp result before use, because git reports worktree paths already resolved and macOS tmpdir is a symlink'
  - 'A phase-level deferred-items.md carrying the reproduction, not just the intent, for anything found-but-not-fixed'

requirements-completed: [WORK-01, WORK-02, WORK-06]

coverage:
  - id: D1
    description: 'One feature id produces a worktree on branch adl/<featureId>, a real child process runs inside it through Workspace.exec(), its output arrives as tagged LogChunks, and after destroy() neither worktree nor branch nor scratch home exists'
    requirement: WORK-01
    verification:
      - kind: integration
        ref: 'packages/workspace/test/tracer.test.ts#creates, executes, streams tagged output, and tears down completely'
        status: pass
    human_judgment: false
  - id: D2
    description: 'The child receives no inherited environment — a variable set in the parent and not named on the ExecSpec does not reach the child'
    requirement: WORK-06
    verification:
      - kind: integration
        ref: "tracer.test.ts asserts the child printed PARENT_ONLY:absent, and that the parent value appears in no chunk. Watched failing with extendEnv:true — the child saw the value and the assertion went red."
        status: pass
    human_judgment: false
  - id: D3
    description: 'Teardown removes the branch as well as the worktree'
    requirement: WORK-01
    verification:
      - kind: integration
        ref: "tracer.test.ts asserts branch --list 'adl/*' is empty after destroy(). Watched failing with branch -D removed: the worktree assertion still passed while adl/tracer-1 survived — half of the success criterion silently satisfied."
        status: pass
    human_judgment: false
  - id: D4
    description: 'The LogChunk stream tag is preserved per stream, not collapsed'
    requirement: WORK-01
    verification:
      - kind: integration
        ref: 'tracer.test.ts asserts stdout and stderr separately. Watched failing with the stderr loop tagging its lines stdout: the stdout assertion passed and only the stderr one failed, confirming a combined assertion would not discriminate.'
        status: pass
    human_judgment: false
  - id: D5
    description: 'execa and simple-git are confined to packages/workspace, and process launch to one file'
    requirement: WORK-02
    verification:
      - kind: other
        ref: "grep -rl 'execa' packages/workspace/src --include=*.ts lists exactly one file (exec/run.ts); pnpm lint exits 0, which is the 02-02 exemption working"
        status: pass
    human_judgment: false
  - id: D6
    description: 'A missing PATH on an ExecSpec is a compile error, not a runtime ENOENT'
    requirement: WORK-06
    verification:
      - kind: other
        ref: "Scratch ExecSpec literal omitting path produced TS2741: Property 'path' is missing in type ... but required in type 'ExecSpec'. File deleted after observation."
        status: pass
    human_judgment: false
  - id: D7
    description: '@adl/plugin-sdk republishes the workspace surface without redeclaring any of it'
    requirement: WORK-02
    verification:
      - kind: unit
        ref: 'packages/plugin-sdk/test/reexport-identity.test.ts#re-exports NETWORK_POLICIES by reference, not as a copy of the tuple'
        status: pass
      - kind: unit
        ref: 'packages/plugin-sdk/test/reexport-identity.test.ts#declares no type of its own — every export is a re-export'
        status: pass
    human_judgment: false

duration: 32min
completed: 2026-08-18
status: complete
---

# Phase 02 Plan 03: The Tracer — Worktree, Exec Boundary, Teardown Summary

**One feature id now produces a git worktree on `adl/<featureId>`, runs a real child process inside it through a single exec path that inherits nothing from the worker, streams that child's output back as stream-tagged `LogChunk`s, and leaves neither worktree nor branch nor scratch `HOME` behind — proven end to end against a real git repository, with every load-bearing assertion watched failing first.**

## Performance

- **Duration:** ~32 min
- **Tasks:** 3
- **Commits:** 3
- **Files:** 19 changed (14 created, 5 modified), 1249 insertions

## Accomplishments

- **`Workspace` is a real published interface.** The forward declaration is gone from `packages/core/src/stage/stage.ts`, and `@adl/plugin-sdk` republishes the whole surface by reference. A harness author can now call `ws.exec(spec, log)` and have it typecheck — verified with a throwaway probe that would not have compiled against the placeholder.
- **`ExecSpec` carries `networkPolicy` and `resources` from the first commit**, and `path` is required rather than optional, so the Linux-only `ENOENT` that `extendEnv: false` causes is a compile error on this machine instead of a round-1 failure on the deployment target.
- **The exec boundary is one file.** `grep -rl 'execa' packages/workspace/src` lists exactly `exec/run.ts`, and `pnpm lint` exits 0 — which is simultaneously the proof that plan `02-02`'s exemption works, and the reason `02-02` was a real dependency rather than a wave neighbour.
- **The environment has one door.** `buildChildEnv` is reachable from exactly two files (itself and `run.ts`) and is deliberately absent from the package barrel, so no future backend can assemble an environment on the side.
- **Three guards were watched failing** against the exact defects they exist to catch, then restored — see below. The teardown one is the most valuable: it confirmed that omitting `branch -D` leaves the worktree assertion *passing*.

## Task Commits

1. **Task 1: The published type surface and the `@adl/workspace` package** — `ee0fef8` (feat)
2. **Task 2 (tracer): A feature worktree runs a real process and leaves nothing behind** — `7013d76` (feat)
3. **Task 3: Publish the real workspace surface through `@adl/plugin-sdk`** — `d530abf` (feat)

## Verification observations (the watched-failing evidence)

All three were run during execution and then restored. Each is required by the plan's acceptance criteria.

**1. Zero-inherit is real, not incidental.** With `extendEnv: true` and nothing else changed, the child found the parent-only variable and the suite went red on exactly the assertion that exists for it:

```
AssertionError: expected [ 'adl-tracer-stdout-4f2a', …(3) ] to include 'PARENT_ONLY:absent'
```

**2. `worktree remove` alone silently leaves the branch.** With `branch -D` deleted from `destroyWorktree`, the worktree-path assertion **passed** and only the branch assertion failed:

```
AssertionError: expected 'adl/tracer-1' to be '' // Object.is equality
+ adl/tracer-1
```

This is the exact half-satisfied success criterion `02-RESEARCH.md § Pattern 1` predicted, reproduced against this repository's own code rather than a scratch repo.

**3. The stream tag is load-bearing and the per-stream split discriminates.** With the stderr loop tagging its lines `stdout`, the stdout assertion (line 102) still passed and only the stderr one (line 103) failed — confirming that a single combined-output assertion would have passed with the tag discarded.

**4. The plugin-SDK redeclaration guard.** A deliberate second `NETWORK_POLICIES` tuple plus a probe interface appended to `packages/plugin-sdk/src/index.ts` was caught by **three independent assertions**: the new `toBe` reference check, the new declaration guard (`["export const NETWORK_POLICIES", "export interface ResourceLimitsProbe"]`), and the pre-existing orphan check. Reverted; 10/10 green.

## Decisions Made

See `key-decisions` in the frontmatter. The two worth expanding:

**`reject: false`, and the line drawn next to it.** `ExecResult.exitCode` is declared `number | null` in `@adl/core`, which is a promise that a non-zero exit is returnable data. execa's default rejects on non-zero, so without `reject: false` that field would be unreachable for the most common thing that happens at this boundary — a command gate whose test suite fails. Adding it is deviation Rule 2. What was *not* added is the `binary_missing` distinction, and the reason is recorded in `deferred-items.md` with the reproduction: on Windows a missing binary returns `exitCode: 1` with `code` undefined, identical to a genuine exit 1, because `cross-spawn` routes bare names through `cmd.exe`. The obvious guard would have worked on Linux CI and done nothing on the maintainer's own machine — the same platform-split shape as Pitfall 7, and a control that looks handled while being absent is worse than a documented gap.

**`import { simpleGit }` contradicts CLAUDE.md, on evidence.** The stack doc's ESM/CJS row says to use a default import for `simple-git`. Under this repo's actual settings (`nodenext`, `verbatimModuleSyntax: true`, `esModuleInterop` unset) that yields the module namespace and `simpleGit(repo)` fails with `TS2349: This expression is not callable`. `simpleGit` is a genuine named export of the same module and the package ships a real ESM build, so the named form is correct at both type and runtime level. Documented at the import site.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Bootstrapped pnpm and installed dependencies in the worktree**

- **Found during:** Task 1 setup
- **Issue:** The worktree had no `node_modules` and `pnpm` was not on `PATH`; no verification command could run.
- **Fix:** Used the existing corepack shims (`$HOME/.corepack-shims`, pnpm 11.22.0 — the version pinned in `packageManager`) and ran `pnpm install --frozen-lockfile`.
- **Files modified:** none (`node_modules/` is gitignored)
- **Committed in:** n/a

**2. [Rule 2 — Missing critical functionality] `reject: false` on the execa call**

- **Found during:** Task 2
- **Issue:** Without it, `ExecResult.exitCode` — a published `number | null` — is unreachable for any non-zero exit, and every failing gate arrives as a thrown error instead of a result.
- **Fix:** `reject: false`, with the deliberate non-handling of spawn-failure classification documented in the same comment block and deferred with its reproduction.
- **Verification:** probe confirmed `process.exit(3)` returns `{ exitCode: 3 }` rather than throwing.
- **Committed in:** `7013d76`

**3. [Rule 1 — Bug] `simple-git` default import does not typecheck**

- **Found during:** Task 2 (`pnpm -r typecheck`)
- **Issue:** `TS2349: This expression is not callable` at both `simpleGit(...)` call sites — the default import resolves to the module namespace under `nodenext` without `esModuleInterop`.
- **Fix:** named import `{ simpleGit }` in `lifecycle.ts` and `temp-repo.ts`, with the reason documented at the import.
- **Committed in:** `7013d76`

**4. [Rule 1 — Bug] Unused parameters on the stub interface methods failed lint**

- **Found during:** Task 2 (`pnpm lint`)
- **Issue:** `_relPath` / `_contents` on the not-yet-implemented `read`/`write` tripped `@typescript-eslint/no-unused-vars`; the repo's config sets `ignoreRestSiblings` but no `argsIgnorePattern`.
- **Fix:** the stubs declare no parameters at all — a method may satisfy an interface with fewer. This avoids a lint exception that would have outlived the stubs into `02-06`'s real implementations.
- **Committed in:** `7013d76`

**5. [Rule 2] Comment density restored for the remaining forward declarations**

- **Found during:** Task 3
- **Issue:** Rewriting the `Workspace` forward-declaration comment left `FeatureView`/`StageConfig`/`AgentRunner`/`ArtifactSink`/`RoundSummary` with no group comment, against the file's stated convention that every group explains what it is for.
- **Fix:** added a group comment naming the phase that lands each.
- **Committed in:** `d530abf`

**6. [Rule 1] Prettier formatting**

- **Found during:** Task 2
- **Issue:** `pnpm format` failed on two new files. Not in the plan's verification list, but it is a repository check and would have gone red in CI.
- **Fix:** `prettier --write` on `packages/workspace`.
- **Committed in:** `7013d76`

---

**Total deviations:** 6 auto-fixed (1 blocking-environmental, 3 bugs, 2 missing-functionality). No Rule 4 architectural changes; no scope creep.

### Deliberate scope boundaries held

`read`, `write` and `snapshot` throw a `WorkspaceError` naming plan `02-06`. The full neutraliser set and Windows key normalisation stayed out of `env.ts` (plan `02-05`); idempotent teardown and the prune fallback stayed out of `lifecycle.ts` (plan `02-04`); retry-on-`EBUSY` stayed out of `scratch-home.ts` (plan `02-05`). Each is marked with a scope note naming its owning plan.

## Issues Encountered

- **`pnpm -r test` was non-zero between Task 1 and Task 2.** Vitest exits 1 on a project with no test files, and Task 1 deliberately ships no behaviour. Task 1's own `<verify>` (`pnpm -r build`) passed. Rather than add `passWithNoTests` — which would permanently weaken every package's suite to paper over a one-commit window — the state was left and resolved by the tracer in the very next commit. `pnpm -r test` exits 0 at plan end.
- **A `git checkout --` on a single file during probe cleanup discarded a legitimate edit alongside the probe**, and had to be re-applied. Noted so the next executor scopes probe reverts to the probe file itself.

## Threat Model Verification

| Threat ID | Disposition | Status                                                                                                                                                                                                                       |
| --------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-2-06    | mitigate    | **Mitigated.** `extendEnv: false` with an explicitly constructed env; the tracer asserts a parent-set variable the spec does not name is absent from the child's output, and the assertion was watched failing.                 |
| T-2-07    | mitigate    | **Mitigated.** `killDescendants: true`, `cancelSignal` fed from `spec.signal`, and `forceKillAfterDelay: 5_000` all stated explicitly in `run.ts` with comments naming why each is a control rather than a default.             |
| T-2-08    | mitigate    | **Mitigated.** `buildChildEnv` contains no logging and no value interpolation; the one error message names the variable name only. Recorded as a `must_haves.prohibitions` item for a later verifier.                           |
| T-2-09    | mitigate    | **Mitigated.** `buffer: false` plus two-loop `iterable()` consumption; nothing is pushed into an unbounded array. The output-size cap remains WORK-09 / Phase 15 and was deliberately not built.                                |
| T-2-10    | mitigate    | **Mitigated.** `ExecSpec.argv` is `readonly string[]` and no field on the type accepts a command string; `execa(file, args)` is called with an argv array and no shell.                                                         |
| T-2-SC    | mitigate    | **Mitigated.** `execa@10.0.1` and `simple-git@3.36.0` installed at plan `02-01`'s human-approved pins verbatim, confirmed present in the lockfile at those exact versions. No `allowBuilds` entry added, so neither may run an install script. |

## Threat Flags

None. This plan adds no network endpoint, no auth path, and no schema change. It does add the repository's first process-launch and filesystem-write surface, but that surface is the subject of the phase's existing register (T-2-06 through T-2-10) rather than new territory.

## Known Stubs

| File                                        | Symbol                     | Reason                                                                                                                                        |
| ------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/workspace/src/worktree/backend.ts` | `read`, `write`, `snapshot` | Plan `02-06` implements them together with the D-02 containment guard they require. Each rejects with a `WorkspaceError` naming that plan — they fail loudly rather than returning empty data, and no caller depends on them yet. |

These are intentional and plan-assigned. The exec and lifecycle path — everything this plan's goal depends on — is real.

## User Setup Required

None.

## Next Phase Readiness

- **`02-04` (GC and inventory)** — `branchNameFor`, `createWorktree`, `destroyWorktree` and `withTempRepo` are in place. `destroyWorktree` is deliberately non-idempotent: it will throw on an already-removed worktree, and `02-04` owns the `isAlreadyGone` handling plus the `prune` fallback.
- **`02-05` (env hardening, scratch HOME)** — `buildChildEnv` ships the zero-inherit default and the undefined rejection only. The neutraliser set, Windows key-case normalisation, and `EBUSY` retry on teardown are all still open, exactly as scoped. Note that `02-05`'s "buildChildEnv is reachable from exactly two files" assertion holds today.
- **`02-06` (registry, stub backend, containment)** — `read`/`write`/`snapshot` are the three stubs to fill; `WorkspaceError` is in place and `ContainmentError` is still to be added to `errors.ts`.
- **Carry-forward, important:** use `import { simpleGit } from 'simple-git'`, not the default import CLAUDE.md suggests. The default import does not typecheck under this repo's compiler settings.
- **Open, non-blocking:** `deferred-items.md` D-2-03-1 — `run()` cannot distinguish a missing binary from a non-zero exit, with the Windows reproduction recorded.

## Verification

Against the plan's `<verification>` block, all run at plan end:

| Check                              | Exit |
| ---------------------------------- | ---- |
| `pnpm -r typecheck`                | 0    |
| `pnpm -r build`                    | 0    |
| `pnpm lint`                        | 0    |
| `pnpm -r test`                     | 0    |
| `pnpm vitest run --project workspace` | 0 |
| `pnpm vitest run --project root`   | 0    |
| `pnpm format`                      | 0    |

Against `<success_criteria>`:

- A feature id produces a worktree on `adl/<featureId>`, a real process runs inside it through the one exec path, tagged output streams back, and teardown removes both the worktree and the branch. ✅ (tracer test; teardown assertion watched failing)
- The child's environment contains nothing the caller did not name. ✅ (watched failing under `extendEnv: true`)
- `Workspace` is a real published interface with `networkPolicy` and `resources` present from the first commit. ✅

## Self-Check

**PASSED**

- `packages/core/src/stage/workspace.ts` — FOUND
- `packages/workspace/package.json` — FOUND (`execa` `10.0.1`, `simple-git` `3.36.0`)
- `packages/workspace/src/exec/run.ts` — FOUND
- `packages/workspace/src/exec/env.ts` — FOUND
- `packages/workspace/src/exec/scratch-home.ts` — FOUND
- `packages/workspace/src/worktree/lifecycle.ts` — FOUND
- `packages/workspace/src/worktree/backend.ts` — FOUND
- `packages/workspace/test/helpers/temp-repo.ts` — FOUND
- `packages/workspace/test/tracer.test.ts` — FOUND
- Commit `ee0fef8` — FOUND
- Commit `7013d76` — FOUND
- Commit `d530abf` — FOUND
- No file deletions in any commit — CONFIRMED
- Scratch probe files (`scratch-probe.ts`, `scratch-reject.test.ts`, `scratch-probe2.test.ts`, `probe-usable.ts`) — all removed, none tracked

---

_Phase: 02-workspace-the-exec-boundary_
_Completed: 2026-08-18_
