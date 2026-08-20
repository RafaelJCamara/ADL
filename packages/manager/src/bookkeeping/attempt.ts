import { ulid } from 'ulid';
import type { Kysely } from 'kysely';
import {
  featuresRepository,
  nowIso,
  verdictsRepository,
  type Database,
} from '@adl/db';

/**
 * The one place a round and a stage attempt are opened and closed (04-04
 * Task 2).
 *
 * `rounds` and `stage_attempts` have existed in the schema since Phase 1
 * (`0002_contracts.ts`) with no writer. Both the transcript file path
 * (`logs/<feature>/<round>/<stage>/<attempt>.ndjson`, 04-08) and
 * `usage_events`'s `round_id`/`stage_attempt_id` columns (04-10) address
 * through these two tables, so every agent invocation needs a real row in
 * each before it starts — synthesising an id anywhere else would give the
 * transcript path and the spend ledger join keys that resolve to nothing.
 *
 * A module of functions taking dependencies as parameters, following
 * `scheduler/dispatcher.ts` and the `@adl/db` repository factories — this
 * repository has no service classes, and neither does this package's own
 * bookkeeping.
 *
 * Nothing here writes a verdict, a finding, or a usage event. Verdicts
 * belong to the loop (Phase 5) and usage to 04-10; this module owns the two
 * rows those things join on and nothing more.
 */

export interface AttemptDeps {
  readonly db: Kysely<Database>;
  /** Defaults to `nowIso`. Injectable so a test can control the timestamp. */
  readonly now?: () => string;
}

export interface OpenAttemptInput {
  readonly featureId: string;
  readonly stageId: string;
  readonly stageIndex: number;
}

/**
 * Everything a caller needs to build a transcript path and attribute usage,
 * without a second database round trip.
 */
export interface OpenAttempt {
  readonly roundId: string;
  readonly roundNumber: number;
  readonly stageAttemptId: string;
  readonly stageId: string;
  readonly stageIndex: number;
  /** 1-based ordinal within `(roundId, stageIndex)`. D-13's repair reprompt is a second attempt, visible in history. */
  readonly attempt: number;
}

/**
 * Open a round (reusing one already in flight) and a stage attempt, in one
 * transaction.
 *
 * One transaction, not two calls, for the reason `recordVerdict`'s own
 * docblock gives about verdicts and their citations: a round row with no
 * attempt, or an attempt whose round vanished, is a state the reader cannot
 * interpret, and a partial write is how it would come to exist.
 *
 * Round selection: the feature's open round (a `rounds` row with a null
 * `outcome`) is reused; if none is open, a new one is inserted, numbered one
 * past the highest existing round for the feature. Because `rounds` carries
 * a `unique (feature_id, number)` constraint and every write here goes
 * through this one transaction on the manager's single connection (the
 * manager is the sole writer, T-4-17), two concurrent calls for the same
 * feature cannot both mint round number 1 — the loser's insert would
 * violate the constraint, and Kysely's transaction wrapper rolls the whole
 * attempt back rather than leaving a stage attempt with no round.
 *
 * Attempt ordinal: one past the highest existing `attempt` for
 * `(round_id, stage_index)` — not `stage_id` — matching `stage_attempts`'s
 * own `unique (round_id, stage_index, attempt)` constraint. A repair
 * reprompt (D-13) is therefore a second row in history, never an overwrite
 * of the first.
 */
