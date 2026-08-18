---
phase: 02-workspace-the-exec-boundary
reviewed: 2026-08-18T00:00:00Z
depth: standard
files_reviewed: 49
files_reviewed_list:
  - .github/workflows/ci.yml
  - eslint.config.js
  - packages/core/src/stage/index.ts
  - packages/core/src/stage/stage.ts
  - packages/core/src/stage/workspace.ts
  - packages/plugin-sdk/src/index.ts
  - packages/plugin-sdk/test/reexport-identity.test.ts
  - packages/workspace/README.md
  - packages/workspace/package.json
  - packages/workspace/src/errors.ts
  - packages/workspace/src/exec/env.ts
  - packages/workspace/src/exec/privilege.ts
  - packages/workspace/src/exec/run.ts
  - packages/workspace/src/exec/scratch-home.ts
  - packages/workspace/src/git/host-backend.ts
  - packages/workspace/src/git/manager-git.ts
  - packages/workspace/src/index.ts
  - packages/workspace/src/paths.ts
  - packages/workspace/src/registry.ts
  - packages/workspace/src/stub/backend.ts
  - packages/workspace/src/teardown.ts
  - packages/workspace/src/worktree/backend.ts
  - packages/workspace/src/worktree/gc.ts
  - packages/workspace/src/worktree/lifecycle.ts
  - packages/workspace/src/worktree/list.ts
  - packages/workspace/test/contract/workspace-contract.test.ts
  - packages/workspace/test/exec/credentials.test.ts
  - packages/workspace/test/exec/env.test.ts
  - packages/workspace/test/exec/privilege.test.ts
  - packages/workspace/test/exec/scratch-home.test.ts
  - packages/workspace/test/git/manager-git.test.ts
  - packages/workspace/test/git/poisoned-config.test.ts
  - packages/workspace/test/helpers/contract.ts
  - packages/workspace/test/helpers/env-dump-child.cjs
  - packages/workspace/test/helpers/platform.ts
  - packages/workspace/test/helpers/temp-repo.ts
  - packages/workspace/test/paths.test.ts
  - packages/workspace/test/registry.test.ts
  - packages/workspace/test/tracer.test.ts
  - packages/workspace/test/worktree/gc.test.ts
  - packages/workspace/test/worktree/lifecycle.test.ts
  - packages/workspace/test/worktree/list.test.ts
  - packages/workspace/tsconfig.json
  - packages/workspace/vitest.config.ts
  - test/lint/fixtures/spawn-direct-import.ts
  - test/lint/fixtures/spawn-dynamic-execa.ts
  - test/lint/fixtures/spawn-dynamic-import.ts
  - test/lint/fixtures/spawn-require.ts
  - test/lint/no-restricted-imports.test.ts
findings:
  critical: 3
  warning: 14
  info: 5
  total: 22
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-08-18
**Depth:** standard
**Files Reviewed:** 49
**Status:** issues_found

## Summary

The phase's stated security properties were reviewed against their stated intent, and
most of them hold as written: `buildChildEnv`'s zero-inherit construction, the
case-folded reserved-variable rejection, `assertWithinRoot`'s deepest-existing-prefix
realpath walk, the `NEUTRALISE_ARGS` prefix on `managerGitClient`, the
per-key poisoned-config loop, and the lint suite's negative control are all sound and
several are better than their documentation claims.

Three findings are not accounted for anywhere in the phase's artifacts, including
`deferred-items.md`:

1. **The config-neutralisation boundary is not the boundary it claims to be.** Three
   production modules (`worktree/lifecycle.ts`, `worktree/list.ts`,
   `worktree/backend.ts`) invoke `git` through `simple-git`, bypassing `run()`,
   `buildChildEnv`, and `NEUTRALISE_ARGS` entirely. `manager-git.ts` says the
   neutralisation happens "on every invocation, or not at all"; for these call sites it
   is "not at all". `poisoned-config.test.ts` demonstrates the exploit against this exact
   code shape — line 337's comment describes a `simple-git` call in the suite's own
   fixture accidentally executing an attacker-planted hook — and then does not apply the
   conclusion to production.
2. **Those same children inherit the daemon's full environment**, because `simple-git`
   passes `env: undefined` to `spawn` (verified in the installed
   `simple-git@3.36.0`, `dist/cjs/index.js:1887`). D-10's zero-inherit property does not
   hold for any ADL-side git call outside `managerGitClient`, which is what turns
   finding 1 from "code execution" into "code execution holding the forge token and the
   model key".
3. **There is one worker identity for all concurrent features.** Every feature's worktree
   and scratch `HOME` is made group-rwx to the same `adl-worker` group, so a malicious
   feature spec's agent can read and rewrite a *different* feature's source before it is
   reviewed and pushed. The README's permission model reads as though the grant is
   per-feature.

