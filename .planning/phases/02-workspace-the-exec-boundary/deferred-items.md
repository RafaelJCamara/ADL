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
