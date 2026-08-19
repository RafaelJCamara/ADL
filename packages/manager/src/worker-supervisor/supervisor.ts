import { forkWorker, type ForkedWorker } from '@adl/workspace';
import type { FeaturesTable } from '@adl/db';
import type { Logger } from 'pino';
import { parseWorkerMessage, type AssignMessage } from '../ipc/protocol.js';

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

    worker.stdout.on('data', (chunk: Buffer) => {
      log.info({ stream: 'stdout' }, chunk.toString().trimEnd());
    });
    worker.stderr.on('data', (chunk: Buffer) => {
      log.info({ stream: 'stderr' }, chunk.toString().trimEnd());
    });
    worker.child.on('error', (error: Error) => {
      log.warn({ err: error }, 'forked worker reported an error');
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
            }
          });
      }
      // 'ready', 'stage_result', and 'fatal' are logged above; their full
      // handling (round/stage bookkeeping, the fencing check on a result
      // write) is a later plan's job — this tracer proves the channel and
      // the heartbeat path end to end.
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
  };
}
