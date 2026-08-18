---
phase: 02-workspace-the-exec-boundary
plan: 07
subsystem: workspace
tags: [privilege-drop, os-isolation, ci, work-05, d-05, d-18, d-21]
status: awaiting-checkpoint
requires:
  - '02-05: the credential boundary and the scratch HOME this drop widens for the worker'
  - '02-06: the named registry, which reaches worktreeWorkspace unchanged'
provides:
  - 'privilegeLauncher / PrivilegeMode / privilegeWarning / applyWorkerAccess — the OS-gated drop and its honest degraded mode'
  - 'linuxOnly(reason) — the visible-skip helper that makes a skip loud and a misconfiguration fatal'
  - 'ADL_WORKER_USER / ADL_WORKER_GROUP — the daemon-side worker identity'
  - 'packages/workspace/README.md — the D-06 install story, sudoers rule stated at the top'
  - 'CI provisioning of adl-worker, which turns the Linux-only skip into an execution'
affects:
  - 'packages/workspace/src/exec/run.ts — argv is now prefixed by the launcher'
  - 'packages/workspace/src/worktree/backend.ts — gains an options parameter and applies worker access'
  - '.github/workflows/ci.yml — one job, extended'
tech-stack:
  added: []
  patterns:
    - 'External launcher over process-level identity change: the drop is an argv prefix, so the daemon never needs root (D-06, D-18).'
    - 'Empty-prefix-on-no-op: every non-dropped mode returns an empty argv prefix, so the call site has no branch and the two paths cannot drift.'
    - 'Warner-as-factory: once-per-process state lives in a closure and the factory is exported, so tests never need a reset hatch that production could reach.'
    - 'Loud skip: a platform-gated test writes its reason to stderr with the requirement id, and a misconfigured runner throws rather than skipping.'
key-files:
  created:
    - packages/workspace/src/exec/privilege.ts
    - packages/workspace/test/exec/privilege.test.ts
    - packages/workspace/test/helpers/platform.ts
    - packages/workspace/README.md
  modified:
    - packages/workspace/src/exec/run.ts
    - packages/workspace/src/exec/scratch-home.ts
    - packages/workspace/src/worktree/backend.ts
    - packages/workspace/src/index.ts
    - packages/workspace/package.json
    - packages/workspace/test/helpers/temp-repo.ts
    - .github/workflows/ci.yml
    - .planning/phases/02-workspace-the-exec-boundary/deferred-items.md
decisions:
  - 'PrivilegeMode has four members, not three: worker-user-unset is split from launcher-missing because T-2-32 names three distinct causes and the warning has to tell the operator which one to fix.'
  - 'The launcher prefix carries --preserve-env and --non-interactive, and the sudoers rule therefore carries the SETENV tag and !secure_path. Without them sudo would discard the zero-inherit environment and override ExecSpec.path.'
  - 'applyWorkerAccess actively removes group and world write from .git/config rather than merely not granting it, so a repository created under a permissive umask is still protected.'
  - 'The CI Test step runs under `sg adl-worker`. usermod does not update an already-running process supplementary groups, and chown(2) refuses a group the caller is not in.'
metrics:
  duration: ~75 minutes
  completed: 2026-08-18
actuals:
  tokens: 19000
  tasks: 3
  commits: 3
---

# Phase 02 Plan 07: The Privilege Drop Summary

The worker now has a real OS identity on Linux — children are launched through
`sudo -u` behind a single OS-gated seam that relinquishes supplementary groups
properly, can write their scratch `HOME` and their own worktree, and cannot write
the main repository's `.git/config`; everywhere else the absence of that
guarantee is stated once per process and documented at the top of a shipped
README.

**Status: awaiting the Task 4 checkpoint.** Tasks 1–3 are complete and committed.
Task 4 is a human reading the first green Linux CI run and confirming the
privilege cases ran rather than skipped. It cannot be satisfied from this
machine, and nothing here should be read as evidence that it has been.

## What was built

### Task 1 — `exec/privilege.ts` (commit `859b3c7`)

`privilegeLauncher(config)` gates on the platform first and returns a mode plus
an argv prefix. On Linux with a configured worker user it resolves `sudo` against
the **child's** `PATH` — `ExecSpec.path`, not the daemon's, because under
`extendEnv: false` execa resolves the executable it is handed from `env.PATH`
(§ Pitfall 7) and the launcher is now that executable. The prefix is
`sudo --preserve-env --non-interactive --user <worker> --`.

