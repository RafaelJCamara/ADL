---
phase: 04-first-agent-backend-live-transcripts
plan: 02
subsystem: workspace
tags: [git, worktree, privilege-drop, safe-directory, D-2-08-1]
dependency-graph:
  requires: []
  provides:
    - "writeScratchGitConfig(home, { safeDirectories })"
    - "SCRATCH_GITCONFIG_FILENAME"
  affects:
    - "packages/workspace/src/worktree/backend.ts (worktreeWorkspace call sequence)"
    - "packages/workspace/src/exec/env.ts (GIT_CONFIG_GLOBAL construction)"
tech-stack:
  added: []
  patterns:
    - "Scratch-HOME-scoped git global config, written before any child launches, replacing rather than appending on reuse"
key-files:
  created:
    - packages/workspace/test/worktree/safe-directory.test.ts
  modified:
    - packages/workspace/src/exec/scratch-home.ts
    - packages/workspace/src/exec/env.ts
    - packages/workspace/src/worktree/backend.ts
    - packages/workspace/src/index.ts
decisions:
  - "GIT_CONFIG_GLOBAL's filename and the writer's filename share one constant (SCRATCH_GITCONFIG_FILENAME) so the pointer and the writer cannot name two different files."
  - "writeScratchGitConfig sets its mode with an explicit chmod AFTER writeFile, not writeFile's own mode option — the option is subject to the calling process's umask, which a common 022 umask would have silently stripped the group-write bit the function exists to set."
  - "safe.directory values are quoted per git config syntax (backslash and double-quote escaped) rather than written bare, so a Windows path's backslashes and any embedded double-quote survive round-tripping through git's own config parser without being read as invalid escapes."
metrics:
  duration: "~45 minutes"
  completed: 2026-08-20
status: complete
actuals:
  tokens: 5782
  tasks: 2
  commits: 2
---

# Phase 4 Plan 02: Scratch-HOME safe.directory git config Summary

Fixes D-2-08-1 — the carried-forward defect where a Linux privilege-dropped
worker cannot run git inside its own worktree (`fatal: detected dubious
ownership in repository`, exit 128) — by writing a scratch-HOME-scoped
global git config marking the worktree and the main repository
`safe.directory` before any child process is launched.

## What Was Built

**`writeScratchGitConfig(home, { safeDirectories })`** in
`packages/workspace/src/exec/scratch-home.ts` writes `<home>/.gitconfig`
containing a `[safe]` section with one `directory = "<path>"` entry per
supplied path, quoted per git's config-file syntax so a Windows path's
backslashes (and any embedded double quote) survive git's own parser
unmodified. A second call over the same home **replaces** the file rather
than appending, so a reused scratch home never accumulates duplicate
entries. `SCRATCH_GITCONFIG_FILENAME` (`.gitconfig`) is exported and shared
with `exec/env.ts`, whose `neutralisers()` already pointed every child's
`GIT_CONFIG_GLOBAL` at this exact path — the writer and the pointer now
build from the same constant and cannot drift into naming two different
files. A failed write throws a `WorkspaceError` (unlike `recordOwner`'s
swallowed failure): a missing config file means every git command every
child of the workspace runs fails, so this is a real failure, not
best-effort hygiene.

`worktreeWorkspace()` in `src/worktree/backend.ts` calls
`writeScratchGitConfig` immediately after `createScratchHome()` resolves and
before `applyWorkerAccess` runs, passing both `worktreePath` and
`spec.mainRepo` as safe directories — a linked worktree's git operations
reach into the main repository's `.git` too, so marking only the worktree
would leave half of every command unowned. The ordering matters twice: the
file must exist before any child is launched, and writing it before the
access grant means `applyWorkerAccess`'s existing recursive walk over
`scratchHome.path` (verified against `exec/privilege.ts`'s
`grantGroupAccess`, which recurses via `readdir` rather than granting only
the directories it is handed) picks up the new file automatically — no
separate path needed to be added to the granted list. A comment at the call
site records the CVE-2022-24765 rationale and states Assumption A4 honestly:
this marking makes git *proceed*; it is not proof the worktree's on-disk
ownership is actually correct.

`src/index.ts` exports both new symbols with a "why public" comment
matching `applyWorkerAccess`'s precedent: an out-of-tree workspace backend
facing the identical uid-mismatch problem needs the same reviewed code
rather than an unreviewed second implementation.

**Test coverage** (`test/worktree/safe-directory.test.ts`, three `describe`
blocks):

1. **`writeScratchGitConfig` unit tests** — empty-directories case parses as
   `[safe]` with no entries; two paths produce ordered entries; a second call
   replaces rather than appends; the file names both supplied paths; the
   POSIX-gated mode assertion (owner+group read/write, no world bit); and a
   test proving `env.ts`'s `GIT_CONFIG_GLOBAL` is built from the same
   `SCRATCH_GITCONFIG_FILENAME` constant.
2. **`worktreeWorkspace` wiring** — the config file exists immediately after
   `worktreeWorkspace()` resolves, asserted *before* any `exec()` call; `git
   config --get-all safe.directory` run through `workspace.exec` reports both
   the worktree root and the main repository (this is also the verbatim
   round-trip proof, since `withTempRepo`'s real temp paths are
   backslash-laden on Windows); and a real `git status --porcelain` exits 0
   with no "dubious ownership" text.
