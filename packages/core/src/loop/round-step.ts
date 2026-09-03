import type { OnSendBack } from '../config/adl-yml.js';
import type { DeveloperOutcome } from '../stage/developer-outcome.js';
import { stageErrorPolicy, type StageError } from '../stage/stage-error.js';
import type { FeatureEvent } from '../state/feature-state.js';
import { aggregate } from '../verdict/aggregate.js';
import type { RoundOutcome } from '../verdict/round-outcome.js';
import type { Verdict } from '../verdict/verdict.js';

/**
 * `planRoundStep` — the round loop's decision, as a pure function (LOOP-01,
 * M05 step 5.13).
 *
 * One stage of the snapshotted pipeline has just finished and reported
 * something. This module answers the only two questions that follow: **which
 * lifecycle events does that raise**, and **is the round over — and with what
 * {@link RoundOutcome}**. It performs no I/O, reads no clock, and touches no
 * database; `@adl/manager`'s `loop/round-runner.ts` is the half that persists
 * the answer.
 *
 * ## What this module deliberately does not do
 *
 * It **does not decide the next state.** `state/transition.ts` is the only
 * code allowed to do that, and it stays the only code allowed to: this
 * function emits {@link FeatureEvent}s and the caller feeds them to
 * `transition()`, so a state change still cannot be issued without the audit
 * record and the version guard that come with it. That is also why the round
 * ceiling is absent here — `transition()`'s own `send_back` edge checks
 * `round + 1 > maxRounds` *before* handing out the round, and restating the
 * check here would create the second definition CORE-01 exists to prevent.
 *
 * It **does not know what the stages are.** Only an index, a pipeline length,
 * and an opaque `stageId` that travels straight through onto the audit record
 * — the same discipline `TransitionCtx` holds itself to (EXEC-07). Adding a
 * harness moves a list index; nothing in this file moves.
 *
 * ## The one asymmetry: index 0 is the developer
 *
 * `stage/developer-outcome.ts` states the contract this implements against:
 * *"The sequencer special-cases index 0 because `develop` is always the
 * implicit first mutator (D-05), so index 0 yields a `DeveloperOutcome` while
 * every later index yields a `StageOutcome`."* The developer is the one agent
 * whose work is being judged, so it returns no `Verdict` and contributes none
 * — which is why a pipeline consisting of `develop` alone reaches
 * {@link aggregate} with an empty list and escalates as the misconfiguration
 * it is, rather than reporting green.
 *
 * ## Fail-fast policy in v1: the first `send_back` stops the pipeline
 *
 * `.planning/research/ARCHITECTURE.md` §3 defines the policy as per-stage and
 * defaulted **by cost class** — cheap gates continue and merge their findings,
 * expensive ones stop. Neither half is buildable yet: `Stage.costClass` has no
 * implementations to carry it, and `OnSendBackSchema`'s own `.describe()`
 * records that `on_send_back` is Phase 7's to implement. Half a policy is
 * worse than none, so `ResolvedStage.onSendBack` is read by nothing here, and
 * v1 stops on the first `send_back` — the conservative half. It never pays a
 * later gate to judge code already known to need changes, and it keeps
 * `gate_passed` honest: that event is emitted only when the stage did not stop
 * the pipeline.
 *
 * `fail` always stops immediately regardless of policy (ARCHITECTURE.md §3),
 * and `inconclusive` deliberately does **not** — {@link aggregate}'s own
 * precedence explains why: an inconclusive sitting alongside real findings
 * usually resolves once the code changes, so stopping on it would hide the
 * actionable findings a later gate would have raised.
 */

/**
 * What the stage reported, already classified against which half of the
 * pipeline it sits in.
 *
 * Three members, not two, because "the gate judged" and "the gate broke" are
 * different kinds of thing (D-12, CORE-06) and the developer returns neither
 * of those — it returns a {@link DeveloperOutcome}, which has no `pass`.
 */
export type StageCompletion =
  /** Pipeline index 0 — see the module docblock's asymmetry note. */
  | { readonly kind: 'developer'; readonly outcome: DeveloperOutcome }
  /** Any later index: one of the six outcomes a gate may return. */
  | { readonly kind: 'gate'; readonly verdict: Verdict }
  /** The stage broke rather than judged. Never costs a round (CORE-06). */
  | { readonly kind: 'error'; readonly error: StageError };