`privilegeWarning(mode)` returns a four-line banner naming, concretely: that
children run with the daemon's own OS identity, that `.git/config` is therefore
writable by anything the agent runs and git config names programs git executes,
and that the README's guarantees are Linux-only. `createPrivilegeWarner(sink)`
wraps it in once-per-process state.

`applyWorkerAccess(paths, config)` chgrps and widens the scratch `HOME`, the
worktree, and the per-worktree git administrative directory to the shared group
(group rwx, no world bit ever set), and takes group and world **write** off
`<mainRepo>/.git/config`. It is a no-op when the mode is not `dropped`, and it
returns a discriminated union whose `degraded` variant names its reason rather
than throwing or swallowing.

`run()` prefixes `spec.argv` and warns once. `worktreeWorkspace(spec, options?)`
gained an options parameter whose `worker` defaults to `ADL_WORKER_USER` /
`ADL_WORKER_GROUP` from the daemon's own environment — two non-secret names,
read in exactly one place. `registry.ts` was not touched: it calls
`worktreeWorkspace(spec)` and gets the env default, so the sole-construction-site
guard from `02-06` is untouched.

### Task 2 — the loud skip (commit `0c6779a`)

`linuxOnly(reason)` returns `{ kind: 'run' | 'skip' }` and **throws** on Linux
with the worker user unset. The asymmetry is deliberate: a returned
`misconfigured` variant is a case a test author can forget to handle, and
forgetting it produces exactly the silent pass D-21 exists to prevent.

`test/exec/privilege.test.ts` covers, on every platform, the OS gate with an
injected platform (so it is not vacuous on Linux either), the two distinct
non-dropped causes, the exact launcher prefix, the warning text and its
once-ness, `applyWorkerAccess`'s no-op asserted as unchanged mode bits, and a
real child running successfully whatever the mode. Gated to Linux: the child's
uid and gid against `/etc/passwd`, the **supplementary group list** against the
daemon's own, and the three write probes.

The T-2-30 assertion is a group-list comparison and additionally asserts that the
daemon carries at least one group the worker lacks — otherwise the comparison
would pass while proving nothing, which is the failure mode this whole plan is
about.

### Task 3 — CI and the install story (commit `4d9aaea`)

The existing `verify` job was extended, not duplicated: one `jobs:` key, one job,
both matrix legs, every pre-existing step present. A provisioning step between
Install and Test creates the group and the no-login, no-home `adl-worker` system
user, adds the runner to the shared group, and installs a `visudo`-validated
drop-in granting `NOPASSWD:SETENV:` for that **one** run-as user (T-2-34), plus
`Defaults>adl-worker !secure_path`. It prints `getent passwd`, `getent group` and
`sudo -u adl-worker -- id` so the checkpoint reader sees the identity rather than
inferring it from a green tick.

`packages/workspace/README.md` leads with a pointer to the sudoers section,
states the rule with a "what it grants / what it does not grant" pair and an
honest summary of the residual exposure, documents the `setpriv` alternative
together with the fact that it requires a root caller, gives the permission-model
table, and says plainly what is not enforced on Windows and macOS. It is in the
package's `files` field, so it ships.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 2 — missing critical functionality] `PrivilegeMode` has four members, not three**

- **Found during:** Task 1, drafting the warning text.
- **Issue:** the plan enumerated `dropped`, `unsupported-platform`,
  `launcher-missing`. T-2-32 names three *causes* of a silent non-drop — wrong
  platform, missing launcher, **unset user** — and the value of the banner is
  that it tells an operator which one to fix. Reporting an unset
  `ADL_WORKER_USER` as `launcher-missing` sends them to install a package they
  already have.
- **Fix:** added `worker-user-unset`, with the reasoning in the type's docblock.
- **Files:** `packages/workspace/src/exec/privilege.ts`. **Commit:** `859b3c7`.

**2. [Rule 2 — missing critical functionality] `.git/config` write bits are cleared, not merely not granted**

- **Found during:** Task 1.
- **Issue:** the plan says the config file "stays … group-readable but not
  group-writable". A repository created under a permissive umask arrives already
  group-writable, and "ADL did not widen it" would then be true while the worker
  could still write it — T-2-31 unmitigated, silently.
