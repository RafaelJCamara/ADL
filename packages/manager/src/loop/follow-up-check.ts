/**
 * `checkFollowUps` — the database half of LOOP-09 (M07 step 7.8).
 *
 * `@adl/core/loop`'s `applyFollowUpPolicy` is pure and decides from a
 * fingerprint contract it is handed; it reads no database. This module is what
 * hands it one: given the verdict a gate just returned, read every verdict that
 * **stage** has produced for this feature, work out which round was its first
 * look and what it raised there, and run the pure policy.
 *
 * Shaped after `stalemate-check.ts` deliberately — same package, same pairing
 * with a pure `@adl/core/loop` module, same never-fail-open result type.
 *
 * ## Why the history is read BEFORE the verdict is recorded
 *
 * This is the one place in `round-runner.ts` that inverts its usual "evidence
 * first, state second" ordering, and the inversion is the point.
 * `checkStalemate` asks *"how many rounds has this finding recurred in,
 * including now?"*, so it wants this round's verdict already written.
 * `checkFollowUps` asks the opposite question — *"what did this gate say
 * BEFORE this round?"* — and a history that already contained this round's
 * findings would report every one of them as part of the contract, which is
 * the policy never firing at all.
 *
 * The two orderings are not in tension because they are two different reads.
 * `round-runner.ts` reads this history first, applies the policy, records the
 * **resulting** verdict, and only then runs the stalemate check — so what
 * lands in `verdicts.outcome` is what ADL actually acted on, and the pull
 * request rendered from those rows says the same thing the audit trail does.
 *
 * ## Never fails open
 *
 * A database read that failed is reported as `'error'`, never as "no
 * follow-ups". Silently treating an infrastructure failure as "the policy does
 * not apply" would be the safe direction here — the verdict stays a
 * `send_back` — but reporting it lets the caller route it through the same
 * retry path a transient stage failure takes rather than quietly spending a
 * round on a decision ADL could not make (CORE-06). That is the same discipline
 * `checkStalemate` and `checkProtectedPaths` hold themselves to.
 */
import type { Kysely } from 'kysely';
import { verdictsRepository, type Database } from '@adl/db';
import { applyFollowUpPolicy, type FollowUpDecision } from '@adl/core/loop';
import type { ResolvedStage } from '@adl/core/config';
import type { Verdict } from '@adl/core/verdict';

export type FollowUpCheckResult =
  /** The policy ran. `decision.demoted` says whether it changed anything. */
  | { readonly kind: 'decided'; readonly decision: FollowUpDecision }
  /**
   * The history could not be read, so the policy could not run. Never
   * "decided": see the module docblock.
   */
  | { readonly kind: 'error'; readonly detail: string };

export interface CheckFollowUpsDeps {
  readonly db: Kysely<Database>;
}

export interface CheckFollowUpsParams {
  readonly featureId: string;
  /** The stage that just judged — the id `stage_attempts.stage_id` carries. */
  readonly stageId: string;
  /** That stage, resolved from the snapshotted pipeline, so its judgement kind can be read. */
  readonly stage: ResolvedStage;
  /**
   * The round this verdict belongs to, **by id**.
   *
   * By id rather than by ordinal deliberately: `rounds.number` is derived from
   * the previous round's number (`bookkeeping/attempt.ts`) while
   * `features.round` is moved by `transition()`, so the two are two answers to
   * one question and an ordinal read from the wrong one would exclude the wrong
   * round. That is not a hypothetical — `docs/plan/DEBT.md`'s **D-5-13-2**
   * records the two as *"silently one apart"*, and it is still open. The id is
   * the round's identity and this module already has it.
   */
  readonly roundId: string;
  /** The verdict the gate returned, before any policy is applied to it. */
  readonly verdict: Verdict;
}

/**
 * Which of this gate's findings are follow-ups, and does that leave it with
 * nothing to send the developer back for?
 *
 * Never throws.
 */
export async function checkFollowUps(
  deps: CheckFollowUpsDeps,
  params: CheckFollowUpsParams,
): Promise<FollowUpCheckResult> {
  let history;
  try {
    history = await verdictsRepository(deps.db).stageJudgementHistory(
      params.featureId,
      params.stageId,
    );
  } catch (error) {
    return {
      kind: 'error',
      detail:
        `could not read the ${params.stageId} stage's judgement history for ` +
        `feature ${params.featureId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Every round but this one. A verdict this stage already wrote for the
  // CURRENT round — a re-dispatch after a crash, say — must not become part of
  // its own contract, which would make every finding blocking and the policy a
  // no-op exactly when it matters.
  const priorRounds = history.filter((row) => row.round_id !== params.roundId);
  const firstJudgingRound =
    priorRounds.length === 0
      ? undefined
      : Math.min(...priorRounds.map((row) => row.round_number));

  const decision = applyFollowUpPolicy({
    verdict: params.verdict,
    stage: params.stage,
    // No earlier round carries a verdict from this stage, so this round is its
    // first look and sets the contract.
    isFirstJudgingRound: firstJudgingRound === undefined,
    contractFingerprints: new Set(
      priorRounds
        .filter((row) => row.round_number === firstJudgingRound)
        .flatMap((row) => (row.fingerprint === null ? [] : [row.fingerprint])),
    ),
  });

  return { kind: 'decided', decision };
}