export interface RoundStepInput {
  /** Where in the snapshotted pipeline the stage that just finished sits. */
  readonly stageIndex: number;
  /** How many entries the snapshotted pipeline has. Never which ones. */
  readonly pipelineLength: number;
  /**
   * The finished stage's id — carried onto `gate_passed`/`send_back` as
   * opaque audit payload and compared against nothing, exactly as
   * `FeatureEvent`'s own docblock requires.
   */
  readonly stageId: string;
  readonly completion: StageCompletion;
  /**
   * Every verdict already recorded in this round, **excluding** the one
   * arriving on `completion`. Supplied by the caller because it is a database
   * read; this function composes the two and hands the result to
   * {@link aggregate}.
   */
  readonly priorVerdicts: readonly Verdict[];
  /**
   * The finished stage's `on_send_back` policy (HARN-03, M07 step 7.2) —
   * `@adl/core/loop`'s `onSendBackFor` applied to the resolved stage.
   *
   * Supplied by the caller rather than derived here for the same reason
   * `priorVerdicts` is: this function is handed *what the pipeline said*, and
   * never reads the pipeline itself. It knows the finished stage's index, its
   * id, and its length — never which entries it contains — which is what keeps
   * a stage id from influencing the lifecycle (`FeatureEvent`'s own docblock).
   *
   * Optional, defaulting to `stop`, so every pre-7.2 caller and fixture keeps
   * v1's exact behaviour without being edited: absence means the conservative
   * half, which is the half that shipped.
   */
  readonly onSendBack?: OnSendBack;
  /**
   * How many of this stage's findings ADL classified as follow-ups rather than
   * blockers (LOOP-09, M07 step 7.8) — `applyFollowUpPolicy`'s answer, applied
   * by the caller before the verdict ever reaches here.
   *
   * Supplied rather than derived for `onSendBack`'s reason and one more: the
   * classification needs this feature's round history, which is a database
   * read, and by the time a demoted verdict arrives here its outcome is
   * `warn` and nothing on it records that it used to be a `send_back`. Without
   * this field the audit trail could not tell a demotion from a gate that
   * chose to warn.
   *
   * Optional and defaulting to none, so every pre-7.8 caller and fixture keeps
   * v1's exact events without being edited.
   */
  readonly followUpCount?: number;
}

/** The pipeline continues; the stage index moves on. */
export interface AdvanceStep {
  readonly kind: 'advance';
  readonly events: readonly FeatureEvent[];
  /** The index of the stage to run next — `stageIndex + 1`, always. */
  readonly nextStageIndex: number;
}

/**
 * The round is over. `outcome` is what belongs in `rounds.outcome_json`, and
 * `events` is what belongs in `feature_events` — written in the same
 * transaction, per D-11's "the decision and the write happen together".
 */
export interface CompleteStep {
  readonly kind: 'complete';
  readonly events: readonly FeatureEvent[];
  readonly outcome: RoundOutcome;
}

/**
 * The stage broke in a way another attempt could plausibly fix. The round is
 * **not** over and no {@link RoundOutcome} is produced — nothing was judged,
 * so there is nothing to record (CORE-06). The caller returns the feature to
 * the queue through the same crash-recovery path a dead worker takes, so the
 * consecutive-failure ceiling (D-11) applies here too rather than a transient
 * provider outage retrying forever.
 */
export interface RetryStep {
  readonly kind: 'retry';
  readonly reason: string;
}

export type RoundStep = AdvanceStep | CompleteStep | RetryStep;

/** A `complete` step carrying an `escalate` outcome and the matching event. */
function escalate(
  reason: string,
  before: readonly FeatureEvent[] = [],
): CompleteStep {
  return {
    kind: 'complete',
    events: [...before, { t: 'unrecoverable', reason }],
    outcome: { kind: 'escalate', reason },
  };
}

/**
 * Turn an aggregated {@link RoundOutcome} into the lifecycle event that
 * applies it.
 *
 * The mapping is total over the four kinds, and the exhaustiveness check makes
 * a fifth `RoundOutcome` member a compile error here rather than a silent
 * fall-through to escalation.
 */
function completeWith(
  outcome: RoundOutcome,
  stageId: string,
  before: readonly FeatureEvent[],
): CompleteStep {
  switch (outcome.kind) {
    case 'green':
      return {
        kind: 'complete',
        events: [...before, { t: 'all_gates_passed' }],
        outcome,
      };
    case 'send_back':
      return {
        kind: 'complete',
        events: [
          ...before,
          {
            t: 'send_back',
            stageId,
            findingCount: outcome.brief.findings.length,
          },
        ],
        outcome,
      };
    case 'escalate':
      return {
        kind: 'complete',
        events: [...before, { t: 'unrecoverable', reason: outcome.reason }],
        outcome,
      };
    case 'unverified': {
      // `unverified` carries the inconclusive verdicts that caused it, so the
      // escalation says which gate could not tell and why without the reader
      // having to re-run the classification.
      const reason = outcome.inconclusive
        .map((verdict) => verdict.reason)
        .join('; ');
      return {
        kind: 'complete',
        events: [...before, { t: 'unrecoverable', reason }],
        outcome,
      };
    }
    default: {
      const unhandled: never = outcome;
      void unhandled;
      return escalate('unhandled round outcome', before);
    }
  }
}

/**
 * Whether this verdict stops the pipeline where it stands (M07 step 7.2).
 *
 * `fail` always stops, regardless of policy — `ARCHITECTURE.md` §3 is explicit
 * about that, and it is the difference between the two outcomes: a `send_back`
 * says "fix this and come again", a `fail` says "this feature is not going to
 * work", and there is nothing a later gate could add to the second.
 *
 * `send_back` is the one the policy governs. `inconclusive` deliberately does
 * not stop either — see the module docblock: an inconclusive sitting alongside
 * real findings usually resolves once the code changes, so stopping on it would
 * hide the actionable findings a later gate would have raised.
 */