export async function openAttempt(
  deps: AttemptDeps,
  input: OpenAttemptInput,
): Promise<OpenAttempt> {
  const at = (deps.now ?? nowIso)();

  return deps.db.transaction().execute(async (trx) => {
    const featuresRepo = featuresRepository(trx);

    // The feature's highest-numbered round is its open one, if any — a new
    // round is never opened while the previous one is still running.
    const latest = await featuresRepo.latestRound(input.featureId);
    const openRound =
      latest !== undefined && latest.outcome === null ? latest : undefined;

    const round =
      openRound ??
      (await (async () => {
        const roundId = ulid();
        const roundNumber = (latest?.number ?? 0) + 1;
        await featuresRepo.insertRound({
          id: roundId,
          feature_id: input.featureId,
          number: roundNumber,
          outcome: null,
          outcome_json: null,
          started_at: at,
          ended_at: null,
        });
        return { id: roundId, number: roundNumber };
      })());

    const highestAttempt = await trx
      .selectFrom('stage_attempts')
      .select('attempt')
      .where('round_id', '=', round.id)
      .where('stage_index', '=', input.stageIndex)
      .orderBy('attempt', 'desc')
      .limit(1)
      .executeTakeFirst();
    const attempt = (highestAttempt?.attempt ?? 0) + 1;

    const stageAttemptId = ulid();
    await verdictsRepository(trx).insertStageAttempt({
      id: stageAttemptId,
      round_id: round.id,
      stage_id: input.stageId,
      stage_index: input.stageIndex,
      attempt,
      status: 'running',
      error_kind: null,
      error_retryable: null,
      error_raw_ref: null,
      started_at: at,
      ended_at: null,
    });

    return {
      roundId: round.id,
      roundNumber: round.number,
      stageAttemptId,
      stageId: input.stageId,
      stageIndex: input.stageIndex,
      attempt,
    };
  });
}

/** The `stage_attempts.status` values that end an attempt — `'running'` is the only non-terminal one. */
export type TerminalAttemptStatus = 'verdict' | 'error';

export interface CloseAttemptInput {
  readonly stageAttemptId: string;
  readonly status: TerminalAttemptStatus;
}

/**
 * Record the terminal status and `ended_at` for a stage attempt.
 *
 * Idempotent by construction: the `UPDATE` is guarded by
 * `ended_at is null`, so a worker that crashes after reporting and a reaper
 * that closes the same attempt are both ordinary — the second write matches
 * zero rows and is a no-op, following `ScratchHomeTeardown` and
 * `destroy()`'s already-established "second call, no error" discipline
 * elsewhere in this codebase.
 *
 * This function does **not** close the round; the round's outcome belongs
 * to the loop, which is Phase 5.
 */
export async function closeAttempt(
  deps: AttemptDeps,
  input: CloseAttemptInput,
): Promise<void> {
  const at = (deps.now ?? nowIso)();
  await deps.db
    .updateTable('stage_attempts')
    .set({ status: input.status, ended_at: at })
    .where('id', '=', input.stageAttemptId)
    .where('ended_at', 'is', null)
    .execute();
}

/** What a stage attempt id resolves to: exactly one feature, round, and stage. */
export interface AttemptAddress {
  readonly featureId: string;
  readonly roundId: string;
  readonly stageId: string;
  readonly stageIndex: number;
  readonly attempt: number;
}

/**
 * Resolve a stage attempt id to the feature, round, and stage it addresses —
 * the DB-backed resolution `04-RESEARCH.md`'s security section requires.
 *
 * The transcript route (04-08) receives an attempt id from an untrusted HTTP
 * path parameter; building a filesystem path from that parameter directly is
 * a traversal (T-4-15). Every path-building caller in this phase goes
 * through this function instead, joining `stage_attempts` to `rounds` and
 * returning a record assembled from database columns — never from the
 * supplied string. An unknown id resolves to `undefined`, never a throw and
 * never a partially-populated record, so a caller cannot compose a plausible
 * path out of a lookup that found nothing.
 */
export async function findAttempt(
  db: Kysely<Database>,
  stageAttemptId: string,
): Promise<AttemptAddress | undefined> {
  const row = await db
    .selectFrom('stage_attempts')
    .innerJoin('rounds', 'rounds.id', 'stage_attempts.round_id')
    .select([
      'rounds.feature_id as featureId',
      'stage_attempts.round_id as roundId',
      'stage_attempts.stage_id as stageId',
      'stage_attempts.stage_index as stageIndex',
      'stage_attempts.attempt as attempt',
    ])
    .where('stage_attempts.id', '=', stageAttemptId)
    .executeTakeFirst();

  return row;
}
