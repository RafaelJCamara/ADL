/**
 * Turning what teardown did into something an operator can read.
 *
 * `WorkspaceSpec.onTeardown` is an optional sink (`@adl/core/stage`), and the
 * mapping onto it is here — in one place, shared by both backends — rather than
 * inline in each. Two copies of a three-case mapping is two chances for one of
 * them to report `reclaimed` for a directory that is still on disk, and the
 * whole point of the sink is that an operator can believe what it says.
 *
 * Plan `02-05` is why this exists: `destroyScratchHome` learned to report
 * `removed | already-absent | not-removed`, and `destroy()` dropped the result
 * on the floor, so a leaked scratch `HOME` was invisible. See
 * {@link WorkspaceTeardownReport} for why the fix is a sink rather than a
 * return value.
 */
import type { WorkspaceTeardownReport } from '@adl/core/stage';
import type { ScratchHomeTeardown } from './exec/scratch-home.js';

/** A sink for teardown reports — `WorkspaceSpec.onTeardown`, when supplied. */
export type TeardownSink = (report: WorkspaceTeardownReport) => void;

/**
 * Hand one report to the sink, if there is one, without ever letting it break
 * teardown.
 *
 * A throwing sink is a caller's bug, but the cost of letting it propagate is
 * that the *rest* of teardown — the scratch home, in the worktree backend's
 * order — never runs. Reporting a leak must not cause one.
 */
export function report(
  sink: TeardownSink | undefined,
  entry: WorkspaceTeardownReport,
): void {
  if (sink === undefined) return;
  try {
    sink(entry);
  } catch {
    // Deliberately swallowed, and deliberately not logged: this package has no
    // logger, and the only thing available to log to would be the sink that
    // just threw.
  }
}

/**
 * Report a {@link ScratchHomeTeardown} as the `scratch-home` resource.
 *
 * The three outcomes map one to one, which is the reason `destroyScratchHome`
 * runs `rm` without `force: true` — `force` swallows `ENOENT`, and `ENOENT` is
 * the only thing that distinguishes `already-absent` from `removed`. With
 * `force` on, this function could only ever report `reclaimed`, and a second
 * teardown would look identical to a first.
 */
export function reportScratchHomeTeardown(
  sink: TeardownSink | undefined,
  workspaceId: string,
  teardown: ScratchHomeTeardown,
): void {
  if (sink === undefined) return;

  switch (teardown.outcome) {
    case 'removed':
      report(sink, {
        workspaceId,
        resource: 'scratch-home',
        outcome: 'reclaimed',
      });
      return;
    case 'already-absent':
      report(sink, {
        workspaceId,
        resource: 'scratch-home',
        outcome: 'already-absent',
      });
      return;
    case 'not-removed':
      report(sink, {
        workspaceId,
        resource: 'scratch-home',
        outcome: 'not-reclaimed',
        // The OS code and message. `destroyScratchHome` builds this string from
        // the error alone, never from the child's environment (WORK-06).
        reason: teardown.reason,
      });
      return;
  }
}
