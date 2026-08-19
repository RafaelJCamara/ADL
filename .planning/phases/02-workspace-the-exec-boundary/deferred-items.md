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

## D-2-R-1: one worker identity for every feature, so features are not isolated from each other

> **DISPOSITION — ACCEPTED FOR v1, MUST BE REVISITED.**
> Decided by the maintainer at the Phase 02 UAT gate on 2026-08-19 (`02-UAT.md`
> test 1). Accepted so v1 can ship; explicitly **not** closed and **not**
> withdrawn as a risk.
>
> **What was accepted:** ADL v1 runs one trust domain per daemon. Concurrent
> features are isolated from the host but not from each other, so feature A's
> agent can rewrite feature B's source after B's reviewer stage passed and
> before its PR opens.
>
> **Why accepting is defensible for v1:** WORK-05's wording is satisfied (a
> dedicated unprivileged user, singular per deployment, with a per-run scratch
> home). Human approval is mandatory before merge, so a cross-feature tamper
> still faces a human reading the PR. Group and mode bits cannot separate two
> processes sharing a uid, so the alternative is not a smaller fix — it is a uid
> pool plus manager-owned lease state that does not exist until Phase 3.
>
> **Revisit triggers — any ONE of these makes this blocking again:**
> 1. **Phase 3** introduces manager-owned lease state. That is the first point
>    at which a uid pool is buildable, and the natural home for the fix.
> 2. ADL is run with **concurrency > 1** on a shared or multi-tenant host.
>    Single-feature-at-a-time deployments do not hit this.
> 3. The **human approval gate before merge is ever relaxed or automated** — that
>    gate is the only remaining control standing between this and a tampered PR.
> 4. Before any **public/multi-tenant** deployment of ADL is advertised.
>
> **Still outstanding:** the reproduction below is marked
> `[NOT YET REPRODUCED ON A LINUX HOST]` — it is argued from the code, not run.
> `02-UAT.md` test 2 was SKIPPED at the UAT gate because it cannot run from a
> Windows development machine. The maintainer's direction was that it must be
> run on Linux eventually, and it is tracked as an open todo:
> `.planning/todos/pending/reproduce-d-2-r-1-on-linux.md` (no `resolves_phase:`,
> so no phase completion can auto-close it).
>
> Until it runs, the v1 acceptance above rests on an ARGUED rather than a
> DEMONSTRATED severity. If the reproduction does not behave as reasoned, the
> acceptance was made against a wrong model and must be re-decided.
>
> **Proposed shape when revisited:** a pool of distinct uids leased per feature,
> one sudoers entry per pool member, lease state owned by the Phase 3 manager.

**Found by:** `02-REVIEW.md` § CR-03 (critical). **Partially narrowed** by the
02 review-fix pass; the residual — which is the substantive half — is recorded
here rather than closed, and the reasoning for that is below.

**What is true today.** `WorkerIdentity` is per *deployment* by construction —
`worktree/backend.ts:66-73` says so outright: "a spec is per feature and an OS
identity is per deployment". Every feature therefore calls
`applyWorkerAccess([scratchHome, worktreePath, adminDir], { group: adl-worker })`
and every one of those grants goes to the **same** group, whose only member that
matters is the **same** uid. With features A and B running concurrently — the
normal case, per `errors.ts:9-12` — A's agent can:

- read and rewrite `<scratchRoot>/B/**`: the source ADL is about to review, test,
  and open a pull request for, **after B's reviewer stage has already passed**;
- read and write `<mainRepo>/.git/worktrees/B/**`, including B's index and `HEAD`;
- enter B's scratch `HOME` and read a `.gitconfig` credential helper, an `.npmrc`
  token, or an agent CLI's session file left there.

D-22 records the feature spec as untrusted input written by anyone who can push.
So this is a supply-chain path from a hostile spec into a human-approved PR, and
it is the one thing the phase's isolation model exists to stop.