- **Fix:** `applyWorkerAccess` takes a `protect` list and clears `0o022` from
  each entry. It never adds a bit.
- **Files:** `packages/workspace/src/exec/privilege.ts`,
  `packages/workspace/src/worktree/backend.ts`. **Commit:** `859b3c7`.

**3. [Rule 3 — blocking issue] the CI `Test` step runs under `sg adl-worker`**

- **Found during:** Task 3.
- **Issue:** the plan's acceptance criteria say the pre-existing steps are
  "unmodified apart from the inserted provisioning step". They cannot be.
  `usermod --append --groups` updates the group database, but supplementary group
  membership is established when process credentials are created — the runner
  process that forks each step was created before the provisioning ran and does
  not pick the new group up. `chown(2)` refuses to set a group the caller is not
  a member of, so `applyWorkerAccess` would degrade with `EPERM` on every run and
  the worker could not write its own scratch `HOME`.
- **Fix:** `run: sg adl-worker -c "pnpm -r test"`. The command itself is
  unchanged; only the credentials it runs under are, and the step carries a
  comment saying exactly that. `pnpm vitest run --project root` was left
  genuinely untouched — it has no privilege cases.
- **Alternatives rejected:** using an existing group the runner is already in
  (on GitHub runners the runner user's primary group is `docker`, and putting the
  worker in it would make the "unprivileged" claim a lie); granting the daemon
  broader sudo to `chgrp` (a bigger sudoers rule to avoid a smaller change).
- **Files:** `.github/workflows/ci.yml`. **Commit:** `4d9aaea`.

**4. [Rule 3 — blocking issue] the temp-repo fixture root is `0711` on POSIX**

- **Found during:** Task 2.
- **Issue:** `mkdtemp` creates its root `0700`. With the drop active the worker is
  a different OS user and cannot traverse into the fixture, so every exec-based
  case in the package — not only the new ones — would fail for a reason unrelated
  to the code under test.
- **Fix:** `chmod(dir, 0o711)` in `openTempRepo`, skipped on Windows. Traverse
  without list, and only in the fixture: a real deployment's repository and
  scratch root are ordinary `0755` directories and need nothing done to them.
  The README states that traversal prerequisite explicitly.
- **Files:** `packages/workspace/test/helpers/temp-repo.ts`. **Commit:** `0c6779a`.

**5. [Rule 3, deferred rather than fixed] cancellation signals a process ADL does not own under the drop**

- **Found during:** Task 1, wiring the prefix into `run()`.
- **Issue:** execa's direct child is now `sudo`, running as root. `cancelSignal`,
  `forceKillAfterDelay` and `killDescendants` all address it, and the daemon user
  cannot signal it. On the undropped path — every platform this machine can test
  — cancellation behaves exactly as `02-03` verified.
- **Why not fixed:** the fix is a design choice (process group vs. a kill routed
  back through the launcher vs. moving to `setpriv`), each of which changes the
  sudoers rule an adopting team has to sign off on. Choosing one from Windows,
  unable to observe any of them, would be guessing.
- **Recorded as:** `D-2-07-1` in `deferred-items.md`, with a `killDescendants`
  comment in `run.ts` pointing at it. Not blocking — no caller cancels an exec yet.

### Not deviations, but worth stating

- `registry.ts` was deliberately **not** modified. The worker identity reaches
  the backend through a defaulted second parameter, so the registry still names
  `worktreeWorkspace` in exactly one place and `02-06`'s sole-site guard is
  untouched.
- `scratch-home.ts` gained a cross-reference paragraph only. Its mode is widened
  by `applyWorkerAccess` after the backend has created both the worktree and the
  home; putting the chmod inside `createScratchHome` would have given that module
  an opinion about OS identity and made it behave differently per platform.

## Verification

Run on the Windows development machine, all exit 0:

| Check | Result |
| --- | --- |
| `pnpm vitest run --project workspace` (via `pnpm test`) | 11 files, 106 passed, **2 skipped** |
| `pnpm -r test` | core 404, plugin-sdk 10, db 43, workspace 106 — all pass |
| `pnpm vitest run --project root` | 2 files, 30 passed (eslint-config regression intact) |
| `pnpm -r typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm format` | pass |
| Task 3's `<automated>` node check | `OK` |

