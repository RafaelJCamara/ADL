/**
 * The one process launch in the repository (WORK-02).
 *
 * This is the only module that imports `execa`, and `eslint.config.js`'s
 * `adl/no-direct-spawn` rule is what keeps it that way — its single exemption is
 * `packages/workspace/**`. A direct spawn anywhere else would bypass the
 * zero-inherit environment, the scratch `HOME`, the privilege drop, and the
 * git-config neutralisation simultaneously, and none of those bypasses would be
 * visible in a diff.
 *
 * `scratchHome` is a positional parameter rather than a field on `ExecSpec`
 * because it belongs to the `Workspace` instance (D-07). This function is the
 * only caller of `buildChildEnv`, and it always passes both arguments, so there
 * is exactly one place where a child environment comes into existence.
 */
import { execa } from 'execa';
import type { ExecResult, ExecSpec, LogChunk } from '@adl/core/stage';
import { WorkspaceError } from '../errors.js';
import { buildChildEnv } from './env.js';
import {
  privilegeLauncher,
  warnPrivilegeModeOnce,
  type WorkerIdentity,
} from './privilege.js';

/**
 * Whose child this is — an agent's, or ADL's own (D-12, D-17).
 *
 * Only two things depend on it, and both are about the privilege drop:
 *
 * - **`'agent'`** — a child of a feature workspace, running code an agent
 *   chose. It is dropped to the worker user where the platform allows, and a
 *   run that could not be dropped emits WORK-05's banner.
 * - **`'adl'`** — a child ADL launches for itself: the manager-owned git client
 *   and nothing else today. It is deliberately **not** dropped, and it does not
 *   emit the banner.
 *
 * The second half of that is not a cosmetic detail, which is why this parameter
 * exists rather than the host backend simply passing an empty identity:
 *
 * 1. Dropping ADL's own git would be *wrong*, not merely unnecessary. The file
 *    the manager must be able to write — `<mainRepo>/.git/config` — is exactly
 *    the one `applyWorkerAccess` takes group and world write off of, precisely
 *    so the worker user cannot reach it (02-RESEARCH.md § Pitfall 5, layer 2).
 *    A dropped manager would be locked out of its own repository.
 * 2. {@link warnPrivilegeModeOnce} fires **once per process**. An ADL-owned
 *    child on a correctly configured Linux deployment resolves to
 *    `worker-user-unset` — it carries no worker identity, because it wants
 *    none — so without this distinction a manager-side `git status` running
 *    first would print "ADL_WORKER_USER is not set" at an operator who set it,
 *    *and* consume the one banner that the next agent exec genuinely needed.
 *    Losing the real warning to a false one is T-2-32 arriving through the
 *    front door.
 *
 * It defaults to `'agent'` so that the containment-relevant behaviour is what a
 * caller gets by forgetting, rather than what a caller gets by remembering.
 */
export type ExecOwner = 'agent' | 'adl';