Beyond those: several correctness defects with real operational consequence (locale-
dependent "already gone" matching that silently breaks teardown idempotency, a teardown
report that says `reclaimed` for a resource that was already absent, `Number('') === 0`
producing gid 0 from a malformed group line, orphaned scratch `HOME`s that nothing ever
collects), and two tests whose controls do not discriminate as strongly as their prose
claims.

Deliberate decisions named in the phase context (`reject: false`, `force` omitted from
`rm`, deepest-existing-prefix realpath, the sole-registry rule, the negative-control
fixtures) were judged against their intent and are **not** reported as defects.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: ADL runs `git` inside agent-controlled repositories with no config neutralisation, via `simple-git`

**File:** `packages/workspace/src/worktree/backend.ts:236-259,278`, `packages/workspace/src/worktree/lifecycle.ts:164,176,184,241-255`, `packages/workspace/src/worktree/list.ts:119-124`

**Issue:**
`manager-git.ts:33-35` states the threat and the rule: git config names programs git
executes, an agent inside a linked worktree can write the *main* repository's
`.git/config`, and therefore ADL "neutralises them itself, on every invocation, or not
at all." `host-backend.ts:20-25` restates it: "there is exactly one exec primitive in
the repository … one place where the neutralisation of `02-RESEARCH.md § Pitfall 5` is
applied — by construction rather than by every future call site remembering."

Both claims are false in this phase's own source. Eight production git invocations go
through `simpleGit(...).raw([...])` rather than through `Workspace.exec()`, and none of
them carries `NEUTRALISE_ARGS`:

- `backend.ts:238` `git status --porcelain` — in the **agent's worktree**
- `backend.ts:250,253` `git stash create`, `git rev-parse HEAD` — in the agent's worktree
- `backend.ts:259,286` `git update-ref` / `update-ref -d` — in the agent's worktree
- `backend.ts:278` `git checkout <sha> -- .` — in the agent's worktree
- `lifecycle.ts:176,184` `git branch --list`, `git worktree add -b …` — in the main repo
- `lifecycle.ts:244,250,255` `git worktree remove --force`, `worktree prune`, `branch -D`
- `list.ts:119` `git worktree list --porcelain -z` — in the main repo

All of these read `<mainRepo>/.git/config`, which is exactly the file the phase's own
threat model says an agent can write whenever the privilege drop is not in force —
i.e. on Windows, on macOS, and on any Linux host where `ADL_WORKER_USER` is unset, all
three of which are documented as supported v1 configurations (`README.md:44-57`).

Concrete exploit chain, using only mechanisms this phase has already reproduced in its
own test suite:

1. Feature A's agent runs `git config core.hooksPath /tmp/evil` inside its worktree.
   `poisoned-config.test.ts:408-427` proves this lands in `<mainRepo>/.git/config`.
2. ADL later calls `workspace.snapshot()` on any feature. `backend.ts:238` runs
   `git status --porcelain` through `simple-git`.
   `poisoned-config.test.ts:429-464` — the CONTROL case — proves a planted
   `post-index-change` hook **executes** during an unneutralised `git status`.
3. The hook runs as the **daemon** user, with the daemon's full environment (see CR-02).

`git worktree add` (`lifecycle.ts:184`) fires the `post-checkout` hook, so step 2 does
not even require a live agent: a poisoned config persists in `.git/config` and detonates
the next time *any* feature's worktree is created. `core.fsmonitor` (also in
`NEUTRALISED_CONFIG`, also unneutralised here) fires on every index refresh, which
covers `status`, `stash create`, `checkout` and `worktree add`.

The suite's own words at `poisoned-config.test.ts:330-337` describe this exact code shape
as the threat: *"a plain, unremarkable git command run by a process that is not the
manager client executed an attacker-planted program … That is the whole threat in one
line."* That comment is about `repo.git.raw(['checkout', '--', 'tracked.txt'])` — the
same `simple-git` `raw()` call that `lifecycle.ts` and `backend.ts` make in production.

Note also that the `adl/no-direct-spawn` exemption argument in `host-backend.ts:12-25`
(T-2-40 — "a bypass inside the one directory the rule cannot see into") is realised
in-tree: these three modules *are* the process launches the exemption was supposed to
make unnecessary, and nothing in the package guards against them.

**Fix:** Route every ADL-side git invocation through `managerGitClient` / `Workspace.exec()`,
or — if `simple-git` is to remain for worktree plumbing — give it the same overrides and
a controlled environment at the single place the handle is constructed, and add a guard
that fails if any `simple-git` handle is built elsewhere:

```ts
// packages/workspace/src/git/simple-git-handle.ts — the ONLY simpleGit() call site.
import { simpleGit, type SimpleGit } from 'simple-git';
import { NEUTRALISE_ARGS } from './manager-git.js';

/** Every ADL-side simple-git handle. The prefix and the env are not optional. */
export function adlGit(cwd: string): SimpleGit {
  return simpleGit(cwd, {
    // -c overrides must precede the subcommand; simple-git puts `config` first.
    config: [...NEUTRALISED_CONFIG],
    // Zero-inherit: simple-git passes `env: undefined` to spawn otherwise (CR-02).
  }).env({
    PATH: process.env.PATH ?? '',
    HOME: adlGitHome,
    GIT_CONFIG_GLOBAL: join(adlGitHome, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C', // see WR-03
  });
}
```

and add a sole-site assertion beside the existing registry guard in
`test/contract/workspace-contract.test.ts`: no file under `src/` other than
`git/simple-git-handle.ts` may name `simple-git` or `simpleGit`.

---

### CR-02: every `simple-git` child inherits the daemon's whole environment, including credentials

**File:** `packages/workspace/src/worktree/lifecycle.ts:32,164,241`, `packages/workspace/src/worktree/list.ts:11,119`, `packages/workspace/src/worktree/backend.ts:24,236`

**Issue:**
`env.ts:1-30` and `workspace.ts:91-97` state D-10 unconditionally: "Nothing is inherited
from the worker process. Credentials arrive here, on the one `exec()` that needs them,
and nowhere else (WORK-06)." `index.ts:2-9` repeats it for the whole package.