3. **The D-2-08-1 reproduction** (Task 2) — Linux-privilege-drop-gated via
   `linuxOnly()` (D-21): a real worker identity runs `git status` inside its
   own worktree and succeeds, plus a negative control that removes the
   scratch `.gitconfig` and asserts the same command then fails with
   "dubious ownership" — without the control a green positive assertion
   would be indistinguishable from git never having cared on the host at
   all.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `writeFile`'s `mode` option is masked by umask; switched to an explicit `chmod`**
- **Found during:** Task 1, while writing the mode-assertion test.
- **Issue:** The plan's `read_first` pointed at `recordOwner`'s
  `writeFile(..., { mode })` convention. `recordOwner` uses `0o600`, which
  has no group/world bits for a typical `022` umask to strip — but
  `writeScratchGitConfig` needs `0o660` (group read/write), and `writeFile`'s
  `mode` option is subject to the calling process's umask at creation time.
  A default `022` umask would have silently reduced `0o660` to `0o640`,
  dropping the group-write bit this function exists to set, before
  `applyWorkerAccess`'s later `chmod` ever runs.
- **Fix:** Write the file with `writeFile(..., { encoding: 'utf8' })` (no
  `mode` option) and then call `chmod(path, 0o660)` explicitly — `chmod` is
  not subject to umask, so the resulting mode is deterministic regardless of
  the daemon process's umask setting.
- **Files modified:** `packages/workspace/src/exec/scratch-home.ts`
- **Commit:** ccc8ded

### Task-boundary note (not a deviation, documented for the record)

Both tasks touch the same test file (`safe-directory.test.ts`) by design —
Task 2 adds a fourth `describe` block to the file Task 1 creates. The two
were implemented together in one pass, then the diff was deliberately split
back into two atomic commits (`ccc8ded` for Task 1, `93d64b3` for Task 2) via
`git reset --soft` and a manual re-split, each independently re-verified
(`pnpm --filter @adl/workspace test`, `pnpm lint`, `pnpm -r typecheck`,
`pnpm format`) before its own commit, so the per-task commit boundary the
executor protocol requires is real rather than cosmetic.

## Task 2 Outcome — the D-2-08-1 reproduction did NOT execute this session

Per the plan's explicit instruction to record this outcome plainly:

- **Did the reproduction run?** No. This executor ran on the maintainer's
  Windows worktree (`platform: win32`). The `linuxOnly()` gate wrote its
  stated skip line to stderr:
  `[ADL][SKIPPED][D-2-08-1] D-2-08-1 only reproduces when the child running
  git has a different uid than the worktree owner, which requires the Linux
  privilege drop (D-05) to actually create the mismatch (platform: win32)`.
- **On which runner?** None — no Linux host or CI leg was available in this
  session. The test is wired to run automatically on the Linux CI leg
  Phase 2's D-21 provisions (`ADL_WORKER_USER` / `ADL_WORKER_GROUP` set), and
  to FAIL rather than skip there if the worker user is unset — so a CI run
  that forgets provisioning goes red instead of silently passing.
- **What did the negative control return?** Unknown — neither branch of the
  gated `it` executed, so the negative control's assertion
  (`git status` fails with "dubious ownership" once the scratch `.gitconfig`
  is removed) has not been observed to pass or fail on this run.
- **04-RESEARCH.md Assumption A4** ("the fix's sufficiency is unverified
  without a Linux host") therefore **stays open**. It is not closed by this
  plan's execution. Recorded in `.planning/WINDOWS.md` as an `unrun-verify`
  entry so it is visible at ship time rather than only in this file.

Everything that *can* run everywhere did run and is green: `writeFile` unit
tests, the `worktreeWorkspace` wiring tests (including the real
`git config --get-all safe.directory` and `git status --porcelain` calls
against a real temporary repository on Windows), lint, typecheck, and
format.

## Verification

- `pnpm --filter @adl/workspace test`: 222 passed, 6 skipped (all skips are
  the expected Windows-platform / no-privilege-drop gates: `CR-03` mode
  bits, the `D-2-08-1` worker-write mode assertion, `WORK-05`'s two
  identity/access assertions, and this plan's `D-2-08-1` reproduction).
- `pnpm lint`: clean.
- `pnpm -r typecheck` (workspace scope): clean.
- `pnpm format` (`prettier --check .`): clean.
- The existing `ExecSpec.env` git-configuration-family refusal suite
  (`test/exec/env.test.ts`) is unchanged and still passes — `namesGitExecution()`
  was not touched by this plan.

## Self-Check: PASSED

- `packages/workspace/src/exec/scratch-home.ts` — FOUND, contains
  `writeScratchGitConfig` and `SCRATCH_GITCONFIG_FILENAME`.
- `packages/workspace/src/exec/env.ts` — FOUND, `GIT_CONFIG_GLOBAL` built
  from `SCRATCH_GITCONFIG_FILENAME`.
- `packages/workspace/src/worktree/backend.ts` — FOUND, calls
  `writeScratchGitConfig` before `applyWorkerAccess`.
- `packages/workspace/src/index.ts` — FOUND, exports both new symbols.
- `packages/workspace/test/worktree/safe-directory.test.ts` — FOUND, three
  `describe` blocks as documented above.
- Commit `ccc8ded` — FOUND in `git log --oneline`.
- Commit `93d64b3` — FOUND in `git log --oneline`.
