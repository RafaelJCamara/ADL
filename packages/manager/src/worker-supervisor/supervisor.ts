import { forkWorker, type ForkedWorker } from '@adl/workspace';
import type { FeaturesTable } from '@adl/db';
import type { Logger } from 'pino';
import {
  parseWorkerMessage,
  type AssignMessage,
  type LeaseLostMessage,
  type UsageMessage,
} from '../ipc/protocol.js';
import { checkFence, type StaleRejectionCounter } from '../fencing.js';
import type { StageRunnerVerdict } from '../worker-entry/stage-runner.js';

/**
 * The real commit sha, when a fence-matched `stage_result`'s `verdictJson`
 * reports `{kind:'developer_outcome', outcome:{kind:'committed'}}` — never
 * for `blocked` or a `stage_error` (M05 step 5.10). `worker-entry/**` owns
 * producing this envelope (`stage-runner.ts`'s own docblock); this is the
 * first production reader of it on the manager side. A structurally
 * malformed `verdictJson` (a crashed or malicious worker) is treated as "no
 * commit to publish," not thrown — mirroring `parseWorkerMessage`'s own
 * "an infrastructure failure, never trusted data" discipline just above.
 */
function committedShaFromVerdict(verdictJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(verdictJson) as unknown;
  } catch {
    return undefined;
  }
  const verdict = parsed as Partial<StageRunnerVerdict>;
  return verdict.kind === 'developer_outcome' &&
    verdict.outcome?.kind === 'committed'
    ? verdict.outcome.sha
    : undefined;
}

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

/** Reads a feature row's *current* `lease_token`, or `null` if unleased/gone. */
export type GetCurrentLeaseToken = (
  featureId: string,
) => Promise<string | null>;

/**
 * What `recordUsage` needs to write one `usage_events` row (04-10, D-06):
 * the message's own payload columns, plus the feature/round/stage-attempt
 * identity — supplied by the SUPERVISOR from the assignment it already
 * holds, never from the message itself (T-4-38's mitigation).
 */
export interface RecordUsageInput {
  readonly featureId: string;
  readonly roundId: string;
  readonly stageAttemptId: string;
  readonly modelId: string;
  readonly speed: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly costUsd: number | null;
  readonly costSource: string;
  readonly costCategory: string;
}

/** Writes one `usage_events` row through `usageRepository(db).record` — never a second insert path. */
export type RecordUsage = (input: RecordUsageInput) => Promise<void>;

/**
 * What `closeAttempt` needs to record a stage attempt's terminal outcome
 * (04-04 Task 2's `bookkeeping/attempt.ts`): the identity comes from THIS
 * supervisor's own `assign` closure, mirroring `RecordUsageInput` — a worker
 * cannot report its own stage attempt id.
 */
export interface CloseAttemptInput {
  readonly stageAttemptId: string;
  /** `'verdict'` for a fence-matched `stage_result`, `'error'` for a self-reported `fatal`. */
  readonly status: 'verdict' | 'error';
}

/**
 * Writes `ended_at`/terminal `status` for a stage attempt through
 * `bookkeeping/attempt.ts`'s `closeAttempt` — never a second writer. Optional
 * so every earlier plan's `createSupervisor` call site keeps compiling
 * unchanged, mirroring `recordUsage`.
 */
export type CloseAttemptFn = (input: CloseAttemptInput) => Promise<void>;

