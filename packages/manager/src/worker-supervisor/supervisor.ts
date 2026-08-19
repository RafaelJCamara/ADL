import { forkWorker, type ForkedWorker } from '@adl/workspace';
import type { FeaturesTable } from '@adl/db';
import type { Logger } from 'pino';
import {
  parseWorkerMessage,
  type AssignMessage,
  type LeaseLostMessage,
} from '../ipc/protocol.js';

/**
 * One feature's forked worker, and everything the supervisor tracks about it.
 */
export interface ActiveWorker {
  readonly featureId: string;
  readonly leaseToken: string;
  readonly worker: ForkedWorker;
}

/** What `renewLease` needs — the exact shape `featuresRepository.renewLease` accepts. */
export type RenewLease = (params: {
  id: string;
  leaseToken: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
}) => Promise<boolean>;

/** One rejected worker message, for D-09's "expected-but-notable, counted" handling. */
export interface StaleMessage {
  readonly featureId: string;
  readonly kind: string;
  readonly presentedToken: string;
}

/** The `ready` message's payload, surfaced for observability (tests; later, status). */
export interface WorkerReady {
  readonly featureId: string;
  readonly leaseToken: string;
  readonly pid: number;
}

export interface SupervisorDeps {
  /** The worker entry module to fork — real in production, scripted in tests (D-30). */
  readonly entryPath: string;
  readonly cwd: string;
  readonly execArgv?: readonly string[];
  readonly logger: Logger;
  readonly leaseTtlMs: number;
  readonly renewLease: RenewLease;
  /** Called whenever a heartbeat's token no longer matches the lease (D-09). */
  readonly onStaleMessage?: (message: StaleMessage) => void;
  /** Called once a forked worker reports `ready` — the pid it started as. */
  readonly onReady?: (ready: WorkerReady) => void;
  /**
   * Called when a forked worker's process exits without the manager having
   * accepted a `stage_result` from it or itself requesting the exit (D-04).
   * The database write that recovers the feature (`reapOne`, the same
   * function the reaper's own tick calls) is deliberately not this
   * supervisor's job — see `../daemon.ts` for the wiring, and the reaper's
   * own `expectedLeaseToken` guard for why a late-arriving exit from an
   * already-superseded lease is safe to report here unconditionally.
   */
  readonly onUnexpectedExit?: (featureId: string, leaseToken: string) => void;
}

export interface WorkerSupervisor {
  /**
   * Fork a worker for `feature`, attach the message handler, and send the
   * `assign` message. Never called until `dispatchOnce` has already acquired
   * the lease — a fork that preceded a successful acquire would be a worker
   * with no claim.
   */
  spawn(
    feature: FeaturesTable,
    leaseToken: string,
    assign: AssignMessage,
  ): ActiveWorker;
  get(featureId: string): ActiveWorker | undefined;
  list(): readonly ActiveWorker[];
  /**
   * Mark a worker's next exit as manager-requested, so it does not trigger
   * `onUnexpectedExit`. Used by daemon shutdown (`stop()`), which kills every
   * active worker deliberately and does not want the fast path racing its
   * own `db.destroy()`.
   */
  markExpectedExit(featureId: string): void;
}

/**
 * `createSupervisor(deps)` — the manager's half of the worker relationship.
 *
 * The active-worker map is keyed by feature id: one `ChildProcess` per active
 * lease, and messages arrive only on the channel the manager itself opened.
 * Sender attribution is therefore structural rather than checked — the
 * supervisor's own bookkeeping is the trust boundary (T-3-08). What IS
 * checked, on every message, is whether it parses at all (dropped and logged
 * at `warn` if not — an infrastructure failure, never trusted data, the same
 * discipline CORE-06 applies to a malformed agent verdict) and, for a
 * `heartbeat`, whether its token still matches the live lease — delegated
 * entirely to `renewLease`'s own `WHERE lease_token = ?` guard (D-06), which
 * is the structural half of the fence and holds regardless of what this
 * function does with the boolean it returns.
 */