`simple-git@3.36.0` spawns with `env: this.env` (`dist/cjs/index.js:1887`), and `this.env`
is `undefined` unless `.env()` was called — which none of these call sites does.
`child_process.spawn` with `env: undefined` inherits `process.env` in full. Every `git`
process ADL starts for worktree creation, listing, teardown and snapshotting therefore
receives `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, and anything else in the daemon's
environment — plus any `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` the daemon happens to carry.

On its own this is a violation of the phase's central stated property. Combined with
CR-01 it is the payload: the attacker-planted hook that executes during
`git status`/`git worktree add` runs with the daemon's credentials in its environment,
which is precisely the outcome `credentials.test.ts` exists to prove impossible — and
that suite only ever measures children launched through `run()`.

**Fix:** As in CR-01, construct every handle through one factory that calls
`.env({...})` with an explicitly built record. Then extend `credentials.test.ts` with a
case that measures a *git* child rather than only `run()`'s children — e.g. poison
`core.fsmonitor` with a script that dumps its own environment to a file, drive
`snapshot()`, and assert the credential patterns are absent from the dump. Without that
case, the fix has no regression guard.

---

### CR-03: one shared worker identity gives every concurrent feature read/write access to every other feature's worktree and scratch `HOME`

**File:** `packages/workspace/src/exec/privilege.ts:386-401,450-467,506-565`, `packages/workspace/src/worktree/backend.ts:117-143`, `packages/workspace/README.md:252-265`

**Issue:**
The worker identity is per *deployment*, not per feature — stated explicitly at
`worktree/backend.ts:66-73`: "It lives here rather than on `WorkspaceSpec` because a spec
is per feature and an OS identity is per deployment." Every feature's workspace therefore
calls `applyWorkerAccess([scratchHome, worktreePath, adminDir], { group: adl-worker })`,
and `grantGroupAccess` (`privilege.ts:450-467`) sets group `rwx` on directories and
group `rw` on files, recursively, for the same group in every case.

Consequence: with features A and B running concurrently — which `errors.ts:9-12` says is
the normal case ("the daemon runs many workspaces concurrently") — A's agent and B's
agent are the *same uid* and the *same group*. A's agent can:

- read and rewrite `<scratchRoot>/B/**`, i.e. the source code ADL is about to review,
  test, and open a pull request for, after B's reviewer stage has already passed;
- read `<mainRepo>/.git/worktrees/B/**` and write B's index and `HEAD`;
- enumerate `/tmp` (world-readable) and enter any `adl-home-*` directory, all of which
  are group-rwx to `adl-worker`, reading whatever another agent wrote there — a
  `.gitconfig` credential helper, an `.npmrc` token, a CLI session file.

That last point also weakens `scratch-home.ts:9-16`'s security argument: `mkdtemp`'s
unpredictable name defeats a *guessing* attacker, not one who can `ls /tmp` and traverse
into the directory, which the shared group permits.

The README presents the model as per-feature — `README.md:37-42` "The child can write
its scratch `HOME` and its own worktree", `README.md:255-261` "Everything else | whatever
the OS gives a system account with no groups" — which is not what the implementation
grants. Given D-22 records the feature spec as untrusted input written by anyone who can
push, "feature A's agent silently edits feature B's diff" is a supply-chain path into a
human-approved PR, and it is the one thing this phase's isolation model exists to stop.

**Fix:** Either narrow the grant or state the limit honestly. Narrowing is the real fix:

```ts
// A worker identity per feature, not per deployment.
export interface WorkerIdentity {
  readonly user?: string;   // adl-worker-<n>, from a pre-provisioned pool
  readonly group?: string;  // adl-feat-<featureId>, or the pool member's own group
}
```
with `applyWorkerAccess` granting the *feature's own* group and the pool sized to the
manager's concurrency limit. If that is deferred to a later phase, it must be recorded in
`deferred-items.md` with the cross-feature reproduction, and `README.md`'s permission
table must gain a row saying that all concurrently running features share one OS identity
and can reach each other's worktrees.

---

## Warnings

### WR-01: `Workspace.exec()` never validates `ExecSpec.cwd` against the workspace root

**File:** `packages/workspace/src/exec/run.ts:113-115`, `packages/workspace/src/worktree/backend.ts:150-162`, `packages/workspace/src/git/host-backend.ts:184-194`

**Issue:** `workspace.ts:80-81` declares the contract — "Working directory for the child.
**The backend resolves it inside the workspace root.**" No backend does. `cwd` is passed
verbatim to execa. `read`/`write` go through `assertWithinRoot` (D-02, "rejected at the
interface, not by convention"), while `exec` — the more powerful of the three — has no
guard at all. A third-party harness receiving a `Workspace` through
`@adl/plugin-sdk` can run any binary with `cwd: '/'`. The suite itself relies on this
(`poisoned-config.test.ts:215-217` runs the *host* workspace with `cwd: feature.root`),
so the divergence is load-bearing and undocumented rather than accidental.

**Fix:** Either enforce the declared contract in each backend's `exec` —
`await assertWithinRoot(root, relative(root, spec.cwd))`, or an `isWithinRoot` check on
the resolved absolute path — or change the `ExecSpec.cwd` docblock to say the backend does
*not* constrain it and record why. A doc comment that describes a guard that does not
exist is worse than no comment, because reviewers stop looking.

### WR-02: `buildChildEnv` does not reserve `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`

**File:** `packages/workspace/src/exec/env.ts:62-98,139-175`

**Issue:** The module docblock (`env.ts:10-20`) names `GIT_CONFIG_COUNT` +
`GIT_CONFIG_KEY_0`/`VALUE_0` as arbitrary code execution and says "The zero-inherit
default below is the only reason that vector is unreachable today — there is no second
control behind it." That is true for *inheritance*, and false for `ExecSpec.env`:
`GIT_CONFIG_GLOBAL` is reserved (so it cannot be redirected), but `GIT_CONFIG_COUNT`,
`GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`, `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF`,
`GIT_PAGER`, `GIT_EDITOR`, `GIT_ASKPASS` and `GIT_DIR` all pass straight through. The
`managerGitClient` argv builder already threads an `env` parameter
(`manager-git.ts:212-215`) for Phase 5's forge token, so the caller-supplied-env path into
ADL's own git children exists today and will grow.

**Fix:** Add a rejected-prefix list beside the reserved set, so the second control the
docblock says does not exist actually does:

```ts
const FORBIDDEN_PREFIXES = ['GIT_CONFIG_', 'GIT_SSH', 'GIT_EXTERNAL_DIFF', 'GIT_ASKPASS'];
if (FORBIDDEN_PREFIXES.some((p) => folded.startsWith(p.toLowerCase()))) {
  throw new WorkspaceError(
    `Environment variable ${key} names git configuration or a git-invoked program, which is code execution (see the module docblock). Configure git through the workspace, not through ExecSpec.env.`,
  );
}
```

### WR-03: `destroyWorktree`'s "already gone" detection is locale-dependent, so teardown idempotency silently breaks

**File:** `packages/workspace/src/worktree/lifecycle.ts:206-213,243-258`

**Issue:** `isWorktreeAlreadyGone` matches `/is not a working tree/i` and
`isBranchAlreadyGone` matches `/branch .* not found/i` against git's stderr. Git's
messages are localised through gettext, and — because of CR-02 — these children inherit
the daemon's `LANG`/`LC_ALL`. On a host with a non-English locale (a French or Japanese
production deployment, or a developer laptop), both regexes fail to match, `destroyWorktree`
rethrows, and the property the module calls load-bearing at lines 15-19 ("Each step is
independently idempotent … so 'already gone' must be a no-op rather than an error") is
gone. Downstream: `Workspace.destroy()` throws on a second call, and `sweepOrphans`
(`gc.ts:135-137`) reports every already-collected worktree as a permanent failure, so the
GC backstop stops making progress on exactly the crash-recovery path it exists for.

**Fix:** Force the message locale at the invocation, and/or key off something stable:

```ts
const git = simpleGit(mainRepo).env({ ...adlGitEnv, LC_ALL: 'C', LANG: 'C' });
```
Add a test that runs the idempotent-teardown case under `LC_ALL` set to a locale git
actually translates, so the regression is caught rather than reported by an adopter.

### WR-04: `destroy()` reports `reclaimed` for a worktree that was already absent

**File:** `packages/workspace/src/worktree/backend.ts:315-333`

**Issue:** `destroyWorktree` swallows both "already gone" cases and returns `void`, so
`destroy()` cannot tell "I removed a worktree" from "there was nothing there", and
unconditionally reports `outcome: 'reclaimed'` (lines 322-326). The second `destroy()`
of the same workspace therefore emits `worktree: reclaimed` — a false statement to the
operator — while `workspace.ts:171` documents `already-absent` as "what an idempotent
second teardown looks like" and `teardown.ts:1-14` justifies the whole sink on the grounds
that "an operator can believe what it says". The contract case at
`test/helpers/contract.ts:262-278` does not catch it because its `toContain('already-absent')`
is satisfied by the *scratch-home* entry alone.

**Fix:** Have `destroyWorktree` return what it did and map it:

```ts
export type WorktreeTeardown = 'removed' | 'already-absent';
// ...
report(spec.onTeardown, {
  workspaceId: spec.featureId,
  resource: 'worktree',
  outcome: outcome === 'removed' ? 'reclaimed' : 'already-absent',
});
```
and tighten the contract case to assert the *worktree/root* resource specifically, not
merely that some entry says `already-absent`.

### WR-05: `Number('') === 0` lets a malformed `/etc/group` or `/etc/passwd` line resolve to gid/uid 0

**File:** `packages/workspace/src/exec/privilege.ts:329-344,370-384`

**Issue:** `parseGroupEntries` accepts an entry when `Number.isInteger(Number(fields[2]))`.
`Number('')` is `0`, `Number(' 12 ')` is `12`, and `Number('0x10')` is `16` — so a line
whose gid field is empty or padded yields a *valid-looking* entry, and an empty field
yields **gid 0, the root group**. If the configured `ADL_WORKER_GROUP` matches such a
line, `resolveGroupId` returns 0 and `applyWorkerAccess` chowns the worktree, the scratch
`HOME` and the worktree admin directory to group root and sets group `rw`, reporting
`outcome: 'applied'`. `resolveUserIds` has the identical defect on uid and gid.
Also, a CRLF group file leaves `\r` on the last member name, so
`entry.members.includes(user)` silently fails — which would make
`privilege.test.ts:216-235`'s "the assertion would be vacuous" guard mis-fire.

**Fix:** Parse strictly and reject anything that is not a bare non-negative decimal:

```ts
function parseId(field: string | undefined): number | undefined {
  if (field === undefined || !/^\d+$/.test(field)) return undefined;
  return Number(field);
}
```
and strip a trailing `\r` before splitting fields.

### WR-06: nothing ever collects an orphaned scratch `HOME`

**File:** `packages/workspace/src/worktree/gc.ts:108-141`, `packages/workspace/src/exec/scratch-home.ts:74-76`

**Issue:** `sweepOrphans` reclaims worktrees and `adl/*` branches. The scratch `HOME` is
created under `os.tmpdir()` by `mkdtemp` and is only ever removed by
`Workspace.destroy()` (`backend.ts:328-332`). A worker that dies between
`createScratchHome()` and `destroy()` — the exact crash D-15 says the backstop exists for
— leaves `/tmp/adl-home-*` behind forever: the sweep iterates
`listManagedWorktrees(mainRepo)` and has no inventory of scratch homes to iterate. On a
long-running daemon this accumulates unbounded, and on Linux each leaked directory is
`0770` group-owned by `adl-worker`, so it is also readable by every future agent (see
CR-03) — including whatever credentials or session files the crashed agent wrote there.
`deferred-items.md` records the analogous `refs/adl-snapshots/*` leak; this one is not
recorded anywhere.

**Fix:** Either add a `sweepScratchHomes` beside `sweepOrphans` (enumerate
`tmpdir()/adl-home-*`, apply the same D-16 policy against a recorded feature→home
mapping), or make the home a child of a per-feature directory the worktree sweep already
reaches. At minimum, record it in `deferred-items.md` with the same rigour as D-2-06-1.

### WR-07: `assertWithinRoot` is a check-then-use TOCTOU against a concurrently running agent

**File:** `packages/workspace/src/paths.ts:138-209`, `packages/workspace/src/worktree/backend.ts:177-208`

**Issue:** The guard realpaths, returns a path, and the caller then opens it
(`readFile` / `mkdir` + `writeFile`). Between the two, an agent process running inside its
own worktree — which is the normal state of affairs when a stage writes an artifact — can
replace a path component with a symlink, and the subsequent `open()` follows it. The
module docblock presents the realpath step as *the* answer to T-2-24 ("A symlink planted
inside the root defeats every check here"), and it is, for a symlink planted *before* the
check. It cannot be for one planted after, because the check and the open are two
syscalls.

**Fix:** Make the use atomic with the check where the platform allows, and say so where it
does not:

```ts
const handle = await open(absolute, 'r', { /* Linux */ });   // O_NOFOLLOW on the leaf
// or: openat-style walk, or verify st_dev/st_ino from the guard against fstat of the handle
```
A cheap improvement that needs no new syscalls: `lstat` the leaf after opening and compare
device+inode with the guard's realpath result, failing closed on mismatch. If the residual
race is accepted, the docblock should say the guard defeats *pre-existing* symlinks and
that concurrent replacement is out of scope, so the next reader does not over-trust it.

### WR-08: `createWorktree` passes `baseRef` positionally with no `--end-of-options`, and the feature id may contain git glob characters

**File:** `packages/workspace/src/worktree/lifecycle.ts:154-186`

**Issue:** `baseRef` arrives from `WorkspaceSpec` — ultimately configuration or feature
metadata, which D-22 records as untrusted — and reaches
`git worktree add -b <branch> <path> <baseRef>` with no options terminator. A `baseRef`
beginning with `-` is parsed as a flag by git, not as a commit-ish
(`--detach`, `--no-checkout`, `--lock`, `--reason=<x>` are all accepted there). The
manager-side client already solved this: `manager-git.ts:296-302` passes
`--end-of-options` "so a revision beginning with `-` is a revision and not a flag", with
the note "The same guard is on `effectiveConfig`". The worktree lifecycle did not get it.

Separately, `assertUsableFeatureId` (lines 107-128) rejects separators and NUL but not
git refname metacharacters, so `featureId = '*'` makes
`git branch --list 'adl/*'` (line 176) match every existing ADL branch and refuse
creation, and `featureId = '.'` resolves `worktreePath` to `scratchRoot` itself.

**Fix:**

```ts
await git.raw(['worktree', 'add', '-b', branch, '--end-of-options', worktreePath, baseRef]);
// and, in assertUsableFeatureId:
if (/[*?[\]~^:\x00-\x1f\x7f]|^[.-]|\.\.|\.lock$|@\{/.test(featureId)) throw new WorkspaceError(...);
```
Validating the id against git's own refname rules (`git check-ref-format`'s constraints,
expressed as a regex) is the durable form, since the id becomes a ref either way.

### WR-09: a `snapshot()` taken twice at the same sha aliases one anchoring ref, so releasing one handle unanchors the other

**File:** `packages/workspace/src/worktree/backend.ts:255-288`

**Issue:** The ref is `refs/adl-snapshots/<featureId>/<sha>` and the handle id is the sha.
Two snapshots of an unchanged worktree (a clean tree twice, or two `stash create`s
producing the same tree/parent) yield the same ref. `release()` on the first handle deletes
the ref while the second handle still believes it is anchored — and the second handle's
`released` flag is `false`, so `restore()` will attempt a checkout of an object that is now
unreachable and one `git gc` away from gone. `SNAPSHOT_REF_PREFIX`'s own docblock
(lines 46-59) says the anchoring is the whole point: "a restore handle whose object was
collected is a restore that fails at the worst possible moment."

**Fix:** Make the ref unique per capture rather than per content, e.g.
`refs/adl-snapshots/<featureId>/<ulid>`, keeping the sha as the handle `id` for the audit
trail. Add a case that snapshots twice with no intervening change, releases the first, and
asserts the second still restores.

### WR-10: the creation-time and run-time privilege decisions can disagree, and nothing reconciles them

**File:** `packages/workspace/src/worktree/backend.ts:110-143`, `packages/workspace/src/exec/run.ts:91-96`

**Issue:** The mode is decided twice, against two different PATHs — deliberately, and the
reasoning at lines 112-116 is sound. What is missing is the handling of disagreement:

- creation resolves `dropped` (daemon PATH has `sudo`) → `applyWorkerAccess` widens the
  worktree, the admin dir and the scratch `HOME` to the shared group; a later `exec` whose
  `spec.path` lacks `sudo` resolves `launcher-missing` and runs **as the daemon** with
  those directories left group-writable — exposure with no beneficiary, which is exactly
  the condition `applyWorkerAccess`'s early return at line 510 exists to avoid;
- the reverse — creation resolves not-dropped, `exec` resolves `dropped` — hands the
  worker a `sudo` prefix with no access grant behind it, and every command fails to write
  its own worktree with a permission error that looks like an agent bug.

**Fix:** Have `run()` return or report its resolved mode to the backend, or resolve once
against a PATH the backend owns and pass the `PrivilegeDecision` into `run()`. Failing
that, detect the mismatch and emit a distinct banner naming both PATHs — a silent
half-configured drop is T-2-32's shape.

### WR-11: the sole-construction-site guard only sees static `import … from`, and the spawn ban does not cover `.tsx`/`.mts`/`.cts`

**File:** `packages/workspace/test/contract/workspace-contract.test.ts:122-132`, `eslint.config.js:336-343,164`

**Issue:** Two enforcement gaps in mechanisms the phase treats as structural:

1. `importStatements` matches only `^import … from '…'`. `const { worktreeWorkspace } =
   await import('./worktree/backend.js')` and `require('./worktree/backend.js')` both evade
   it — and inside `packages/workspace/**` the `adl/no-direct-spawn` dynamic-import
   selectors are switched off by `WORKSPACE_EXEMPTION`, so nothing else catches them
   either. The file's own prose (lines 76-82) claims the guard is "the thing that goes red
   instead"; for the dynamic form it is not.
2. Every architecture rule is registered against `files: ['**/*.ts']`. `.tsx`, `.mts`,
   `.cts`, `.js` and `.mjs` are ungoverned. `apps/dashboard` (React, named in
   `CLAUDE.md`) will be `.tsx`, and the spawn ban will not apply to a single file in it.

**Fix:** Extend the guard's regex to `ImportExpression`/`require` forms (or parse with
the TS compiler API, which is already a dependency), and widen the glob to
`['**/*.{ts,tsx,mts,cts,js,mjs,cjs}']` with the same `ignores`. Add a fixture per new
extension so the widening is watched working — the same discipline `test/lint/fixtures/`
already applies.