/** One rejected worker message, for D-09's "expected-but-notable, counted" handling. */
export interface StaleMessage {
  readonly featureId: string;
  readonly kind: string;
  readonly presentedToken: string;
  readonly currentToken: string | null;
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
  /**
   * Explicit environment values every forked worker receives, merged over
   * `forkWorker`'s own small platform allowlist (04-06). This is the ONLY
   * channel anything reaches a worker's `process.env` through — `daemon.ts`
   * uses it to forward the model credential (`ANTHROPIC_API_KEY`) it read
   * once from its own environment, so `worker-entry/stage-runner.ts` can
   * hand it to the agent backend without the worker ever having to read the
   * daemon's ambient environment itself (WORK-06's discipline, extended to
   * this seam). Optional so every earlier plan's `createSupervisor` call
   * site keeps compiling unchanged — absent, a worker gets exactly what it
   * always did.
   */
  readonly workerEnv?: Readonly<Record<string, string>>;
  readonly logger: Logger;
  readonly leaseTtlMs: number;
  readonly renewLease: RenewLease;
  /**
   * Reads the row's *current* lease token before any lease-scoped write —
   * the message-level half of D-06's fence (`checkFence`) runs against this,
   * applied to every lease-scoped kind (`heartbeat`, `stage_result`,
   * `fatal`), not only to results. `daemon.ts` always supplies this in
   * production; optional here only so a narrowly-scoped test exercising
   * something else (the fast path, self-termination) is not forced to stub
   * it. When absent, the message-level check is skipped and `renewLease`'s
   * own `WHERE lease_token = ?` predicate remains the sole guard for
   * `heartbeat` — the SQL half of D-06's fence, which holds regardless.
   */
  readonly getCurrentLeaseToken?: GetCurrentLeaseToken;
  /** D-09's rejection counter — incremented once per dropped stale message. */
  readonly staleRejectionCounter?: StaleRejectionCounter;
  /**
   * Writes one `usage_events` row for a fence-matched `usage` message
   * (04-10). Optional so every earlier plan's `createSupervisor` call site
   * keeps compiling unchanged — absent, a `usage` message is still validated
   * and fenced, but simply produces no write, mirroring `onReady`/
   * `onRoundBoundary`'s own "no caller in production yet" precedent where
   * applicable.
   */
  readonly recordUsage?: RecordUsage;
  /**
   * Records a stage attempt's terminal outcome for a fence-matched
   * `stage_result` (`status: 'verdict'`) or self-reported `fatal`
   * (`status: 'error'`) — CR-01: without this, `ended_at` is never written
   * from production, so `GET /stages/:id/logs?follow=1`'s `isAttemptEnded`
   * gate can never observe a real run finishing and `adl logs -f` never
   * terminates on its own. Optional so every earlier plan's
   * `createSupervisor` call site keeps compiling unchanged, mirroring
   * `recordUsage`.
   */
  readonly closeAttempt?: CloseAttemptFn;
  /** Called whenever a lease-scoped message's token no longer matches the lease (D-09). */
  readonly onStaleMessage?: (message: StaleMessage) => void;
  /** Called once a forked worker reports `ready` — the pid it started as. */
  readonly onReady?: (ready: WorkerReady) => void;
  /**
   * Called once a fence-matched `stage_result` is accepted — the feature's
   * current round is done (D-26's round boundary), before the worker's exit
   * is processed. The caller decides what "done" means here: 03-07's park
   * path checks whether dispatch is paused for this feature's repository
   * and, if so, transitions the feature to `paused` right at this boundary.
   * No caller exists in production yet, mirroring `resetCrashCountOnSuccess`'s
   * own precedent (`scheduler/reaper.ts`) — the real round-completion write
   * site is Phase 4+'s pipeline; today this is exercised directly by
   * `test/control/pause.test.ts`.
   */
  readonly onRoundBoundary?: (params: {
    readonly featureId: string;
    readonly leaseToken: string;
    readonly repoId: string;
  }) => void;
  /**
   * Called once a fence-matched `stage_result` reports a real commit
   * (`developer_outcome: committed` — never `blocked`, never a
   * `stage_error`) — M05 step 5.10's publish hook. By the time this fires,
   * the branch is already on the remote if a forge is configured: a push
   * failure inside `stage-runner.ts` is reported as a `stage_error` instead
   * of a `committed` outcome (see that module's own docblock), so this
   * callback firing is itself the guarantee. `daemon.ts` wires this to
   * `publish/on-developer-committed.ts`, gated on `options.forge` being
   * configured; absent here, no forge-aware caller — every earlier plan's
   * `createSupervisor` call site keeps compiling unchanged, mirroring
   * `onRoundBoundary`.
   *
   * `roundId` and `stageId` come from THIS spawn's own `assign` closure, never
   * from the message — the same identity discipline `recordUsage` follows
   * (T-4-38). M05 step 5.11's sticky comment needs both: which round the
   * commit belongs to, and which pipeline entry's `stage_attempts` rows are
   * the developer's. Deriving either from "the feature's latest round" or from
   * a hardcoded `'develop'` would be a second source of truth for something
   * the supervisor already knows exactly.
   */
  readonly onDeveloperCommitted?: (params: {
    readonly feature: FeaturesTable;
    readonly roundId: string;
    readonly stageId: string;
    readonly sha: string;
  }) => void;
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
      ...(deps.workerEnv !== undefined ? { env: deps.workerEnv } : {}),
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

