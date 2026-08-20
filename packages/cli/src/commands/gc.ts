import type { DaemonClient, GcRunSummary } from '../http-client.js';
import type { WriteSink } from './status.js';

/**
 * `adl gc` — `POST /control/gc` on demand (D-34). Discharges Phase 2's
 * deferred D-15 sweep trigger from the operator's side, alongside the timer
 * `packages/manager/src/scheduler/gc-schedule.ts` runs on its own cadence.
 */

export interface GcCommandDeps {
  readonly client: DaemonClient;
  readonly stdout?: WriteSink;
}

export async function gcCommand(deps: GcCommandDeps): Promise<void> {
  const summary: GcRunSummary = await deps.client.postGc();
  const out = deps.stdout ?? process.stdout;

  out.write(
    `Reclaimed ${summary.worktreesRemoved.length} worktree(s) and ` +
      `${summary.scratchHomesRemoved.length} scratch home(s).\n`,
  );
  const failureCount =
    summary.worktreeFailures.length + summary.scratchHomeFailures.length;
  if (failureCount > 0) {
    out.write(
      `${failureCount} entr${failureCount === 1 ? 'y' : 'ies'} could not be collected.\n`,
    );
  }
}