function stopsPipeline(verdict: Verdict, onSendBack: OnSendBack): boolean {
  if (verdict.outcome === 'fail') return true;
  return verdict.outcome === 'send_back' && onSendBack === 'stop';
}

/**
 * `planRoundStep(input)` — advance, complete, or retry.
 *
 * Never throws and never returns `undefined`: a malformed report (a developer
 * outcome from a gate slot, a verdict from the developer's) is classified as
 * an escalation naming exactly what arrived, rather than being trusted or
 * dropped. That mirrors `transition()`'s own totality — the caller has the
 * context to tell a bug from a benign race, and an exception would take that
 * choice away from it.
 */
export function planRoundStep(input: RoundStepInput): RoundStep {
  const { completion, stageIndex, pipelineLength, stageId } = input;

  if (completion.kind === 'error') {
    // The wire value is informational — `StageErrorSchema.retryable`'s own
    // docblock says it is carried so a stage written in another language can
    // state it without reimplementing the table. `stageErrorPolicy` is the
    // table, so a report whose `retryable` disagrees with its `kind` is
    // routed by the kind (rule 8: derive, never restate).
    const detail = `stage "${stageId}" failed: ${completion.error.detail}`;
    return stageErrorPolicy(completion.error.kind).retryable
      ? { kind: 'retry', reason: detail }
      : escalate(detail);
  }

  const isDeveloperSlot = stageIndex === 0;
  if (isDeveloperSlot !== (completion.kind === 'developer')) {
    return escalate(
      `stage "${stageId}" at pipeline index ${String(stageIndex)} reported a ` +
        `${completion.kind === 'developer' ? 'developer outcome' : 'gate verdict'}, ` +
        'but index 0 is the developer and every later index is a gate',
    );
  }

  if (completion.kind === 'developer') {
    const { outcome } = completion;
    if (outcome.kind === 'blocked') {
      // Honest, and never a pass: the developer said it could not proceed.
      return escalate(
        `the developer reported it is blocked: ${outcome.reason}`,
      );
    }
    if (outcome.kind === 'dispute') {
      // D-06: a dispute routes to a human, issues no waiver, and buys no
      // reconsideration round. There is deliberately no arbitration path.
      return escalate(
        `the developer disputed a gate: ${outcome.dispute.argument}`,
      );
    }

    const committed: FeatureEvent = { t: 'dev_committed', sha: outcome.sha };
    if (pipelineLength > 1) {
      return { kind: 'advance', events: [committed], nextStageIndex: 1 };
    }
    // A pipeline of `develop` alone. The developer contributes no verdict, so
    // this reaches `aggregate` empty — which is a misconfiguration and says
    // so, rather than a round that verified nothing reporting green.
    return completeWith(aggregate([]), stageId, [committed]);
  }

  const verdicts = [...input.priorVerdicts, completion.verdict];
  const isLastStage = stageIndex + 1 >= pipelineLength;
  const onSendBack = input.onSendBack ?? 'stop';

  // LOOP-09 (M07 step 7.8). Recorded on both the advance and the complete path
  // — a reviewer that is the LAST stage is exactly the pipeline where its
  // follow-ups would otherwise leave no trace at all, because `completeWith`
  // emits only the round's own outcome event.
  const followUps: readonly FeatureEvent[] =
    (input.followUpCount ?? 0) > 0
      ? [
          {
            t: 'gate_follow_ups',
            stageId,
            findingCount: input.followUpCount!,
          },
        ]
      : [];

  if (isLastStage || stopsPipeline(completion.verdict, onSendBack)) {
    // Note what happens to a `continue` gate's findings when it IS the last
    // stage: nothing special. They reach `aggregate` alongside every earlier
    // gate's, which produces the one merged send-back the policy exists to
    // create. `continue` never discards a finding — it only changes *when* the
    // round is decided.
    return completeWith(aggregate(verdicts), stageId, followUps);
  }

  // M07 step 7.2: the same lifecycle move, under two honest names. A gate that
  // raised blockers and let the pipeline continue did not pass, and
  // `gate_passed` is what the audit trail and the pull request read as
  // "satisfied".
  //
  // M07 step 7.8 adds the third name. A gate whose findings were ALL raised for
  // the first time after its own first look advanced without blocking and
  // without being satisfied, and `gate_follow_ups` is the only one of the three
  // that says so. It is emitted INSTEAD of `gate_passed` — a demoted verdict is
  // a `warn` by the time it reaches here, and `gate_passed` is what the pull
  // request reads as "satisfied".
  const advanced: FeatureEvent =
    completion.verdict.outcome === 'send_back'
      ? {
          t: 'gate_deferred',
          stageId,
          findingCount: completion.verdict.findings.length,
        }
      : followUps[0] !== undefined
        ? followUps[0]
        : { t: 'gate_passed', stageId };

  return {
    kind: 'advance',
    events: [advanced],
    nextStageIndex: stageIndex + 1,
  };
}
