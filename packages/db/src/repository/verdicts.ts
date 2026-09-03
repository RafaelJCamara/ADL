import type { Kysely } from 'kysely';
import type {
  Database,
  FindingsTable,
  StageAttemptsTable,
  VerdictCheckedCriteriaTable,
  VerdictsTable,
  WaiversTable,
} from '../schema.js';

/**
 * Stage attempts, verdicts, findings, and waivers.
 *
 * The one query worth naming is {@link VerdictsRepository.coverage}: it answers
 * "which acceptance criteria did a passing gate actually cite?" as a join over
 * `verdict_checked_criteria`. That question is FORGE-08's coverage table and
 * D-11's reason for requiring non-empty cited coverage — and it is the reason
 * `verdicts` is a table rather than a JSON column on the attempt. As a blob it
 * would be a scan over every stored verdict, parsed in application code, on
 * every pull-request render.
 */

export type NewStageAttempt = StageAttemptsTable;
export type NewVerdict = VerdictsTable;
export type NewCheckedCriterion = VerdictCheckedCriteriaTable;
export type NewFinding = FindingsTable;
export type NewWaiver = WaiversTable;

/** One criterion a passing gate cited, with the gate that cited it. */
export interface CoverageRow {
  criterion_id: string | null;
  global_category: string | null;
  ref_kind: string;
  stage_id: string;
}

/**
 * One finished stage attempt, newest-first, as LOOP-07's consecutive-failure
 * count reads it (M06 step 6.7).
 *
 * `error_kind` is returned **uninterpreted**. Whether a kind is transient is
 * `@adl/core`'s `isTransientStageErrorKind` to answer, and `@adl/db` depends on
 * `@adl/core` for types only — classifying here would put a runtime dependency
 * on the vocabulary package into the one package that must not have one.
 */
export interface RecentStageAttempt {
  /** `'verdict'` when the attempt judged, `'error'` when it broke. */
  status: string;
  /** The `StageErrorKind` the attempt reported, as a bare string. Null unless it errored. */
  error_kind: string | null;
  /** When the attempt finished — the instant LOOP-07's backoff window is measured from. */
  ended_at: string | null;
}

/**
 * One finding one stage raised in one round, as LOOP-09's follow-up policy
 * reads it (M07 step 7.8).
 *
 * A LEFT JOIN, so a verdict that raised **no** findings still produces a row
 * with `fingerprint: null`. That is not a curiosity — it is the row that says
 * "this stage judged in this round", which is how "has this gate looked at
 * this feature before?" is answered for a gate whose first look was a `pass`.
 * A plain INNER JOIN would report such a gate as never having judged, and its
 * first send-back three rounds later would be treated as a later look.
 */
export interface StageJudgementRow {
  /** `rounds.id`, so a caller can exclude the round it is currently deciding without knowing its ordinal. */
  round_id: string;
  /** `rounds.number` — 1 for the first round of a feature. Used to order rounds, never to identify one. */
  round_number: number;
  /** The fingerprint raised, or null when that verdict raised none. */
  fingerprint: string | null;
}