export function createSupervisor(deps: SupervisorDeps): WorkerSupervisor {
  const active = new Map<string, ActiveWorker>();
  /**
   * Whether this feature's currently-active worker's next exit is
   * manager-requested (a stage result was accepted, or the manager itself
   * asked it to stop) — D-04's "expected exit" case, kept separately from
   * `active` so it survives being read from the `exit` handler after
   * `active.delete()` has already run.
   */
  const expectingExit = new Map<string, boolean>();

  function spawn(
    feature: FeaturesTable,
    leaseToken: string,
    assign: AssignMessage,
  ): ActiveWorker {
    const worker = forkWorker(deps.entryPath, {
      cwd: deps.cwd,
      execArgv: deps.execArgv,
    });
    const log = deps.logger.child({ featureId: feature.id, leaseToken });
    expectingExit.set(feature.id, false);

    worker.stdout.on('data', (chunk: Buffer) => {
      log.info({ stream: 'stdout' }, chunk.toString().trimEnd());
    });
    worker.stderr.on('data', (chunk: Buffer) => {
      log.info({ stream: 'stderr' }, chunk.toString().trimEnd());
    });
    worker.child.on('error', (error: Error) => {
      log.warn({ err: error }, 'forked worker reported an error');
    });

    worker.child.on('exit', () => {
      const expected = expectingExit.get(feature.id) ?? false;
      active.delete(feature.id);
      expectingExit.delete(feature.id);
      if (!expected) {
        log.warn(
          'forked worker exited without an accepted result — applying the fast-path lease_expired recovery',
        );
        deps.onUnexpectedExit?.(feature.id, leaseToken);
      }
    });

    worker.child.on('message', (raw: unknown) => {
      const parsed = parseWorkerMessage(raw);
      if (!parsed.ok) {
        // An unparseable message from a crashed or malicious worker is an
        // infrastructure failure, never trusted data — dropped, and no
        // repository method is called for it.
        log.warn(
          { reason: parsed.reason },
          'dropped an unparseable worker message',
        );
        return;
      }
      const message = parsed.message;
      log.debug({ kind: message.t }, 'worker message');

      if (message.t === 'ready') {
        deps.onReady?.({
          featureId: feature.id,
          leaseToken: message.leaseToken,
          pid: message.pid,
        });
      }

      if (message.t === 'heartbeat') {
        const leaseExpiresAt = new Date(
          Date.parse(message.at) + deps.leaseTtlMs,
        ).toISOString();
        void deps
          .renewLease({
            id: feature.id,
            leaseToken: message.leaseToken,
            heartbeatAt: message.at,
            leaseExpiresAt,
          })
          .then((renewed) => {
            if (!renewed) {
              deps.onStaleMessage?.({
                featureId: feature.id,
                kind: message.t,
                presentedToken: message.leaseToken,
              });
              log.warn(
                { presentedToken: message.leaseToken },
                'renewLease rejected a heartbeat — the presented token is no longer current',
              );
              // D-05: tell the worker its lease is gone so it self-terminates
              // rather than continuing to work a stage nobody trusts anymore.
              // Fencing at the database is the guarantee; this is defence in
              // depth, so a worker that stops on its own never races a
              // replacement worker inside the same worktree.
              const leaseLost: LeaseLostMessage = {
                t: 'lease_lost',
                featureId: feature.id,
              };
              worker.child.send?.(leaseLost);
            }
          });
      }

      if (message.t === 'stage_result') {
        // The worker is finishing on its own after reporting a result —
        // D-04's "expected exit" case. The fast path must not also apply
        // `lease_expired` for the exit that follows.
        expectingExit.set(feature.id, true);
      }
      // 'ready' is handled above; 'fatal' is logged above and deliberately
      // NOT marked as an expected exit — a self-reported fatal error is a
      // worker dying just as surely as a SIGKILL, and the fast path recovers
      // it the same way. Round/stage bookkeeping (writing stage_attempts,
      // verdicts) for an accepted 'stage_result' is a later plan's job —
      // this plan proves the channel, the heartbeat path, and the exit
      // classification end to end.
    });

    worker.child.send?.(assign);

    const entry: ActiveWorker = { featureId: feature.id, leaseToken, worker };
    active.set(feature.id, entry);
    return entry;
  }

  return {
    spawn,
    get: (featureId) => active.get(featureId),
    list: () => [...active.values()],
    markExpectedExit: (featureId) => {
      expectingExit.set(featureId, true);
    },
  };
}
