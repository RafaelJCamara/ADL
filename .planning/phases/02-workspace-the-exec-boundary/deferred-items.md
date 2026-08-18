# Deferred items — Phase 02

Discoveries made during execution that are real, but out of scope for the plan
that found them. Each names the plan or phase that should pick it up.

## D-2-03-1: `run()` cannot distinguish "binary missing" from "command exited non-zero"

**Found during:** plan `02-03`, Task 2 (the tracer), while verifying the
`reject: false` option added to `exec/run.ts`.

**What was verified, locally, against execa 10.0.1 on Windows:**

```
execa('adl-definitely-not-a-real-binary-zzz', [], { extendEnv: false, reject: false })
  -> { exitCode: 1, failed: true, code: undefined,
       shortMessage: 'Command failed with exit code 1: adl-…' }
```

That result is byte-for-byte what a command which ran and legitimately exited 1
returns. `code` (the Node error code, e.g. `ENOENT`) is **undefined**, because
`cross-spawn` routes bare-name commands through `cmd.exe` on Windows and the
shell's own exit code is what surfaces.

**Why it matters:** `binary_missing` is a distinct `StageErrorKind` in D-12's
taxonomy, and the whole point of that taxonomy is that a gate which *broke* must
not cost the developer a round. Reporting a missing binary as `exitCode: 1` turns
"the gate broke" into "the gate failed" — the exact conflation D-12 exists to
prevent.

**Why it was not fixed in `02-03`:** the obvious guard (`exitCode === undefined
&& signal === undefined`) fires on Linux and silently does nothing on Windows.
Shipping it would have produced a control that works on the deployment target and
not on the maintainer's development machine — the same platform-split failure
mode `02-RESEARCH.md § Pitfall 7` documents. A half-working guard is worse than a
documented absence, because a reviewer reads it as the case being handled.

**What picking it up requires:** a deliberate cross-platform probe — most likely
resolving the executable against `spec.path` *before* spawning (so the answer is
known rather than inferred from the exit code), which is also what would let the
error name the PATH that was searched. Belongs with whichever plan owns the
`ExecResult` → `StageError` mapping.

**Status:** open. Not blocking — `run()` returns the exit code as data either
way, and no caller depends on the distinction yet.

## D-2-07-1: under the privilege drop, cancellation signals a process ADL does not own

**Found during:** plan `02-07`, Task 1, while wiring `exec/privilege.ts` into
`exec/run.ts`.

**What changes:** with the drop active, `spec.argv` is prefixed with
`sudo --preserve-env --non-interactive --user <worker> --`, so execa's direct
child is `sudo` — a setuid-root process that then re-execs the real command as
the worker user. Every containment control keyed on the direct child therefore
addresses the wrong process:

- `cancelSignal` (the `AbortSignal` behind budget interrupt, pause, and
  shutdown) delivers `SIGTERM` to `sudo`, which is running as root. The daemon
  user cannot signal it.
- `forceKillAfterDelay`'s `SIGKILL` five seconds later has the same problem.
- `killDescendants: true` walks the process tree from a child ADL cannot
  signal.

**Why it matters:** T-2-07 is "a leaked subtree keeps spending budget after the
round it belonged to has ended". On the *undropped* path — which is every
platform the maintainer can test on — cancellation works exactly as
`02-03` verified it. On the Linux deployment target, where the drop is the whole
point, it may not. That is the platform-split shape `§ Pitfall 7` warns about,
arriving through a different door.

**Why it was not fixed in `02-07`:** the fix is a design choice, not a flag.
The candidates are a dedicated process group the daemon can signal as a group,
a second `sudo` invocation to deliver the kill as the worker user, or moving the
launcher to `setpriv` with the daemon as the (root) parent — and each one
changes the sudoers entry the README documents, which is the thing an adopting
team has to sign off on. Choosing one from Windows, unable to observe any of
them, would be guessing.

**What picking it up requires:** a Linux runner, and the plan that owns
cancellation semantics end to end (budget interrupt is Phase 4). Measure first:
run a long child under the drop, abort, and observe whether the descendant
survives — the answer may already be "no" via the process-group behaviour execa
uses on POSIX, in which case this closes with a test rather than a change.

**Status:** open. Not blocking Phase 2 — no caller cancels an exec yet.