export interface VerdictsRepository {
  insertStageAttempt(attempt: NewStageAttempt): Promise<void>;
  /**
   * Record a verdict and its cited criteria together.
   *
   * One transaction, because a verdict whose citations are missing reads as a
   * pass that cited nothing — which D-11 classifies as malformed rather than
   * as an approval. A partial write would manufacture exactly that state.
   */
  recordVerdict(input: {
    verdict: NewVerdict;
    checked?: readonly NewCheckedCriterion[];
    findings?: readonly NewFinding[];
  }): Promise<void>;
  findByStageAttempt(
    stageAttemptId: string,
  ): Promise<VerdictsTable | undefined>;
  listFindings(verdictId: string): Promise<FindingsTable[]>;
  /** Fingerprints raised anywhere in a round — LOOP-06's stall-detection input. */
  fingerprintsForRound(roundId: string): Promise<string[]>;
  /**
   * How many distinct rounds each fingerprint has been raised in, across one
   * feature's whole round history (LOOP-06, M06 step 6.6) — the same input
   * `fingerprintsForRound` was already built for, pivoted across every round
   * a feature has run rather than read one round at a time. A fingerprint
   * absent from the map has never been raised; the caller supplies that
   * default rather than this method inventing a zero entry for every
   * fingerprint that has never existed.
   */
  fingerprintCountsForFeature(
    featureId: string,
  ): Promise<ReadonlyMap<string, number>>;
  /**
   * The most recently finished stage attempts for one feature, newest first
   * (LOOP-07, M06 step 6.7) — the history a consecutive-transient-failure
   * count is read off.
   *
   * Bounded by `limit` because the only question asked of it is "how many of
   * the most recent attempts in a row broke transiently", and that is decided
   * by at most `ceiling + 1` rows. Unfinished attempts (`ended_at is null`)
   * are excluded: an attempt still in flight has not reported anything yet,
   * and counting it would count the future.
   */
  recentStageAttemptsForFeature(
    featureId: string,
    limit: number,
  ): Promise<RecentStageAttempt[]>;
  /**
   * Every verdict one **stage** produced for one feature, with the findings it
   * raised and the round it raised them in (LOOP-09, M07 step 7.8).
   *
   * Scoped to a stage id rather than to the whole feature because the contract
   * LOOP-09 freezes is per gate: `review` defaults to `on_send_back: stop`, so
   * in a pipeline whose tests fail first the reviewer may not run until round 2
   * — and its first opinion must not be treated as a late one.
   *
   * Returns rows rather than a computed answer for `recentStageAttemptsForFeature`'s
   * reason: deciding what the rows *mean* is `@adl/core/loop`'s
   * `applyFollowUpPolicy`, and this package depends on `@adl/core` for types
   * only.
   */
  stageJudgementHistory(
    featureId: string,
    stageId: string,
  ): Promise<StageJudgementRow[]>;
  /** The cited coverage of every passing verdict in a round. */
  coverage(roundId: string): Promise<CoverageRow[]>;
  insertWaiver(waiver: NewWaiver): Promise<void>;
  listWaivers(featureId: string): Promise<WaiversTable[]>;
}

