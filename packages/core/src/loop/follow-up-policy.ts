/**
 * LOOP-09 — findings raised after a gate's first look become follow-ups rather
 * than fresh send-backs, so the goalposts cannot move mid-feature (M07 step
 * 7.8).
 *
 * ## The failure this exists to prevent
 *
 * `.planning/research/PITFALLS.md` states it as a rule: *"Findings raised in
 * round 1 are the contract. … New unrelated findings in round 3 are logged as
 * follow-ups on the PR, not send-backs. This single rule kills most
 * goalpost-moving."* An agent reviewer given a fresh look each round has no
 * memory of having been satisfied; left unbounded it produces a new opinion
 * every round and the feature never converges, while each new opinion spends
 * one of `limits.max_rounds`.
 *
 * ## Scoped to a gate's OWN first look, not to round 1
 *
 * M07's acceptance criterion says *"after the first **review** round"*, and the
 * difference is load-bearing. `review` defaults to `on_send_back: stop`
 * (7.2's cost-class table), so in a `['develop', 'test', 'review']` pipeline
 * whose tests fail in round 1, the reviewer never runs until round 2 — and a
 * literal "raised after round 1" rule would make the reviewer's very first
 * opinion non-blocking. The contract is therefore per stage: **the findings a
 * gate raised the first time it judged this feature.**
 *
 * ## Scoped to gates that judge by OPINION, and conservative by construction
 *
 * A deterministic gate raising a *different* finding in round 2 is not moving
 * goalposts — it is reporting that the code is still broken, differently. The
 * built-in command gate proves this is reachable rather than theoretical: its
 * finding title carries the exit code (`command-gate.ts` puts it there so the
 * fingerprint is stable across runs), so `exit 1` in round 1 and `exit 2` in
 * round 2 are two fingerprints. Demoting the second would turn a broken build
 * into a green round.
 *
 * So the policy applies only where the judgement is an opinion, and
 * {@link DEFAULT_JUDGEMENT_KIND} is `deterministic`: a stage this build knows
 * nothing about — every `npm`- and `repo-path`-sourced harness, which is M13's
 * tier, and every plain-command gate — never has its findings demoted. That is
 * the same "conservative side by construction" `onSendBackFor` is written for,
 * and it means an unknown gate can never let a broken build through.
 *
 * ## A demoted `send_back` becomes a `warn`, which is not a new concept
 *
 * `WarnVerdictSchema` already means *"non-blocking observations"*, and
 * `aggregate` already knows what to do with one: a `warn` never produces a
 * `send_back`, and its findings still ride along into the brief when some
 * *other* gate sent the developer back — because "the developer is editing
 * this code anyway and a non-blocking observation is cheapest to act on now"
 * (`aggregate`'s own note). So this module changes one field of one verdict
 * and CORE-02's single enforcement point needs no edit at all.
 *
 * Nothing is ever discarded. The findings stay on the verdict, are persisted
 * with it, and reach the pull request; what changes is that they do not spend
 * a round.
 *
 * Pure, like every module here: the caller supplies the resolved stage and the
 * fingerprint history, and this reads no database, no configuration and no
 * clock. `@adl/manager`'s `loop/follow-up-check.ts` is the other half.
 */
import {
  BUILT_IN_STAGE_IDS,
  type BuiltInStageId,
  type ResolvedStage,
} from '../config/pipeline.js';
import type { Finding } from '../verdict/finding.js';
import type { Verdict } from '../verdict/verdict.js';

/**
 * Whether a gate's verdict is reproducible from the code alone.
 *
 * `deterministic` — the same code always produces the same verdict: a build, a
 * test suite, a linter. A new finding from one of these is new *information*.
 *
 * `opinion` — a model judged, and would not necessarily say the same thing
 * twice. A new finding from one of these may be new information or may be a
 * new opinion, and nothing in the finding distinguishes them.
 */
export type JudgementKind = 'deterministic' | 'opinion';

/**
 * What a stage this build knows nothing about is assumed to be.
 *
 * `deterministic`, so its findings are never demoted and it keeps pre-7.8
 * behaviour exactly. The alternative — guessing `opinion` — would let a
 * third-party gate ADL has never seen report a *new* failure in round 2 and
 * have ADL quietly decide it does not count.
 */
export const DEFAULT_JUDGEMENT_KIND: JudgementKind = 'deterministic';

/**
 * What each built-in stage judges by.
 *
 * `develop` is here for completeness rather than use — index 0 is the mutator
 * and produces a `DeveloperOutcome`, not a verdict, so no verdict policy ever
 * applies to it. `test` runs `adl.yml`'s test command and `review` is an agent
 * (M07 step 7.4), which is exactly the distinction this type draws.
 *
 * Machine-checked against the frozen `BUILT_IN_STAGE_IDS` below, so a fourth
 * built-in fails the **build** rather than silently inheriting
 * {@link DEFAULT_JUDGEMENT_KIND} — the same pairing `BUILT_IN_COST_CLASSES`
 * carries (convention 7).
 */