## D-2-06-1: the GC sweep cannot see a leaked `refs/adl-snapshots/*` ref

**Carried forward by:** plan `02-06` (which created the namespace), and
**decided** by plan `02-08` — the last plan of the phase — as *defer, with a
reproduction*. Recorded here rather than left implicit, because a reclamation
gap in a phase whose stated point is reclamation should not be discoverable only
by reading a summary's last bullet.

**What goes wrong:** `Workspace.snapshot()` anchors its `git stash create`
commit under `refs/adl-snapshots/<featureId>/<sha>` and `release()` deletes that
ref. A process that dies between the two leaves the ref behind, and
`sweepOrphans` cannot collect it: the sweep iterates
`listManagedWorktrees(mainRepo)`, and by the time anyone would want to collect
the ref, the worktree it belonged to is already gone — so there is no inventory
entry to iterate.

**Reproduction** — run against the built package, worktree backend, no
`release()` call, standing in for the crash:

```
snapshot id: 484cddb1f6379bef5c1e6e0cfba5a53786aa0679
refs after snapshot:
  refs/adl-snapshots/feat-leak/484cddb1f6379bef5c1e6e0cfba5a53786aa0679
  refs/heads/adl/feat-leak
  refs/heads/master

after destroy() — worktree and adl/* branch are gone:
worktrees: [ 'worktree …/main' ]
refs:
  refs/adl-snapshots/feat-leak/484cddb1f6379bef5c1e6e0cfba5a53786aa0679
  refs/heads/master

sweepOrphans removed: []
refs after sweep:
  refs/adl-snapshots/feat-leak/484cddb1f6379bef5c1e6e0cfba5a53786aa0679

the captured commit is still an object: commit
unreachable objects git gc would collect: (none — the ref keeps it reachable)
```

[VERIFIED: reproduced locally during plan `02-08`, git 2.49.0.windows.1]

**Why it matters more than "a stray ref":** the last two lines are the point.
The ref keeps the stash commit **reachable**, so `git gc` will never collect the
objects behind it either. The leak is not a few bytes of ref file — it is a
whole tree pinned in the object store, permanently, once per crashed snapshot.
`destroy()` is idempotent and the branch teardown is correct; this is the one
resource the two-step teardown does not name.

**Why `02-08` did not close it:** the fix is small but it is not this plan's.
`02-08` owns the configuration-neutralisation boundary; its file list, its
acceptance criteria, and its threat register say nothing about snapshot refs.
Closing it means either changing `sweepOrphans`'s return contract — an exported
signature that `02-04` and `02-06` own, whose policy/mechanism split is D-20 —
or adding a second exported sweep with its own tests to the last plan of the
phase. Both are design decisions about the GC's shape, taken in a plan whose
reviewers were asked to check something else.

**What picking it up requires**, in the shape that looks right from here: an
additive `sweepSnapshotRefs(deps: GcDeps)` beside `sweepOrphans`, leaving that
function untouched. It enumerates
`git for-each-ref --format=%(refname) refs/adl-snapshots`, takes the feature id
from the segment after the prefix, applies the *same* D-16 policy (terminal or
unknown → collect; live → leave alone, because a live feature may be holding
that handle), and deletes with `git update-ref -d`. The manager calls both from
one schedule. That belongs with **Phase 3**, which is where the sweep gains its
trigger and its state binding — the same place D-15 and D-20 already put the
rest of the GC's ownership.

**Status:** open. Not blocking — it costs disk on a daemon that has crashed
mid-snapshot, and nothing depends on the namespace being empty.

## D-2-07-2: the stub backend spends WORK-05's once-per-process banner

**Found during:** the diagnosis of the first Linux CI run (`32127511018`), while
accounting for a `[ADL][WORK-05] Privilege drop NOT applied: ADL_WORKER_USER is
not set` line in a job whose step environment plainly sets `ADL_WORKER_USER`.

**What happens:** `src/stub/backend.ts` calls
`run(execSpec, scratchHome.path, log)` — no worker identity, and the default
`'agent'` owner. On Linux that resolves to `worker-user-unset`, which is a
**true** statement about that backend: it runs agent-shaped children undropped
and never calls `applyWorkerAccess`. But `warnPrivilegeModeOnce` fires once per
process, and vitest shares one forked worker across several test files
(reproduced locally: 13 files, 5 banners). So the contract suite's stub run
prints a banner that a reader attributes to whichever file the worker happened to
be executing, and silences any later, genuinely interesting one in that process.

