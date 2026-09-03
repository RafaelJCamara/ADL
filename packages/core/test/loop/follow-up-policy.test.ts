import { describe, expect, it } from 'vitest';
import type { ResolvedStage } from '../../src/config/pipeline.js';
import {
  DEFAULT_JUDGEMENT_KIND,
  applyFollowUpPolicy,
  judgementKindOf,
} from '../../src/loop/follow-up-policy.js';
import type { Finding, Verdict } from '../../src/verdict/index.js';

/**
 * LOOP-09 (M07 step 7.8) — the pure half.
 *
 * The rule under test is narrow on purpose, and each of its four conditions has
 * a case here that turns the policy off on its own:
 *
 * 1. the outcome is `send_back` — the only outcome that spends a round;
 * 2. the stage judges by `opinion`, not deterministically;
 * 3. this is not the stage's own first judging round; and
 * 4. not one finding is in the contract that first round set.
 *
 * Condition 2 is the one that is easy to get wrong and expensive when wrong.
 * The built-in command gate's finding title carries the exit code
 * (`command-gate.ts` puts it there so the fingerprint is stable across runs),
 * so `exit 1` in round 1 and `exit 2` in round 2 are two different
 * fingerprints. Without the `deterministic` classification, the second would be
 * demoted and a broken build would produce a green round.
 */

function finding(fingerprintSeed: string, title: string): Finding {
  return {
    fingerprint: fingerprintSeed.repeat(64).slice(0, 64),
    severity: 'blocker',
    title,
    detail: `${title} in detail`,
    criterionRef: { kind: 'global', category: 'code_quality' },
  };
}

const OLD = finding('a', 'the export button is missing');
const NEW = finding('b', 'the exporter has no error handling');

function sendBack(...findings: Finding[]): Verdict {
  return { outcome: 'send_back', summary: 'problems', findings };
}

const REVIEW: ResolvedStage = { id: 'review', source: 'built-in' };
const TEST: ResolvedStage = { id: 'test', source: 'built-in' };

/** The default arguments for a later look whose contract holds only OLD. */
function laterLook(verdict: Verdict, stage: ResolvedStage = REVIEW) {
  return {
    verdict,
    stage,
    isFirstJudgingRound: false,
    contractFingerprints: new Set([OLD.fingerprint]),
  };
}

describe('judgementKindOf', () => {
  it('classifies the built-in reviewer as an opinion and the test gate as deterministic', () => {
    expect(judgementKindOf(REVIEW)).toBe('opinion');
    expect(judgementKindOf(TEST)).toBe('deterministic');
  });

  it('defaults an unknown stage to deterministic, so its findings are never demoted', () => {
    // The conservative side by construction, matching `onSendBackFor`'s own
    // shape. A gate ADL has never seen reporting a NEW failure in round 2 must
    // not have ADL quietly decide it does not count.
    expect(judgementKindOf({ id: 'sast', source: 'npm' })).toBe(
      DEFAULT_JUDGEMENT_KIND,
    );
    expect(judgementKindOf({ id: 'sast', source: 'npm' })).toBe(
      'deterministic',
    );
    expect(judgementKindOf({ id: 'audit', source: 'command' })).toBe(
      'deterministic',
    );
    expect(judgementKindOf({ id: 'lint', source: 'repo-path' })).toBe(
      'deterministic',
    );
  });

  it('does not let a third-party stage inherit a built-in classification by name', () => {
    // `costClassOf`'s rule, for the same reason: a pipeline entry's id is
    // chosen by whoever wrote `adl.yml`, and only `source: 'built-in'` means
    // ADL supplied it.
    expect(judgementKindOf({ id: 'review', source: 'repo-path' })).toBe(
      'deterministic',
    );
  });
});