**Reproduction** (Linux, worker provisioned; no ADL code required — the shell
stands in for feature A's agent, which runs as exactly this identity):

```sh
# Two features, created by the daemon in the ordinary way.
#   /srv/adl/scratch/feat-a   (worktree, group adl-worker, group rwx)
#   /srv/adl/scratch/feat-b   (worktree, group adl-worker, group rwx)

# Now act as feature A's agent — the identity every agent runs as.
sudo --preserve-env --non-interactive --user adl-worker -- \
  sh -c 'echo "// planted by A after B was reviewed" >> /srv/adl/scratch/feat-b/src/index.ts'
echo $?          # 0 — the write succeeds
```

`stat -c '%U %G %a' /srv/adl/scratch/feat-b` reports `adl adl-worker 770`, which
is the grant working exactly as designed, for an identity that is not one
feature's.

[NOT YET REPRODUCED ON A LINUX HOST — derived from the code and the mode bits
`grantGroupAccess` sets (`0o070` on directories, `0o060` on files) plus the
single `worker.group` the backend passes. The maintainer's machine is Windows,
where the drop does not apply at all. Run it on the CI runner before treating the
exploit as confirmed; run it before treating it as refuted, too.]

**What the fix pass DID narrow** (see `02-07-SUMMARY.md` § review-fix addendum):

- Scratch homes moved from directly under a world-readable `/tmp` into
  `<tmp>/adl-homes`, a daemon-owned `0700` root that `applyWorkerAccess` gives
  the worker group `--x` and nothing else. Reaching a sibling feature's `HOME`
  now requires guessing a `mkdtemp` name instead of reading `ls /tmp`, which
  restores the property `scratch-home.ts:9-16` claims for itself.
- `README.md` § Permission model gained a row and a section stating plainly that
  every concurrently running feature shares one OS identity and can reach the
  others' worktrees, and the "what is enforced on Linux" list no longer reads as
  though the grant were per-feature.
- `WorkerIdentity`'s docblock says the same thing at the definition, so the next
  reader of the code does not have to find the README first.

**What is NOT narrowed, and why it cannot be here.** Worktree paths are
`<scratchRoot>/<featureId>` — predictable by design, and their parent is the
operator's scratch root, so the unlistable-parent trick does not transfer.
More fundamentally: **group permissions cannot separate two processes running as
the same uid.** Every concurrent feature drops to one `adl-worker`, so no
arrangement of groups or modes produces per-feature isolation. The fix is a
different *identity* per concurrent feature, not different bits.

**What picking it up requires**, in the shape that looks right from here:

```ts
export interface WorkerIdentity {
  readonly user?: string;   // adl-worker-<n>, allocated from a pre-provisioned pool
  readonly group?: string;  // the pool member's own group
}
```

- a pool of `adl-worker-0 … adl-worker-<N-1>` users, each with its own group,
  sized to the manager's concurrency limit;
- an allocator that leases a pool member to a workspace for its lifetime and
  returns it at `destroy()` — which is manager-owned state, so it belongs
  wherever the concurrency limit is enforced;
- a sudoers entry per pool member (`adl ALL=(adl-worker-0) NOPASSWD:SETENV: ALL`,
  …), which is a change to the thing an adopting team signs off on — the reason
  this is not a quiet refactor;
- `applyWorkerAccess` granting the *leased* group rather than a deployment-wide
  one, which is a one-word change once the identity is right;
- a test that stands up two workspaces and asserts A's child **cannot** write
  B's worktree — the direct negation of the reproduction above. Without it the
  fix has no regression guard, and this is exactly the kind of control that
  passes for the wrong reason.

**Why the fix pass did not close it:** it is a provisioning and concurrency
design that changes the operator's install story (N sudoers entries, N users, a
documented pool size) and needs manager-owned lease state that does not exist
until Phase 3. Choosing the pool's shape from a Windows machine, unable to run
the drop at all, would be guessing at the one thing that has to be right.

**Status:** open, and the highest-severity item on this list. Not blocking a
single-feature deployment or a deployment whose specs all come from one trust
domain — which the README now says in as many words. Belongs to the phase that
owns concurrency limits and worker provisioning (Phase 3).

## D-2-R-2: the creation-time and run-time privilege decisions are still not reconciled

**Found by:** `02-REVIEW.md` § WR-10. **Detector shipped, wiring deferred.**

**What goes wrong:** the privilege mode is decided twice against two different
PATHs, deliberately — `worktree/backend.ts:110-143` resolves it against the
daemon's PATH to answer "does the worker need access to these directories?", and
`exec/run.ts:91-96` resolves it against `ExecSpec.path` to answer "can execa
resolve the launcher from *this child's* environment?". The reasoning is sound
and the reviewer agrees with it. What is missing is what happens when the two
answers differ:

- creation says `dropped` → `applyWorkerAccess` widens the worktree, the admin
  directory and the scratch `HOME` to the shared group; a later `exec` whose
  `spec.path` has no `sudo` resolves `launcher-missing` and runs **as the
  daemon**, leaving those directories group-writable with no beneficiary — the
  exact condition `applyWorkerAccess`'s `mode !== 'dropped'` early return exists
  to avoid. Note the exposure is bounded by D-2-R-1: the group that can reach
  them is ADL's own worker group, not the world.
- the reverse hands the worker a `sudo` prefix with no grant behind it, and every
  command fails to write its own worktree with a permission error that reads like
  an agent bug.

**What shipped:** `privilegeModeMismatch(creation, runtime)` in
`exec/privilege.ts` — a pure function that returns a distinct banner naming both
modes, both PATHs, and which direction the mismatch runs in, or `undefined` when
the two agree. It is tested, and `PrivilegeDecision` now carries the `path` it
was decided against so a caller has both halves without re-deriving anything.

**What is NOT wired:** nothing calls it. The two call sites are
`worktree/backend.ts` (which must keep its `PrivilegeDecision` past creation) and
`exec/run.ts` (which must compare against it), and both were owned by a
concurrent agent during the fix pass — see `02-07-SUMMARY.md` § review-fix
addendum § carry-forward for the exact two-line change.

**Why it was not done with module-level state instead:** `privilegeLauncher` and
`applyWorkerAccess` both live in `exec/privilege.ts`, so a module-global ledger
could observe both decisions without touching either caller. That was rejected
deliberately. This module's own `createPrivilegeWarner` is a *factory*
specifically so that once-per-process state lives in a closure a test can own
rather than in a module a test has to reset, and a hidden global that couples two
exported functions by call order would contradict that in the same file — and
would be latently wrong under the shared vitest worker that already produced
D-2-07-2.

**Status:** open. Not blocking — the mismatch requires a `PATH` that differs
between the daemon and the child in whether it contains `sudo`, which no current
call site produces. Belongs with whichever plan next touches `run()`'s signature.

<!-- ─────────────────────────────────────────────────────────────────────────
     The entries below were recorded by the 02 verification-gap fix pass.

     They existed only as a prose "Not touched" sentence at the end of
     `02-07-SUMMARY.md` — no reproduction, no owning phase, no acceptance
     decision — which is a different standard from the seven entries above and
     is why `02-VERIFICATION.md` routed them to a human. Recording them here
     does not decide them; it makes them decidable.

     Of that list, WR-01, WR-02 and WR-11 were FIXED rather than deferred (see
     `02-VERIFICATION.md` § Gaps and the three `fix(02):` commits). What
     follows is the genuine residue.
     ───────────────────────────────────────────────────────────────────────── -->

## D-2-R-3: `assertWithinRoot` is check-then-use against a concurrently running agent (WR-07)

**Found by:** `02-REVIEW.md` § WR-07 (warning). Left untouched by the review-fix
pass and absent from this file until now.

**What goes wrong:** `assertWithinRoot` realpaths, returns an absolute path, and
the caller then opens it — `readFile` in `read()`, `mkdir` + `writeFile` in
`write()`. Those are two syscalls with a gap between them. An agent running
inside its own worktree, which is the normal state of affairs while a stage
writes an artifact, can replace a path component with a symlink in that gap, and
the subsequent `open()` follows it.

`paths.ts`'s docblock presents the realpath walk as *the* answer to T-2-24 ("a
symlink planted inside the root defeats every check here"), and it is — for a
symlink planted **before** the check. It cannot be for one planted after, and
nothing in the module says so, which is the part that misleads: a reader
budgeting trust from that paragraph over-trusts it.

The same gap now exists on the `cwd` path added for WR-01
(`assertCwdWithinRoot`), for the identical reason and with the identical shape:
the guard resolves, `run()` then hands the path to execa.

**Reproduction:** [NOT REPRODUCED — this is a race, and a reproduction is a
harness rather than a transcript.] The shape it would take: `read()` a path
whose parent directory is replaced with a symlink to `/etc` by a concurrent
process in a tight loop, and observe a read outside the root succeeding at some
iteration. Worth building as part of the fix rather than before it — an
unreproduced race is a real finding, but a *flaky* reproduction is not evidence
either way, and the phase's recurring defect is controls believed for the wrong
reason.