**Why it matters:** this is `02-08`'s `ExecOwner` problem arriving through a
second door. There, an ADL-owned `git` child resolved to `worker-user-unset` and
was fixed with `run(execSpec, home, log, {}, 'adl')`. The reason that fix does
**not** transfer is that `'adl'` would be a lie here: a stub workspace handed a
real feature is running an agent's children undropped, and T-2-32 says that is
precisely what an operator must hear about. The banner is not spurious — its
*scope* is.

**Why it was not fixed now:** the two candidate fixes are both design decisions
that cannot be observed from Windows. Giving the stub a worker identity would
hand it a `sudo` prefix with no `applyWorkerAccess` behind it — a half-configured
drop, and a new way for the contract suite to go red on Linux only. Adding a
third `ExecOwner` member for "a backend that carries no worker identity by
construction" is a change to a type `02-08` has just settled, made in a fix whose
reviewers were asked to look at something else.

**What picking it up requires:** the plan that owns backend *selection* — where
"may this backend serve a real feature?" is answered — plus a Linux runner to
observe the contract suite under a real drop. Until then the mitigation is
documentary: `02-07-SUMMARY.md`'s addendum tells the checkpoint reader that this
banner is expected and that the drop evidence is `privilege.test.ts` passing 8/8
with zero `[ADL][SKIPPED]` lines.

**Status:** open. Not blocking — it is a log-clarity and evidence-attribution
problem, not a containment one. No production deployment runs the stub backend.

## D-2-08-1: under the privilege drop, the agent cannot run `git` in its own worktree

**Found during:** the diagnosis of the Linux CI run `32149311523`, while
accounting for eleven `expected 128 to be +0` failures in
`test/git/poisoned-config.test.ts`.

**What happens:** with WORK-05's drop in force the child runs as `adl-worker`
while the repository and its worktree are owned by the daemon user. Git's
`safe.directory` check refuses on that mismatch before it consults a single
permission bit, so **every** git command an agent runs inside its workspace
dies. Reproduced on Linux (git 2.43): `git config <key> <value>` in a worktree
exits **128** with `fatal: not in a git directory`, and `git status` exits 128
with `fatal: detected dubious ownership in repository at '…'`.

**Why it matters:** this is not a fixture artifact. A real installation is laid
out exactly this way — that is the whole point of D-06's pre-provisioned worker
— and an agent that cannot `git status`, `git add`, or `git commit` cannot do
the job ADL exists to give it. It has been invisible so far only because
`poisoned-config.test.ts` is the sole place a *repository* git command runs
through a dropped exec; `credentials.test.ts` runs `git --version`, which needs
no repository and therefore passes.

**The shape of the fix:** the worker's `GIT_CONFIG_GLOBAL` already points inside
the scratch home that `buildChildEnv` owns, so a `safe.directory` entry naming
the worktree and the main repository can be written there by the worktree
backend at creation time — per-run, disposable with the directory, and reaching
no configuration the operator owns. Note it must name specific paths: a blanket
`safe.directory=*` in a file an agent can rewrite is not a fix.

**Why it was not fixed now:** it is a security-relevant design decision — which
paths are declared trusted, written by whom, and whether the agent's ability to
rewrite its own `GIT_CONFIG_GLOBAL` undermines it — and it belongs in a plan
rather than in a test fix whose reviewers were asked to look at something else.
It is also not needed to make the suite green: `poisoned-config.test.ts` now
asserts the refusal rather than depending on the write succeeding.

**What it does NOT weaken:** layer 2 is unaffected. `applyWorkerAccess` still
takes group and world write off `<mainRepo>/.git/config` and still never grants
the worker write on `.git`, so with ownership resolved the agent's config write
becomes the **255** `could not lock config file … Permission denied` refusal
instead of the 128 one. Both are refusals, and `poisoned-config.test.ts`
deliberately asserts `not.toBe(0)` rather than a specific code so that this fix
does not turn into a spurious failure there.

**Status:** open, and the most consequential item on this list — it blocks the
developer stage having a usable worktree on any correctly-provisioned Linux
deployment. Belongs to the phase that first has an agent write code.