const BUILT_IN_JUDGEMENT_KINDS = Object.freeze({
  develop: 'deterministic',
  review: 'opinion',
  test: 'deterministic',
}) satisfies Record<BuiltInStageId, JudgementKind>;

/** Compile-time proof the map above covers `BUILT_IN_STAGE_IDS`. */
type _EveryBuiltInClassified =
  Exclude<
    (typeof BUILT_IN_STAGE_IDS)[number],
    keyof typeof BUILT_IN_JUDGEMENT_KINDS
  > extends never
    ? true
    : never;
const _everyBuiltInClassified: _EveryBuiltInClassified = true;
void _everyBuiltInClassified;

/**
 * How this stage judges — a built-in's declared kind, or
 * {@link DEFAULT_JUDGEMENT_KIND} for anything else.
 *
 * Keyed on the resolved stage's `source` as well as its id, for `costClassOf`'s
 * reason: a repo-path harness that happens to be *named* `review` must not
 * inherit the built-in reviewer's classification. A pipeline entry's id is
 * chosen by whoever wrote `adl.yml`; only `source: 'built-in'` means ADL
 * supplied it.
 *
 * Deliberately **not** configurable from `adl.yml`. `on_send_back` is a
 * pipeline-shape decision a maintainer legitimately owns; this is a claim
 * about whether a program is reproducible, which a maintainer declaring
 * `judgement: opinion` on their own test suite could only get wrong.
 */
export function judgementKindOf(stage: ResolvedStage): JudgementKind {
  if (stage.source !== 'built-in') return DEFAULT_JUDGEMENT_KIND;
  return (
    BUILT_IN_JUDGEMENT_KINDS[stage.id as BuiltInStageId] ??
    DEFAULT_JUDGEMENT_KIND
  );
}

export interface FollowUpPolicyInput {
  /** The verdict this gate just returned. Only `send_back` is ever changed. */
  readonly verdict: Verdict;
  /** The pipeline entry that produced it, already resolved by the caller. */
  readonly stage: ResolvedStage;
  /**
   * Whether this is the first round in which **this stage** judged this
   * feature. Its first look sets the contract, so nothing in it is ever a
   * follow-up.
   */
  readonly isFirstJudgingRound: boolean;
  /**
   * The fingerprints this stage raised in that first judging round — the
   * contract. Read from the database by the caller; empty when the gate's
   * first look raised nothing, which is the honest answer and not a reason to
   * skip the policy.
   */
  readonly contractFingerprints: ReadonlySet<string>;
}

export interface FollowUpDecision {
  /**
   * What the round should be decided on: the input verdict unchanged, or the
   * same verdict with `send_back` demoted to `warn`. Never a verdict with
   * fewer findings — nothing is discarded.
   */
  readonly verdict: Verdict;
  /**
   * The findings this stage raised for the first time after its first look.
   *
   * Reported even when the verdict was **not** demoted (because at least one
   * contract finding is still open), so the caller can label them on the pull
   * request either way. Empty means the policy changed nothing.
   */
  readonly followUps: readonly Finding[];
  /** Whether {@link FollowUpDecision.verdict} differs from the input. */
  readonly demoted: boolean;
}

/** Everything unchanged — the answer for every case the policy does not touch. */
function unchanged(verdict: Verdict): FollowUpDecision {
  return { verdict, followUps: [], demoted: false };
}

/**
 * Decide which of a gate's findings are follow-ups, and whether that leaves it
 * with nothing to send the developer back for.
 *
 * Total and never throws. The verdict is returned unchanged unless **all** of:
 *
 * - its outcome is `send_back` — the only outcome that spends a round;
 * - the stage judges by `opinion`;
 * - this is not the stage's first judging round; and
 * - not one of its findings is in the contract.
 *
 * The last condition is what keeps a partially-fixed feature honest: a round
 * that still carries an original finding is still a send-back, and the new
 * observations ride along in the same brief rather than being held back for a
 * pull request the developer has not reached yet.
 */
export function applyFollowUpPolicy(
  input: FollowUpPolicyInput,
): FollowUpDecision {
  const { verdict } = input;
  if (verdict.outcome !== 'send_back') return unchanged(verdict);
  if (judgementKindOf(input.stage) !== 'opinion') return unchanged(verdict);
  if (input.isFirstJudgingRound) return unchanged(verdict);

  const followUps = verdict.findings.filter(
    (finding) => !input.contractFingerprints.has(finding.fingerprint),
  );
  if (followUps.length === 0) return unchanged(verdict);
  if (followUps.length < verdict.findings.length) {
    // At least one contract finding is still open, so the developer is going
    // back regardless. Report the new ones so the caller can label them, and
    // leave the verdict alone — `aggregate` puts every finding in the brief,
    // which is what the developer wants when they are editing this code
    // anyway.
    return { verdict, followUps, demoted: false };
  }

  // Every finding is new. There is nothing left of the contract to send the
  // developer back for, so this gate has no claim on a round.
  return {
    verdict: {
      outcome: 'warn',
      summary: verdict.summary,
      findings: verdict.findings,
    },
    followUps,
    demoted: true,
  };
}