export function verdictsRepository(db: Kysely<Database>): VerdictsRepository {
  return {
    async insertStageAttempt(attempt) {
      await db.insertInto('stage_attempts').values(attempt).execute();
    },

    async recordVerdict({ verdict, checked, findings }) {
      await db.transaction().execute(async (trx) => {
        await trx.insertInto('verdicts').values(verdict).execute();
        if (checked && checked.length > 0) {
          await trx
            .insertInto('verdict_checked_criteria')
            .values([...checked])
            .execute();
        }
        if (findings && findings.length > 0) {
          await trx
            .insertInto('findings')
            .values([...findings])
            .execute();
        }
      });
    },

    findByStageAttempt(stageAttemptId) {
      return db
        .selectFrom('verdicts')
        .selectAll()
        .where('stage_attempt_id', '=', stageAttemptId)
        .executeTakeFirst();
    },

    listFindings(verdictId) {
      return db
        .selectFrom('findings')
        .selectAll()
        .where('verdict_id', '=', verdictId)
        .orderBy('fingerprint')
        .execute();
    },

    async fingerprintsForRound(roundId) {
      const rows = await db
        .selectFrom('findings')
        .innerJoin('verdicts', 'verdicts.id', 'findings.verdict_id')
        .innerJoin(
          'stage_attempts',
          'stage_attempts.id',
          'verdicts.stage_attempt_id',
        )
        .select('findings.fingerprint')
        .where('stage_attempts.round_id', '=', roundId)
        .orderBy('findings.fingerprint')
        .execute();
      return rows.map((r) => r.fingerprint);
    },

    async stageJudgementHistory(featureId, stageId) {
      const rows = await db
        .selectFrom('verdicts')
        .innerJoin(
          'stage_attempts',
          'stage_attempts.id',
          'verdicts.stage_attempt_id',
        )
        .innerJoin('rounds', 'rounds.id', 'stage_attempts.round_id')
        // LEFT, so a verdict that raised no findings still reports its round.
        // See `StageJudgementRow` for why that row is load-bearing.
        .leftJoin('findings', 'findings.verdict_id', 'verdicts.id')
        .select([
          'rounds.id as round_id',
          'rounds.number as round_number',
          'findings.fingerprint',
        ])
        .where('rounds.feature_id', '=', featureId)
        .where('stage_attempts.stage_id', '=', stageId)
        .orderBy('rounds.number')
        .execute();
      return rows;
    },

    async fingerprintCountsForFeature(featureId) {
      // Distinct (fingerprint, round) pairs — a gate that lists the same
      // finding twice within one round's own output must not inflate that
      // round's contribution to the count beyond "raised in this round".
      const rows = await db
        .selectFrom('findings')
        .innerJoin('verdicts', 'verdicts.id', 'findings.verdict_id')
        .innerJoin(
          'stage_attempts',
          'stage_attempts.id',
          'verdicts.stage_attempt_id',
        )
        .innerJoin('rounds', 'rounds.id', 'stage_attempts.round_id')
        .select(['findings.fingerprint', 'rounds.id as roundId'])
        .distinct()
        .where('rounds.feature_id', '=', featureId)
        .execute();

      const counts = new Map<string, number>();
      for (const row of rows) {
        counts.set(row.fingerprint, (counts.get(row.fingerprint) ?? 0) + 1);
      }
      return counts;
    },

    recentStageAttemptsForFeature(featureId, limit) {
      // Ordered by the attempt's own ULID, not by `ended_at`: a ULID is
      // lexicographically sortable by creation time (D-17's own reason for
      // choosing it as the primary key), and it is total where `ended_at`
      // is a text timestamp two attempts inside the same millisecond can
      // tie on. "Newest first" has to be a strict order or "consecutive"
      // is not well defined.
      return db
        .selectFrom('stage_attempts')
        .innerJoin('rounds', 'rounds.id', 'stage_attempts.round_id')
        .select([
          'stage_attempts.status',
          'stage_attempts.error_kind',
          'stage_attempts.ended_at',
        ])
        .where('rounds.feature_id', '=', featureId)
        .where('stage_attempts.ended_at', 'is not', null)
        .orderBy('stage_attempts.id', 'desc')
        .limit(limit)
        .execute();
    },

    coverage(roundId) {
      return (
        db
          .selectFrom('verdict_checked_criteria')
          .innerJoin(
            'verdicts',
            'verdicts.id',
            'verdict_checked_criteria.verdict_id',
          )
          .innerJoin(
            'stage_attempts',
            'stage_attempts.id',
            'verdicts.stage_attempt_id',
          )
          .select([
            'verdict_checked_criteria.criterion_id',
            'verdict_checked_criteria.global_category',
            'verdict_checked_criteria.ref_kind',
            'stage_attempts.stage_id',
          ])
          .where('stage_attempts.round_id', '=', roundId)
          // Only a `pass` cites coverage. A `skip` — waived or not — is a
          // recorded absence of judgement and must never render as coverage.
          .where('verdicts.outcome', '=', 'pass')
          .orderBy('verdict_checked_criteria.verdict_id')
          .orderBy('verdict_checked_criteria.position')
          .execute()
      );
    },

    async insertWaiver(waiver) {
      await db.insertInto('waivers').values(waiver).execute();
    },

    listWaivers(featureId) {
      return db
        .selectFrom('waivers')
        .selectAll()
        .where('feature_id', '=', featureId)
        .orderBy('at')
        .execute();
    },
  };
}