describe('applyFollowUpPolicy', () => {
  it('demotes a send_back whose findings are all new to a warn, keeping every finding', () => {
    // The case the whole step exists for. The reviewer was satisfied on the
    // thing it originally asked for, and everything it now says is a new
    // opinion — so it has no claim on one of the feature's finite rounds.
    const decision = applyFollowUpPolicy(laterLook(sendBack(NEW)));

    expect(decision.demoted).toBe(true);
    expect(decision.verdict.outcome).toBe('warn');
    expect(decision.followUps).toEqual([NEW]);
    // Nothing is discarded: `aggregate` puts `warn` findings in the brief when
    // some other gate sent the developer back, and the pull request renders
    // them either way.
    if (decision.verdict.outcome !== 'warn') return;
    expect(decision.verdict.findings).toEqual([NEW]);
    expect(decision.verdict.summary).toBe('problems');
  });

  it('leaves the send_back alone when one contract finding is still open', () => {
    // The developer is going back regardless, so holding the new observation
    // for a pull request they have not reached yet would be worse than telling
    // them now — `aggregate`'s own "the developer is editing this code anyway"
    // reasoning.
    const decision = applyFollowUpPolicy(laterLook(sendBack(OLD, NEW)));

    expect(decision.demoted).toBe(false);
    expect(decision.verdict.outcome).toBe('send_back');
    // Still reported, so the caller can label them on the pull request.
    expect(decision.followUps).toEqual([NEW]);
  });

  it("changes nothing on the stage's own first judging round", () => {
    // The first look IS the contract. A reviewer whose first opinion was
    // non-blocking would be decorative — and this is reachable rather than
    // theoretical: `review` defaults to `on_send_back: stop`, so in a pipeline
    // whose tests fail first the reviewer may not run until round 2.
    const decision = applyFollowUpPolicy({
      verdict: sendBack(NEW),
      stage: REVIEW,
      isFirstJudgingRound: true,
      contractFingerprints: new Set(),
    });

    expect(decision.demoted).toBe(false);
    expect(decision.verdict.outcome).toBe('send_back');
    expect(decision.followUps).toEqual([]);
  });

  it('never demotes a deterministic gate, even when every finding is new', () => {
    // The case that would turn a broken build green. `test` exiting 1 in round
    // 1 and 2 in round 2 produces two fingerprints, because the exit code is in
    // the title; the second is still the build being broken.
    const decision = applyFollowUpPolicy(laterLook(sendBack(NEW), TEST));

    expect(decision.demoted).toBe(false);
    expect(decision.verdict.outcome).toBe('send_back');
    expect(decision.followUps).toEqual([]);
  });

  it('leaves every outcome that is not send_back untouched', () => {
    // Only `send_back` spends a round, so only `send_back` can move goalposts.
    // A `fail` demoted to a warn would be catastrophic — it means "this feature
    // is not going to work" — and a `pass` has no findings to reclassify.
    const others: Verdict[] = [
      {
        outcome: 'pass',
        summary: 's',
        checked: [{ kind: 'criterion', id: 'AC-1' }],
      },
      { outcome: 'fail', summary: 's', reason: 'unfixable' },
      { outcome: 'inconclusive', summary: 's', reason: 'could not tell' },
      { outcome: 'warn', summary: 's', findings: [NEW] },
      { outcome: 'skip', reason: 'not configured' },
    ];
    for (const verdict of others) {
      const decision = applyFollowUpPolicy(laterLook(verdict));
      expect(decision.demoted, `${verdict.outcome} was demoted`).toBe(false);
      expect(decision.verdict).toBe(verdict);
      expect(decision.followUps).toEqual([]);
    }
  });

  it('changes nothing when every finding is one the contract already carried', () => {
    // The ordinary unfixed send-back. Nothing here is new, so nothing is a
    // follow-up, and `followUps` is empty rather than "all of them".
    const decision = applyFollowUpPolicy(laterLook(sendBack(OLD)));

    expect(decision.demoted).toBe(false);
    expect(decision.verdict).toEqual(sendBack(OLD));
    expect(decision.followUps).toEqual([]);
  });

  it('demotes against an empty contract — a gate whose first look raised nothing', () => {
    // A reviewer that PASSED in round 1 has looked, and its contract is empty.
    // Everything it says in round 2 is therefore a new opinion, which is
    // exactly the goalpost move LOOP-09 names: the gate was satisfied once and
    // has changed its mind.
    const decision = applyFollowUpPolicy({
      verdict: sendBack(NEW),
      stage: REVIEW,
      isFirstJudgingRound: false,
      contractFingerprints: new Set(),
    });

    expect(decision.demoted).toBe(true);
    expect(decision.verdict.outcome).toBe('warn');
  });
});
