import type { Finding } from '../verdict/finding.js';

/**
 * Stalemate detection over repeated finding fingerprints (LOOP-06, M06 step
 * 6.6) — the pure half, sibling to {@link violatedProtectedPaths}.
 *
 * `fingerprintFinding` (`@adl/core/verdict`) is the stall-detection key —
 * "two rounds producing the same fingerprint means the developer did not
 * move the gate," per that function's own docblock — and
 * `limits.repeat_finding_threshold` already exists in `adl.yml`'s schema.
 * What was missing is the thing that counts: a fingerprint recurring across
 * a feature's round history, not asked about, but read off recorded state —
 * the same "detected by evaluating state, not by asking" discipline ROLE-11's
 * protected-path check already holds itself to.
 *
 * This module reads no database and no git history itself. `@adl/manager`'s
 * `loop/stalemate-check.ts` is the half that counts how many distinct rounds
 * each fingerprint has already been raised in and hands the result here.
 */

/** One of this round's `send_back` findings, and how many rounds have now raised it. */
export interface StalledFinding {
  readonly finding: Finding;
  /**
   * How many distinct rounds have raised this exact fingerprint, **including
   * this one** — the caller's fingerprint-count read is taken after this
   * round's own findings are already recorded, so the count is already
   * final, not one short of it.
   */
  readonly occurrences: number;
}

export interface DetectStalemateInput {
  /** This round's gate's own `send_back` findings — the only outcome that carries any (CORE-01). */
  readonly currentFindings: readonly Finding[];
  /**
   * How many distinct rounds each fingerprint has been raised in across this
   * feature's whole history, **including the current round** — the caller's
   * read, taken after this round's findings were recorded. A fingerprint
   * absent from the map has occurred zero times, never assumed present.
   */
  readonly fingerprintCounts: ReadonlyMap<string, number>;
  /** `EffectiveConfig.limits.repeat_finding_threshold` this feature was leased under. */
  readonly threshold: number;
}

/**
 * Which of this round's findings have now recurred `threshold` times or
 * more, across the feature's round history.
 *
 * Empty means no stalemate. Order-preserving over `currentFindings`, and
 * de-duplicated by fingerprint — a gate that lists the identical finding
 * twice in one round's own output must not inflate the reported count
 * beyond what actually happened.
 */
export function detectStalemate(
  input: DetectStalemateInput,
): readonly StalledFinding[] {
  const { currentFindings, fingerprintCounts, threshold } = input;
  const seen = new Set<string>();
  const stalled: StalledFinding[] = [];

  for (const finding of currentFindings) {
    if (seen.has(finding.fingerprint)) continue;
    seen.add(finding.fingerprint);

    const occurrences = fingerprintCounts.get(finding.fingerprint) ?? 0;
    if (occurrences >= threshold) {
      stalled.push({ finding, occurrences });
    }
  }

  return stalled;
}