### WR-12: `NEUTRALISED_CONFIG` omits git's `.gitattributes`-driven execution keys

**File:** `packages/workspace/src/git/manager-git.ts:72-99`

**Issue:** The list is introduced as "Every executable configuration key", and the per-key
loop in `poisoned-config.test.ts` makes trimming it self-defeating — good. But it is not
exhaustive, and the omissions are the ones an attacker reaches through repository content
rather than through config alone: `filter.<driver>.clean` / `.smudge` and
`diff.<driver>.textconv` / `.command` (both invoked when a `.gitattributes` entry names
the driver, on checkout, status and diff), `core.alternateRefsCommand`, `gpg.program` /
`gpg.ssh.program`, `sequence.editor`, `core.askPass`, and `uploadpack.packObjectsHook`.
Wildcard keys cannot be neutralised by name, which is the substantive part of this finding:
`-c filter.x.clean=` closes one driver, not the mechanism.

**Fix:** Add the fixed-name keys to the list (each gains its own assertion automatically),
and handle the wildcard families structurally — e.g. add
`-c core.attributesFile=/dev/null` plus a documented statement that `filter.*`/`diff.*`
drivers remain reachable through a committed `.gitattributes`, so the residual risk is
recorded rather than implied by the word "every". Update the README table in the same
change; `manager-git.test.ts:366-386` will enforce the correspondence.