export async function run(
  spec: ExecSpec,
  scratchHome: string,
  log: (chunk: LogChunk) => void,
  /**
   * The pre-provisioned worker identity to drop to (WORK-05, D-18).
   *
   * Defaulted to the empty identity rather than to `workerIdentityFromEnv()`,
   * so that reading the daemon's environment happens in exactly one place — the
   * backend factory — and a direct caller of `run()` gets the drop only if it
   * asked for it. An empty identity yields the `worker-user-unset` mode, which
   * warns rather than throwing.
   */
  worker: WorkerIdentity = {},
  /** See {@link ExecOwner}. Defaults to the containment-relevant value. */
  owner: ExecOwner = 'agent',
): Promise<ExecResult> {
  if (spec.argv.length === 0) {
    throw new WorkspaceError(
      'ExecSpec.argv is empty — there is no command to run.',
    );
  }

  // Decided per exec rather than per workspace, because the launcher must be
  // resolvable from the CHILD's PATH and `ExecSpec.path` is per exec
  // (02-RESEARCH.md § Pitfall 7). The warning is once per process, so a
  // workspace running fifty commands undropped says so once.
  //
  // An ADL-owned child skips the decision entirely rather than making it and
  // discarding the answer: there is no identity to drop to, no prefix to build,
  // and — the load-bearing part — no banner to spend. See {@link ExecOwner}.
  let prefix: readonly string[] = [];
  if (owner === 'agent') {
    const privilege = await privilegeLauncher({ worker, path: spec.path });
    warnPrivilegeModeOnce(privilege.mode);
    prefix = privilege.prefix;
  }

  // The prefix WRAPS the argv; it does not replace the command. `prefix` is
  // empty for every non-dropped mode, so there is no branch here and the
  // dropped and undropped paths cannot drift apart.
  const [file, ...args] = [...prefix, ...spec.argv];
  if (file === undefined) {
    // Unreachable — the emptiness check above already ran against spec.argv.
    // Present because `noUncheckedIndexedAccess` is on and a non-null assertion
    // here would be the one place in this file the compiler was overruled.
    throw new WorkspaceError(
      'ExecSpec.argv is empty — there is no command to run.',
    );
  }

  const startedAt = Date.now();

  const subprocess = execa(file, args, {
    cwd: spec.cwd,

    // D-10, the whole point of this module. `extendEnv: false` means `env` is
    // the child's COMPLETE environment — process.env is not merged underneath
    // it. Note the second-order effect this has on binary resolution: execa
    // then resolves `file` from `env.PATH` rather than the parent's PATH
    // (execa#366), which is why `ExecSpec.path` is a required field.
    //
    // Under the privilege drop this environment is handed to `sudo`, not to the
    // command. `sudo` resets the environment by default, which would discard
    // the scratch HOME and every neutraliser in it — so the launcher prefix
    // carries `--preserve-env`, and the sudoers entry the README documents
    // carries the `SETENV` tag that permits it. Neither is optional; see
    // `exec/privilege.ts` § launcherPrefix.
    extendEnv: false,
    env: buildChildEnv(spec, scratchHome),

    // 0 is execa's "no timeout". Stated rather than omitted so the absence of a
    // timeout is a visible choice at the one place timeouts are configured.
    timeout: spec.timeoutMs ?? 0,
    // `StageContext.signal` plugs straight in — the same AbortSignal that fires
    // on budget interrupt, pause, and shutdown.
    cancelSignal: spec.signal,
    // execa's own default, written out because it is a containment control
    // (T-2-07) and a default that is never stated is a default nobody reviews:
    // a child that ignores SIGTERM gets SIGKILL 5s later rather than never.
    forceKillAfterDelay: 5_000,
    // An agent CLI spawns its own children. Killing only the direct child
    // leaves that subtree running, and a leaked subtree keeps spending budget
    // after the round it belonged to has ended (T-2-07).
    //
    // Known limitation under the privilege drop: the direct child is `sudo`,
    // which runs as root and re-execs as the worker user, so a signal ADL sends
    // reaches a process it does not own. Recorded in
    // `.planning/phases/02-workspace-the-exec-boundary/deferred-items.md`
    // rather than half-solved here — it needs a deliberate design (a process
    // group, or a `kill` routed back through the launcher), not a flag.
    killDescendants: true,
    // We stream; nothing accumulates in memory. Without this, a chatty agent's
    // output is buffered in full by execa in addition to being streamed
    // (T-2-09).
    buffer: false,
    // A non-zero exit is DATA at this boundary, not an exception: a command
    // gate whose test suite fails is the single most common thing that happens
    // here, and `ExecResult.exitCode` — declared `number | null` in @adl/core —
    // is how the caller learns about it. Without this, that field would be
    // unreachable for the most common outcome and every failing gate would
    // arrive as a thrown error instead.
    //
    // NOT handled here, deliberately: telling "the binary is missing" apart
    // from "the command ran and failed". That distinction is D-12's
    // `binary_missing` StageErrorKind, and it cannot be made from execa's
    // result — on Windows, cross-spawn routes through cmd.exe, so a missing
    // binary returns `exitCode: 1` with `code` undefined, which is byte-for-byte
    // what a command that legitimately exited 1 returns (verified locally,
    // execa 10.0.1). A guard keyed on `exitCode === undefined` would therefore
    // work on Linux and silently do nothing on the maintainer's own machine —
    // the exact platform-split failure Pitfall 7 warns about. It needs a
    // deliberate cross-platform design in the plan that owns the StageError
    // mapping; see `.planning/phases/.../deferred-items.md`.
    reject: false,

    // `spec.networkPolicy` and `spec.resources` are accepted and deliberately
    // not acted on by this backend. Nothing here can restrict a child that runs
    // directly on the host; the v2 container backend is what implements them
    // (ROADMAP.md § Phase 2 Notes). They are load-bearing for that, not dead.
  });

  // Two concurrent loops rather than `{ from: 'all' }`. `all` interleaves the
  // streams correctly but discards which one each line came from, and that tag
  // is half of what `LogChunk` is. Iterating also applies backpressure to the
  // producer — the loop body runs between reads, pausing the underlying stream —
  // which is the only backpressure available, because `log` returns void and so
  // cannot push back on the consumer (02-RESEARCH.md § Pitfall 13).
  const [, , result] = await Promise.all([
    (async () => {
      for await (const text of subprocess.iterable({ from: 'stdout' })) {
        log({ stream: 'stdout', text });
      }
    })(),
    (async () => {
      for await (const text of subprocess.iterable({ from: 'stderr' })) {
        log({ stream: 'stderr', text });
      }
    })(),
    subprocess,
  ]);

  return {
    exitCode: result.exitCode ?? null,
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    durationMs: Date.now() - startedAt,
  };
}