**What picking it up requires**, in the shape that looks right from here:

- The cheap, portable half first: `open()` the file, then `fstat` the handle and
  compare `dev`/`ino` against a `stat` of the path the guard blessed, failing
  closed on mismatch. No new syscalls beyond one `fstat`, and it converts the
  race from "the attacker wins silently" to "the attacker is detected".
- `O_NOFOLLOW` on the leaf where the platform supports it (Linux, macOS), which
  closes the leaf case outright. Windows has no equivalent, so this cannot be
  the only measure — the platform-split shape § Pitfall 7 warns about.
- Whichever is chosen, `paths.ts`'s docblock must state what the guard does and
  does not cover. If the residual race is ACCEPTED instead of closed, that
  sentence is the entire deliverable and is worth more than a partial fix.

**Owning phase: Phase 3.** It owns the manager/worker seam and concurrency
limits, so it is the first phase in which "an agent is running while ADL touches
the same tree" is a scheduled event rather than a possibility. D-2-R-1 (one
worker identity per deployment) is filed there for the same reason and makes the
same window wider; the two want to be reasoned about together.

**Status:** open. Not blocking — it requires an agent actively racing ADL's own
`read`/`write` on the same path, and in v1 nothing schedules those concurrently.

## D-2-R-4: an attacker-named `filter.<driver>.clean` still executes during ADL's own `snapshot()` (WR-12 residual)

> **DISPOSITION — ACCEPTED FOR v1, OWNER: PHASE 15.**
> Decided by the maintainer at the Phase 02 UAT gate on 2026-08-19
> (`02-UAT.md` test 3). Accepted so v1 can ship; **not** closed.
>
> **What makes this different from D-2-R-1:** this is not an argued risk. There
> is a PASSING test demonstrating it right now —
> `packages/workspace/test/git/neutralisation-residual-risk.test.ts` executes a
> chosen program during ADL's own `snapshot()` with full neutralisation in
> force. If that test ever goes red, the residual closed by accident and the
> entry should be revisited; if it is ever deleted or weakened, the acceptance
> below silently stops being observable, which is the failure mode this whole
> phase kept producing.
>
> **What bounds it today:** `git status` does not reach the filter; `git stash
> create` does, and that is what `snapshot()` runs. Exploiting it requires a
> committed `.gitattributes` in the repository being snapshotted — reachable,
> since D-22 treats the feature spec as untrusted input written by anyone who
> can push. The six remaining fixed-name keys (`core.askPass`, `gpg.program`,
> `sequence.editor`, `core.alternateRefsCommand`, `gpg.ssh.program`,
> `uploadpack.packObjectsHook`) are NOT reachable through any operation ADL
> ships today, which is why they were not added.
>
> **Owner: Phase 15 (published threat model).** Accepted on the verifier's
> reasoning: the threat model is where an accepted residual either appears with
> its reasoning or silently stops being accepted. Recorded caveat — Phase 15's
> stated success criteria cover write auditing, secret scanning and egress, and
> say nothing about git-config neutralisation. **Phase 15 must gain an explicit
> criterion for this, or the residual will land in a phase with no acceptance
> point and quietly become invisible.**
>
> **Revisit earlier than Phase 15 if ANY of these is true:**
> 1. `ManagerGitClient` gains an operation that reaches one of the six
>    fixed-name keys — they were excluded for unreachability, not safety.
> 2. ADL ever runs `snapshot()` against a repository it does not control.
> 3. The `.gitattributes` path becomes reachable without a commit.

**Found by:** `02-REVIEW.md` § WR-12. The fixed-name half was closed; the
**wildcard** half is open, and this entry is that half.

`02-VERIFICATION.md` routed this to a human decision because Phase 15's success
criteria are about write auditing, secret scanning, egress and a published threat
model, and none of them names git-config neutralisation — too tangential to
auto-defer. It is filed here so it has an owner proposed rather than none.

**What is open:** `NEUTRALISED_CONFIG` neutralises eight keys by name.
`filter.<driver>.clean` / `.smudge` and `diff.<driver>.textconv` / `.command`
cannot be neutralised that way, because `<driver>` is chosen by whoever writes
the `.gitattributes` — `-c filter.x.clean=` closes one name, not the mechanism.
A `.gitattributes` committed into the repository selects the driver, and git
invokes it on checkout, status and diff. `core.attributesFile` points the GLOBAL
attributes file somewhere inert and has no effect on a committed one.