The skip reasons appear in the output as required by D-21:

```
[ADL][SKIPPED][WORK-05] the launcher-based privilege drop is Linux-only in v1 (D-05), so a child cannot report a worker uid here (platform: win32)
[ADL][SKIPPED][WORK-05] the worker user only exists where the privilege drop applies (D-05), so there is no second identity to deny here (platform: win32)
```

And the degraded-mode banner, once per worker process:

```
[ADL][WORK-05] Privilege drop NOT applied: this platform is win32, and the launcher-based drop is Linux-only in v1 (D-05).
[ADL][WORK-05] Children of this workspace run with the daemon's OWN OS identity — not a dedicated unprivileged worker user.
[ADL][WORK-05] The main repository's .git/config is therefore writable by anything the agent can run, and git config names programs git executes (core.hooksPath, core.pager, *.sshCommand) during ADL's own operations.
[ADL][WORK-05] The OS-level isolation described in packages/workspace/README.md applies to Linux deployments only.
```

## What has NOT been verified — read this before signing anything off

Everything below is Linux-only and has never executed. The plan asked for the
sudo-versus-zero-inherit-environment interaction to be "verified empirically on
the Linux CI run rather than assuming it" — it has not been, and this section is
that record kept honestly rather than closed prematurely.

| Unverified | Why it could go wrong | Where it shows up |
| --- | --- | --- |
| `sudo --preserve-env` actually delivers `buildChildEnv`'s output to the child | `SETENV` is granted by the drop-in, but the interaction with the runner's pre-existing `NOPASSWD:ALL` rule and rule-ordering in `/etc/sudoers.d` is unobserved | the tracer test asserts `HOME:` equals the scratch home; it would fail |
| `Defaults>adl-worker !secure_path` prevents `PATH` being overridden | Ubuntu sets `secure_path` in the main sudoers file; the drop-in should win by load order, but that is inference | `/bin/sh -c 'id …'` probes; bare-name resolution inside the child |
| `sg adl-worker -c "pnpm -r test"` preserves the corepack `PATH` and the group list | `sg` re-execs through the user's shell | every workspace test would fail, loudly |
| The daemon carries a supplementary group `adl-worker` lacks | the T-2-30 assertion asserts this explicitly rather than tolerating a vacuous pass, so a runner where it is false goes **red** | the identity case |
| Existing exec-based tests (tracer, credentials, contract) still pass **with the drop active** | they were written against the undropped path; the fixture chmod is the fix I could reason about, but not observe | `pnpm -r test` on either matrix leg |

Any of these failing is a normal, expected outcome of a first Linux run and is
what the Task 4 checkpoint exists to surface. **A green run is the evidence;
this document is not.**

## Known stubs

None. Nothing was stubbed, and no test was skipped other than the two
platform-gated cases, which skip by design with a stated reason and are the
subject of the checkpoint.

## Threat flags

None. No new network endpoint, auth path, or schema at a trust boundary was
introduced. The plan's own threat register (T-2-29 … T-2-35) is addressed by the
work above, with the caveat that T-2-29, T-2-30, T-2-31 and T-2-33 are mitigated
by code whose evidence is Linux-only and not yet produced.

## Self-Check: PASSED

Files claimed as created, all present on disk:

- `packages/workspace/src/exec/privilege.ts`
- `packages/workspace/test/exec/privilege.test.ts`
- `packages/workspace/test/helpers/platform.ts`
- `packages/workspace/README.md`

Commits claimed, all present in `git log`: `859b3c7`, `0c6779a`, `4d9aaea`.

---

# ADDENDUM — first Linux CI run (`32127511018`), diagnosis and fix

**Added after the first CI run, which was RED on both matrix legs. The Task 4
checkpoint is still OPEN — `status` stays `awaiting-checkpoint`. Nothing in this
addendum is evidence that the gate is satisfied; only a human reading a green
Linux run may close it.**

## What the red run actually produced

Read carefully, because most of it is the evidence the plan was after:

| Observation | Reading |
| --- | --- |
| `test/exec/privilege.test.ts` — **8/8 passing on both legs** | WORK-05's Linux-only assertions **executed**. The uid, the gid, the supplementary-group comparison (T-2-30) and the three write probes all ran against a real `adl-worker` child. |
| **Zero `[ADL][SKIPPED]` lines** anywhere in the Linux log | Nothing declined to run. D-21's asymmetry held: the cases that skip on Windows executed here. |
| The tracer test passed, `HOME:` and all | `sudo --preserve-env` **does** deliver `buildChildEnv`'s zero-inherit environment to the child. Unverified row 1 is now verified. |
| `/bin/sh -c 'id …'` probes and bare-name `git` / `npm` resolved inside dropped children | `Defaults>adl-worker !secure_path` and the corepack `PATH` through `sg` both held. Unverified rows 2 and 3 are now verified. |
| The T-2-30 vacuity guard did not trip | The runner's user does carry a supplementary group `adl-worker` lacks. Unverified row 4 is now verified. |
| Two cases in `test/exec/credentials.test.ts` failed on both legs | Unverified row 5 — "existing exec-based tests still pass with the drop active" — is the one that was false, and it was false in one narrow, specific way. |

Both failures were the same assertion at the same line, inside `dumpChildEnv`:
`expect(result.exitCode).toBe(0)` received `1`.

## Root cause

**The dropped child could not read its own program.**

Under WORK-05 the child runs as `adl-worker`, and the only places that identity
can reach are the system directories, the workspace's scratch `HOME`, and the
feature worktree — the three trees `applyWorkerAccess` widens to the shared
group. **ADL's own checkout is deliberately not among them, and that is the
property working, not failing.** On a GitHub-hosted runner the checkout sits
under `/home/runner`, which is not world-traversable, so `adl-worker` cannot
open a file inside it at all.

`dumpChildEnv` launched `[process.execPath, <repo>/test/helpers/env-dump-child.cjs]`.
The interpreter resolved (the tool cache is world-accessible); the **program
file** did not. Node exited 1 before running a line, and the helper's assertion
saw `1`.

Note it is the *program path* that was unreachable, not the working directory:
the cwd is established by the parent — which is the daemon user and can traverse
the fixture — and survives the `setuid`, so `cwd` was never the problem. The
`0711` chmod added to `openTempRepo` in Task 2 (deviation 4 above) was the right
fix for the cwd half; this is the other half, and it lives outside the fixture.

**Why exactly these two cases and nothing else.** They are the only cases in the
package that ask a workspace child to execute a file **from the repository
checkout**. Everything else runs either a `node -e` string (`tracer.test.ts`,
`privilege.test.ts`, `helpers/contract.ts`) or a system binary (`git`, `npm`,
`/bin/sh`). The third case in `credentials.test.ts` — the git/npm neutraliser
one — passed on Linux for that reason, which is also the positive control: it
proves a dropped child can write and read back inside its scratch `HOME`, which
is precisely where the fix puts the program.

## The apparent contradiction, resolved: the `ADL_WORKER_USER is not set` banner

The Linux log contains

```
[ADL][WORK-05] Privilege drop NOT applied: ADL_WORKER_USER is not set, so there is no pre-provisioned worker identity to drop to (D-06).
```

while the step environment plainly sets `ADL_WORKER_USER: adl-worker`, and while
`privilege.test.ts` passed — which, per T-2-33, means the variable *was* visible
there. That looked like the same variable being visible to one vitest worker and
invisible to another. It is not, and no environment variable went missing.

The banner is a **true statement about a different backend**. `src/stub/backend.ts`
— the second peer backend from `02-06`, the one that makes success criterion 3
provable — calls `run(execSpec, scratchHome.path, log)` with **no worker
identity and the default `'agent'` owner**. On Linux that resolves to
`worker-user-unset`, which is correct: the stub genuinely runs agent-shaped
children undropped, and it never calls `applyWorkerAccess`. The contract suite
(`test/contract/workspace-contract.test.ts`) runs `describeWorkspaceContract`
twice, once per registered backend, so the stub executes on every run.

Two further facts make the attribution in the log misleading rather than wrong:

1. `warnPrivilegeModeOnce` fires **once per process**, so the first
   non-dropping workspace in a worker silences every later one.
2. Vitest shares one forked worker across several test files. Reproduced on this
   machine after the fix: 13 test files produced **5** banners, not 13 — so a
   banner raised while the contract file was running appears in the same
   worker's stderr as the tracer / worktree-list / credentials files.