### WR-13: the workspace package's tests are never typechecked

**File:** `packages/workspace/tsconfig.json:13`, `packages/workspace/package.json:22`, `packages/workspace/vitest.config.ts:1-9`

**Issue:** `include` is `["src/**/*.ts"]` and `typecheck` is a bare `tsc --noEmit`, so none
of the ~2,600 lines under `test/` is ever compiled — vitest transpiles without checking.
`packages/core` solved exactly this with `tsconfig.test.json` ("an assertion that is never
compiled asserts nothing"), and the workspace package, which has far more test code and
several non-null assertions (`privilege.test.ts:209-261`) and `as unknown as` casts
(`env.test.ts:103-105`), did not adopt it. A test that stops compiling — a renamed export,
a changed signature — will not fail CI's typecheck step; it will fail at runtime with a
message about the wrong thing, or silently stop asserting.

**Fix:** Copy `packages/core/tsconfig.test.json` into the package and either wire
`test.typecheck` in `vitest.config.ts` or make `typecheck` run both programs:
`"typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.test.json"`.

### WR-14: CI exercises Linux only, so every Windows-specific branch in this phase is unverified

**File:** `.github/workflows/ci.yml:15,29`

**Issue:** `runs-on: ubuntu-latest`, matrixed on Node version only. This phase's source
contains platform-conditional behaviour on nearly every security path —
`env.ts:80-96` (`USERPROFILE` on win32), `paths.ts:51` (case-folded comparison),
`scratch-home.ts:89` (`EBUSY`/`EPERM` retry), `privilege.ts:211` (the OS gate),
`temp-repo.ts:94` and `credentials.test.ts:120` (chmod skips) — and the phase's own history
(`platform.ts:1-23`, D-21) is *about* a control that passed for the wrong reason on one
platform. The maintainer's machine is the only place the Windows branches ever run, and it
is not a gate.

**Fix:** Add `windows-latest` (and ideally `macos-latest`) to the matrix, with the worker
provisioning step guarded by `if: runner.os == 'Linux'`. The `linuxOnly` helper already
does the right thing on a non-Linux runner: it prints its `[ADL][SKIPPED]` line and
continues, so the extra legs are cheap and immediately meaningful.

---

## Info

### IN-01: the aborted-signal contract case cannot distinguish "killed" from "never started"

**File:** `packages/workspace/test/helpers/contract.ts:212-237`

**Issue:** The case asserts `exitCode !== 0`, `durationMs < 30_000` and `chunks == []`. A
child that was never spawned satisfies all three: `run()` maps execa's `undefined`
exitCode to `null` (`run.ts:203`), which is `!== 0`. The comment says "the assertion that
this call returns at all is the assertion that it was killed", which is only true if
something proves the process existed. This matters because D-2-07-1 defers the question
of whether cancellation actually reaches a dropped child and says "measure first" — and
this case looks, at a glance, like the measurement.

**Fix:** Have the child write a marker to a file in the workspace root before sleeping,
abort after observing the marker, and assert both that the marker exists (it ran) and that
a second marker written after the sleep does not (it was killed).

### IN-02: `tracer.test.ts` asserts scratch-home removal unconditionally

**File:** `packages/workspace/test/tracer.test.ts:135`

**Issue:** `expect(await exists(scratchHome)).toBe(false)` runs immediately after a real
child process exited in that workspace — the exact scenario
`credentials.test.ts:369-387` and `scratch-home.test.ts:102-132` both refuse to assert
unconditionally, because a just-exited child can still hold a Windows handle. The retry
loop makes it usually pass; "usually" is a flaky test on the maintainer's own platform.

**Fix:** Gate it the way `credentials.test.ts` does — assert the reported outcome, and
assert absence only when the outcome is `removed`/`already-absent`.

### IN-03: the stub snapshot id is not unique

**File:** `packages/workspace/src/stub/backend.ts:164`

**Issue:** `stub-${featureId}-${captured.size}-${Date.now()}` is documented as "stable and
unique per capture", but two snapshots of the same file count within one millisecond
collide. The contract case only asserts `id !== ''`, so the claim is untested.

**Fix:** Use a monotonic counter (or `ulid`, already in the stack) instead of the clock.

### IN-04: `isWithinRoot` is wrong for a filesystem-root `root`

**File:** `packages/workspace/src/paths.ts:72-78`

**Issue:** The comparison is `target === root || target.startsWith(root + sep)`. For
`root = '/'` (or `C:\`), `root + sep` is `'//'` and every candidate is reported outside —
containment silently rejects everything rather than failing loudly. Not reachable through
the current backends, but `isWithinRoot` is exported for out-of-tree backends.

**Fix:** Normalise with `root.endsWith(sep) ? root : root + sep` before the prefix test.

### IN-05: `WorktreeWorkspaceOptions.worker` is unreachable through the registry

**File:** `packages/workspace/src/registry.ts:111-126`, `packages/workspace/src/exec/privilege.ts:89-105`

**Issue:** `worktreeBackend.create` calls `worktreeWorkspace(spec)` with no options, and
`WorkspaceRegistryConfig` has a `hostGit` field but no `worktree` field — so the worker
identity can only ever come from `workerIdentityFromEnv()`. `privilege.ts:92-94` promises
otherwise: "A caller that passes an identity explicitly — the manager, once Phase 3 owns
configuration — overrides this entirely." Since `registry.ts` is by rule the only place a
backend factory may be named, Phase 3 cannot deliver that without editing this file.

**Fix:** Add `readonly worktree?: WorktreeWorkspaceOptions` to `WorkspaceRegistryConfig`
and thread it, mirroring `hostGit` — or delete the option and the promise.

---

_Reviewed: 2026-08-18_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