**Reproduction: it already exists, it is committed, and it passes.**
`packages/workspace/test/git/neutralisation-residual-risk.test.ts` §
`executes a committed .gitattributes filter during snapshot(), overrides and all`
plants a `.gitattributes` naming an attacker-chosen driver and observes the
program run during ADL's own `snapshot()` **with the full `NEUTRALISE_ARGS` set
in force**. It carries a `git check-attr` control so it cannot pass vacuously,
and the file's docblock says what to do if it ever goes green: the hole closed,
and the risk record should be updated rather than the test deleted. That is the
opposite of a control passing for the wrong reason, and it is why this entry
needs no new evidence.

**What picking it up requires:** a decision, then a mechanism.

- The decision: is "agent-written configuration cannot affect ADL's own git
  operations" (WORK-07) satisfied by eight fixed keys plus a Linux-only OS layer,
  with the wildcard driver family open on every other platform? Phase 2 shipped
  saying yes, honestly and in writing (`NEUTRALISATION_RESIDUAL_RISK`, the README
  table, and the passing test above). A later phase may reasonably say no.
- The mechanism, if the answer is no: the candidates are running ADL's own git
  with the driver families disabled at a level `.gitattributes` cannot reach, or
  taking snapshots through a path that does not apply attributes at all
  (`git stash create` does), or refusing to operate on a tree whose
  `.gitattributes` names a driver ADL has not seen. Each is a real design with
  real cost; none is a flag.

**Owning phase: Phase 15**, which is where the threat model is published — the
document in which an accepted residual either appears with its reasoning or
silently stops being accepted. Proposed rather than assigned: it needs the
success criteria to gain a line about configuration neutralisation, because
today they do not have one.

**Status:** open, and DEMONSTRATED rather than suspected. Not blocking — it
requires a `.gitattributes` committed into the repository ADL is running against,
which is the same trust boundary D-22 already puts the feature spec on.

## D-2-R-5: the workspace package's tests are never typechecked (WR-13)

**Found by:** `02-REVIEW.md` § WR-13.

**Reproduction** — run in `packages/workspace`, at the commit that fixed WR-01:

```
$ npx tsc --noEmit --listFiles | grep -c "packages/workspace/test/"
0
```

[VERIFIED locally during the 02 verification-gap fix pass.] `tsconfig.json`'s
`include` is `["src/**/*.ts"]` and `typecheck` is a bare `tsc --noEmit`, so none
of the ~2,900 lines under `test/` is ever compiled. Vitest transpiles them
without checking.

**Why it matters:** `packages/core` solved exactly this with a
`tsconfig.test.json`, on the stated grounds that "an assertion that is never
compiled asserts nothing". This package has far more test code than core and
several constructs that only a compiler would catch drifting — non-null
assertions in `privilege.test.ts`, `as unknown as` casts in `env.test.ts`, and
now the `as ExecSpec` shapes this pass added. A test that stops compiling after a
renamed export does not fail CI's typecheck step; it fails at runtime with a
message about the wrong thing, or quietly stops asserting.

**What picking it up requires:** copy `packages/core/tsconfig.test.json` into the
package and make `typecheck` run both programs
(`tsc --noEmit && tsc --noEmit -p tsconfig.test.json`). Small, but not free: the
first run will surface real errors in ~2,900 lines that have never been
compiled, and fixing those is the actual work. Doing it inside a fix pass whose
reviewers were asked to look at containment would bury them.

**Owning phase: Phase 3**, as a chore at the start rather than a plan of its own
— it should land before Phase 3 writes more workspace tests, because every test
added first is more to fix later.

**Status:** open. Not blocking — nothing is known to be broken; the point is that
nothing would say so.

## D-2-R-6: CI runs Linux only, so every Windows branch in this phase is unverified (WR-14)

**Found by:** `02-REVIEW.md` § WR-14.

**Reproduction:** `.github/workflows/ci.yml:15` is `runs-on: ubuntu-latest`, and
the matrix at line 22 varies the Node version only. [VERIFIED by reading the
workflow at this commit.]

**Why it matters:** this phase's source is platform-conditional on nearly every
security path — `env.ts`'s `USERPROFILE` branch, `paths.ts`'s case-folded
comparison, `scratch-home.ts`'s `EBUSY`/`EPERM` retry, `privilege.ts`'s OS gate,
and the `chmod` skips in two test helpers. The maintainer's machine is the only
place the Windows branches ever run, and it is not a gate. The phase's own
history is *about* a control that passed for the wrong reason on one platform
(D-21, `platform.ts`).