This is the same failure mode `02-08` closed for ADL's own git with `ExecOwner`
(`run(execSpec, home, log, {}, 'adl')`), arriving through a second door. The
difference is that `'adl'` would be a lie here: a stub workspace handed a real
feature would be running an agent's children undropped, and that is exactly what
the operator must hear about. **So the banner has been left alone.** Suppressing
it would trade a confusing log line for a genuine T-2-32 hole, and making the
stub drop instead would give it a `sudo` prefix with no `applyWorkerAccess`
behind it — a half-configured state I cannot observe from Windows. Recorded in
`deferred-items.md` as a design question for the plan that owns backend
selection, not patched blind here.

**For whoever reads the next run: this banner is expected, and it is not evidence
that the worktree backend failed to drop.** The evidence that the drop happened
is `privilege.test.ts` passing 8/8 with zero `[ADL][SKIPPED]` lines.

## What changed (commit `f7dd0c4`)

`packages/workspace/test/exec/credentials.test.ts`

- New `stageEnvDumpChild(workspace)`: copies `helpers/env-dump-child.cjs` **byte
  for byte** into the workspace's own scratch `HOME` and returns that path, which
  is what the child is now launched with. The destination is `0770` and
  group-owned by the worker on Linux, sits under a world-traversable `/tmp`, and
  is removed by `destroy()` — so nothing outlives the workspace. It is also the
  more faithful arrangement: in production an agent's child only ever executes
  something inside its worktree, inside its scratch `HOME`, or on the system.
- The staged file's mode is set explicitly (`0644`, skipped on Windows) rather
  than inherited from the copy or the umask, so a runner with a restrictive
  umask cannot reintroduce the same failure with a different cause. `0644` is
  safe because the containing directory is what confines it — `0770`, no world
  bit, per T-2-35.
- `expect(result.exitCode, output).toBe(0)` now carries the child's own output as
  the failure message, matching `privilege.test.ts`. A bare `expected 1 to be +0`
  from inside a helper cost this plan a full CI round trip; the launcher's or
  node's own complaint names the cause on the first read. It renders only when
  the child exited non-zero — that is, when it never reached its single write —
  so a leaked credential is still reported by the assertions, not printed here.

`packages/workspace/test/helpers/env-dump-child.cjs`

- Docblock note: do not hand this path to a workspace child directly, and why.

**No assertion was changed, added, relaxed, or skipped.** The credential
patterns, the two sentinel values, the both-sides scoping proof and the
non-emptiness check are all byte-identical. The instrument is still a real `.cjs`
file executed by a real child process, which is the entire reason it exists
rather than a `node -e` string.

## Local gates after the fix (Windows, all exit 0)

| Check | Result |
| --- | --- |
| `pnpm -r test` | core 404, plugin-sdk 10, db 43, workspace **129 passed / 2 skipped (131)** |
| `pnpm vitest run --project root` | 2 files, 30 passed |
| `pnpm -r typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm format` | pass |

The two skips are still the two platform-gated privilege cases, still writing
their `[ADL][SKIPPED][WORK-05]` reasons to stderr. The workspace count is 131
rather than the 108 of the red run because `02-08` landed in between.

## Still UNVERIFIED until the next Linux run

| Unverified | Why it could still go wrong |
| --- | --- |
| That the checkout being unreadable to `adl-worker` was the mechanism | Argued from a perfect correlation — the two failing cases are the only two that execute a file from the checkout — and from `/home/runner` not being world-traversable on GitHub-hosted images. It was **not** reproduced: this machine is Windows and has no second OS identity. If the real cause is something else about `sudo`, the fix is a no-op and the same two cases fail again — but now with the child's own error text attached, which names it on the first read. |
| That the scratch `HOME` is readable by the dropped child | Strongly indicated rather than assumed: the third credentials case already **passed** on Linux, and `privilege.test.ts`'s `echo probe > "$HOME/worker-probe"` exited 0 — the worker can write there, so it can certainly traverse and read there. Still, that is evidence from a neighbouring case, not from this one. |
| Everything the red run already established | Rows 1–4 of the original table are now verified by that run. They are listed above as verified and are **not** re-opened here. |
| Whether the stub backend should carry a worker identity | Deliberately not changed. See the banner section; deferred rather than guessed at from a platform that cannot observe it. |

**A green run is the evidence; this document is not.**
