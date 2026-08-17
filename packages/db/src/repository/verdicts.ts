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
