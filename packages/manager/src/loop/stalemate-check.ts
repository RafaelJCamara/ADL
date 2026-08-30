/**
 * `checkStalemate` — the database half of LOOP-06 (M06 step 6.6).
 *
 * `@adl/core/loop`'s `detectStalemate` is pure and classifies a fingerprint
 * count it is handed; it reads no database. This module is what hands it
 * one: given the findings a gate's `send_back` just raised, read how many
 * distinct rounds this feature has already raised each of them in and run
 * the pure check — entirely inside the manager, never a worker.
 *
 * ## Why this runs in the manager, at the same point ROLE-11 runs
 *
 * `round-runner.ts`'s `checkProtectedPaths` call already established the
 * shape this follows: detected by evaluating recorded state, not by asking
 * the agent, and fired before `planRoundStep` ever decides the round —
 * because by the time `planRoundStep` has aggregated a `send_back` into a
 * round outcome, the decision is already "send the developer back again",
 * and a stalemate is precisely the case where doing that one more time
 * would not help.
 *
 * ## Why the count is read after the verdict is recorded
 *
 * `round-runner.ts` records this round's gate verdict and findings
 * (`recordGateVerdict`) before it ever computes a `RoundStep` — "evidence
 * first, state second", the same ordering `checkProtectedPaths`'s own
 * caller holds itself to. That means by the time this module reads
 * `fingerprintCountsForFeature`, this round's own findings are already
 * counted in it: a fingerprint's occurrence count already includes the
 * current round, so `detectStalemate` needs no separate "+1 for this
 * round" adjustment.
 */
import type { Kysely } from 'kysely';
import { verdictsRepository, type Database } from '@adl/db';
import { detectStalemate, type StalledFinding } from '@adl/core/loop';
import type { Finding } from '@adl/core/verdict';

export type StalemateCheckResult =
  /** Nothing this round's findings raised has recurred often enough to matter. */
  | { readonly kind: 'clean' }
  /** At least one finding has now recurred `threshold` times or more. */
  | { readonly kind: 'stalled'; readonly findings: readonly StalledFinding[] }
  /**
   * The check itself could not run — a database read failed. Never
   * "clean": an infrastructure failure that silently passed as "no
   * stalemate" would be the exact fail-open bug this check exists to
   * prevent (CORE-06), the same discipline `checkProtectedPaths` holds
   * itself to.
   */
  | { readonly kind: 'error'; readonly detail: string };

export interface CheckStalemateDeps {
  readonly db: Kysely<Database>;
}

export interface CheckStalemateParams {
  readonly featureId: string;
  /** This round's `send_back` findings — the only outcome that carries any (CORE-01). */
  readonly currentFindings: readonly Finding[];
  /** `EffectiveConfig.limits.repeat_finding_threshold` this feature was leased under. */
  readonly threshold: number;
}

/**
 * Has this round's `send_back` recurred often enough to be a stalemate
 * rather than progress?
 *
 * Never throws — a failure to even read the fingerprint history is
 * reported as `'error'` so the caller can route it through the same retry
 * path a transient stage failure already takes, rather than either
 * silently passing the round or spending one of its finite rounds on an
 * infrastructure problem (CORE-06).
 */
export async function checkStalemate(
  deps: CheckStalemateDeps,
  params: CheckStalemateParams,
): Promise<StalemateCheckResult> {
  let fingerprintCounts: ReadonlyMap<string, number>;
  try {
    fingerprintCounts = await verdictsRepository(
      deps.db,
    ).fingerprintCountsForFeature(params.featureId);
  } catch (error) {
    return {
      kind: 'error',
      detail: `could not read this feature's fingerprint history: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const stalled = detectStalemate({
    currentFindings: params.currentFindings,
    fingerprintCounts,
    threshold: params.threshold,
  });

  return stalled.length === 0
    ? { kind: 'clean' }
    : { kind: 'stalled', findings: stalled };
}