      if (
        message.t === 'heartbeat' ||
        message.t === 'stage_result' ||
        message.t === 'fatal' ||
        message.t === 'usage'
      ) {
        const kind = message.t;
        const leaseToken = message.leaseToken;
        if (kind === 'stage_result') {
          // WR-02: marked synchronously, before any `await` below, so this
          // can never race the child's own `exit` event. The worker sends
          // `stage_result` and then calls `exitNow(0)` with no delay in
          // between (`worker-entry/index.ts`) — if this were set only after
          // the async fence check's `await deps.getCurrentLeaseToken(...)`,
          // the child could exit and the parent's `'exit'` handler could run
          // first, misclassifying an expected exit as unexpected and firing
          // the fast-path `lease_expired` recovery on a feature that
          // actually completed its round cleanly. Marking unconditionally
          // here is still safe if the fence later rejects this message as
          // stale (below): a stale token means some other writer already
          // moved this lease, so suppressing this worker's own fast-path
          // call costs nothing — the reaper's `expectedLeaseToken` guard
          // already treats that case as a no-op.
          expectingExit.set(feature.id, true);
        }
        void (async () => {
          // D-06's message-level fence, run before any repository write, for
          // every lease-scoped kind — not only `stage_result`.
          const current = deps.getCurrentLeaseToken
            ? await deps.getCurrentLeaseToken(feature.id)
            : undefined;

          if (current !== undefined) {
            const verdict = checkFence(feature.id, leaseToken, current);
            if (verdict.kind === 'stale') {
              deps.staleRejectionCounter?.increment(feature.id);
              deps.onStaleMessage?.({
                featureId: feature.id,
                kind,
                presentedToken: verdict.presented,
                currentToken: verdict.current,
              });
              log.warn(
                {
                  presentedToken: verdict.presented,
                  currentToken: verdict.current,
                },
                `dropped a stale '${kind}' message — the presented lease token is no longer current`,
              );
              return;
            }
          }

          if (kind === 'heartbeat') {
            const leaseExpiresAt = new Date(
              Date.parse(message.at) + deps.leaseTtlMs,
            ).toISOString();
            const renewed = await deps.renewLease({
              id: feature.id,
              leaseToken,
              heartbeatAt: message.at,
              leaseExpiresAt,
            });
            if (!renewed) {
              // The row moved between the fence check above and this write
              // (a genuine race, not the common case the fence already
              // caught) — same response either way: tell the worker its
              // lease is gone.
              deps.onStaleMessage?.({
                featureId: feature.id,
                kind,
                presentedToken: leaseToken,
                currentToken: null,
              });
              log.warn(
                { presentedToken: leaseToken },
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
            return;
          }

          if (kind === 'usage') {
            // 04-10, D-06: the identity fields (feature/round/stage-attempt)
            // come from THIS supervisor's own `assign` — captured in this
            // `spawn()` call's closure, never from the message — so a worker
            // cannot attribute spend to a feature it does not hold the lease
            // for (T-4-38). Not deduplicated: a second usage message for one
            // attempt is legitimate (D-14's repair reprompt is a second,
            // separately-categorised event) and a manager that collapsed them
            // would silently under-report exactly the spend 04-10 exists to
            // make visible.
            const usageMessage: UsageMessage = message;
            await deps.recordUsage?.({
              featureId: feature.id,
              roundId: assign.roundId,
              stageAttemptId: assign.stageAttemptId,
              modelId: usageMessage.modelId,
              speed: usageMessage.speed,
              inputTokens: usageMessage.inputTokens,
              outputTokens: usageMessage.outputTokens,
              cacheCreationInputTokens: usageMessage.cacheCreationInputTokens,
              cacheReadInputTokens: usageMessage.cacheReadInputTokens,
              costUsd: usageMessage.costUsd,
              costSource: usageMessage.costSource,
              costCategory: usageMessage.costCategory,
            });
            return;
          }

          if (kind === 'stage_result') {
            // The worker is finishing on its own after a *fence-matched*
            // result — D-04's "expected exit" case. `expectingExit` was
            // already marked synchronously above (WR-02), before this
            // async fence check even started, so the fast path cannot race
            // the child's own exit here.
            deps.onRoundBoundary?.({
              featureId: feature.id,
              leaseToken,
              repoId: feature.repo_id,
            });
            // M05 step 5.10: fire only for a real, committed developer
            // outcome — never for `blocked` or a `stage_error`, and never
            // for an unparseable `verdictJson` (treated as "nothing to
            // publish", not thrown).
            const committedSha = committedShaFromVerdict(message.verdictJson);
            if (committedSha !== undefined) {
              deps.onDeveloperCommitted?.({
                feature,
                roundId: assign.roundId,
                stageId: assign.stageId,
                sha: committedSha,
              });
            }
            // CR-01: a fence-matched stage_result is the one place the
            // manager KNOWS this attempt reached a verdict — `assign` (this
            // spawn() call's own closure) carries the stageAttemptId, never
            // the message itself, mirroring `recordUsage`'s identity source.
            // Without this write, `stage_attempts.ended_at` stays null
            // forever and `GET /stages/:id/logs?follow=1` can never emit
            // `ended` for a real run.
            await deps.closeAttempt?.({
              stageAttemptId: assign.stageAttemptId,
              status: 'verdict',
            });
          }
          if (kind === 'fatal') {
            // A self-reported fatal is a terminal outcome too — the attempt
            // did not produce a verdict, but it is no longer running, and a
            // follower waiting on `ended` deserves to be told so rather than
            // polling `idle` forever. Deliberately NOT marked as an expected
            // exit — a self-reported fatal error is a worker dying just as
            // surely as a SIGKILL, and the fast-path unexpected-exit
            // recovery still runs for it, independently of this write.
            await deps.closeAttempt?.({
              stageAttemptId: assign.stageAttemptId,
              status: 'error',
            });
          }
        })();
      }
      // 'ready' is handled above.
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