It also bit this fix pass directly. The WR-01 change had to alter a code path
(`poisoned-config.test.ts`'s `inWorktreeAsOwner`) that is only REACHED under the
Linux privilege drop; the mitigation was to create the workspace unconditionally
and add a control that runs everywhere, but "unverified until CI" is a sentence
this repository should not have to keep writing.

**What picking it up requires:** add `windows-latest` — and ideally
`macos-latest` — to the matrix, with the worker-provisioning step guarded by
`if: runner.os == 'Linux'`. `linuxOnly()` already behaves correctly on a
non-Linux runner: it prints its `[ADL][SKIPPED]` line and continues, so the extra
legs are cheap and immediately meaningful. Expect the first Windows run to be
red; that is the finding, not a reason to defer again.

**Owning phase: Phase 3.** It is the next phase to add cross-platform surface
(the manager/worker `fork()` seam), and adding legs after that surface exists
means debugging two things at once.

**Status:** open. Not blocking any code property — it is a gap in *evidence*,
which is precisely the class of gap this phase keeps finding.

## D-2-R-7: the aborted-signal contract case cannot tell "killed" from "never started" (IN-01)

**Found by:** `02-REVIEW.md` § IN-01 (info).

**What goes wrong:** the case asserts `exitCode !== 0`, `durationMs < 30_000` and
`chunks == []`. A child that was never spawned satisfies all three — `run()` maps
execa's `undefined` exit code to `null`, which is `!== 0`. Its comment says "the
assertion that this call returns at all is the assertion that it was killed",
which holds only if something proves the process existed.

**Why it matters more than an info finding usually would:** D-2-07-1 defers the
question of whether cancellation reaches a **dropped** child and says "measure
first". This case looks, at a glance, like that measurement. It is not, and a
reader who takes it for one will close D-2-07-1 without evidence.

**Reproduction:** [NOT REPRODUCED — it is an argument about what the assertions
admit, not a failure.] It is checkable by inspection: `run.ts`'s
`exitCode: result.exitCode ?? null` and the three assertions are all that is
involved.

**What picking it up requires:** have the child write a marker into the workspace
root before sleeping, abort after observing the marker, and assert both that the
first marker exists (it ran) and that a second marker written after the sleep
does not (it was killed). That turns the case into the measurement D-2-07-1 asks
for on the undropped path, which is most of the way to closing it.

**Owning phase: Phase 4**, with D-2-07-1 — the plan that owns cancellation
semantics end to end, since budget interrupt is what first cancels an exec.

**Status:** open. Not blocking — cancellation demonstrably works on the undropped
path; what is missing is a case that could tell if it stopped.

## D-2-R-8: `tracer.test.ts` asserts scratch-home removal unconditionally (IN-02)

**Found by:** `02-REVIEW.md` § IN-02 (info).

**What goes wrong:** `expect(await exists(scratchHome)).toBe(false)` runs
immediately after a real child exited in that workspace — the exact scenario
`credentials.test.ts` and `scratch-home.test.ts` both refuse to assert
unconditionally, because a just-exited child can still hold a Windows handle.
`destroyScratchHome`'s retry loop makes it usually pass.

**Reproduction:** [NOT REPRODUCED — it has not been observed failing. "Usually
passes" is the claim, and a flake that has not flaked yet is exactly the thing
that is hard to evidence.] It is asymmetric with two sibling suites that were
written the careful way, and that asymmetry is the finding.

**What picking it up requires:** gate it the way `credentials.test.ts` does —
assert the reported `ScratchHomeTeardown` outcome, and assert absence only when
the outcome is `removed` / `already-absent`. Five lines, and it removes a source
of red runs that would be blamed on whatever change happened to be in flight.

**Owning phase: Phase 3**, together with D-2-R-6 — a Windows CI leg is what would
turn this from "usually" into "sometimes red on somebody else's PR", so the two
should land in the same direction.

**Status:** open. Not blocking.

## D-2-R-9: the stub snapshot id is not unique (IN-03)

**Found by:** `02-REVIEW.md` § IN-03 (info).

**What goes wrong:** `stub-${featureId}-${captured.size}-${Date.now()}` is
documented as "stable and unique per capture", and two snapshots of the same file
count within one millisecond collide. The contract case only asserts `id !== ''`,
so the documented claim is untested.

**Reproduction:** [NOT REPRODUCED as a failing test — no current caller takes two
stub snapshots in a millisecond.] It is the same defect as WR-09, which WAS
reproduced and fixed in the worktree backend by replacing the clock with a
process-local counter (`nextSnapshotSeq`), and the reasoning transfers verbatim:
"two captures within the same millisecond are exactly the case that has to be
distinguished, so a clock is the one source that cannot be used."

**What picking it up requires:** the same counter the worktree backend already
uses, and a contract case asserting two consecutive snapshots have different
ids — which would run against both backends and is the assertion whose absence
let this survive.

**Owning phase: Phase 4**, the first phase to take snapshots in a round loop and
therefore the first that could collide. Small enough to do sooner if anything
else touches the stub backend.

**Status:** open. Not blocking — the stub backend serves no production
deployment.

## D-2-R-10: `isWithinRoot` rejects everything for a filesystem-root `root` (IN-04)

**Found by:** `02-REVIEW.md` § IN-04 (info).

**What goes wrong:** the comparison is
`target === root || target.startsWith(root + sep)`. For `root = '/'` (or `C:\`),
`root + sep` is `'//'`, so every candidate is reported outside — containment
silently rejects everything rather than failing loudly.

**Reproduction:** [VERIFIABLE IN ONE LINE, not yet committed as a case:
`isWithinRoot('/', '/etc')` returns `false`.] Unreachable through the current
backends — every root is a `mkdtemp` directory, a worktree path, or a repository
— but `isWithinRoot` is **exported**, and its docblock offers it to out-of-tree
code as the way to ask this question.

**Why the direction matters:** it fails CLOSED, which is the safe direction and
is why this is info rather than a warning. The cost is a container backend rooted
at `/` inside its own namespace — a plausible v2 shape — whose every path is
refused for a reason no message explains.

**What picking it up requires:** normalise before the prefix test
(`root.endsWith(sep) ? root : root + sep`), plus a case per platform separator.
Ideally also a decision on whether a filesystem-root workspace should be refused
outright at construction, which may be the more honest answer.

**Owning phase: the phase that adds the container backend** (post-v1, per D-03).
It is the first caller for which the case is reachable, and fixing it earlier
without that caller means guessing at what the right behaviour is.

**Status:** open. Not blocking — fails closed, and unreachable in v1.

## D-2-R-11: `WorktreeWorkspaceOptions.worker` is unreachable through the registry (IN-05)

**Found by:** `02-REVIEW.md` § IN-05 (info).

**What goes wrong:** `worktreeBackend.create` calls `worktreeWorkspace(spec)`
with no options, and `WorkspaceRegistryConfig` has a `hostGit` field but no
`worktree` one — so the worker identity can only ever come from
`workerIdentityFromEnv()`. `privilege.ts` promises otherwise, in as many words:
"A caller that passes an identity explicitly — the manager, once Phase 3 owns
configuration — overrides this entirely."

**Reproduction:** [NOT REPRODUCED — it is a reachability fact, checkable by
reading `registry.ts`'s two `create` implementations side by side. The `hostGit`
field is threaded; there is no `worktree` field to thread.]

**Why it matters, and why it is worse than an unused option:** `registry.ts` is
by rule the ONLY place a backend factory may be named — enforced by
`workspace-contract.test.ts`. So Phase 3 cannot deliver the promised override
without editing this file, and the promise sits at the definition where a Phase 3
author will read it and believe the wiring exists. It is also the mechanism
D-2-R-1's per-feature worker pool needs: a leased identity has to reach the
backend somehow, and this is the field it would reach it through.

**What picking it up requires:** add `readonly worktree?: WorktreeWorkspaceOptions`
to `WorkspaceRegistryConfig` and thread it, mirroring `hostGit` exactly — or
delete the option and the promise. Threading it is the better half of that
choice given D-2-R-1, but it should be done by the plan that has a caller for it,
not speculatively.

**Owning phase: Phase 3**, which is where D-2-R-1 says the lease state lives and
where `privilege.ts`'s own docblock already says the override arrives.

**Status:** open. Not blocking — `workerIdentityFromEnv()` is the correct source
for a single-identity deployment, which is every v1 deployment.
