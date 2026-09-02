import { describe, expect, it } from 'vitest';
import type { TranscriptRecord } from '@adl/core/stage';
import {
  ESCALATION_COMMENT_TITLE,
  MAX_TRANSCRIPT_EVENTS,
  renderEscalationComment,
  type TranscriptExcerpt,
} from '../../src/publish/escalation-comment.js';
import type { Escalation } from '../../src/publish/escalation-history.js';

/**
 * M06 step 6.8's rendering half — the comment LOOP-08 puts a human in front of.
 *
 * The maintainer's call (2026-09-02) is a bounded transcript tail plus a
 * pointer, not the whole file: "full transcript" and FORGE-06's "the PR stays
 * readable" cannot both be literally true against a 60,000-character comment
 * budget. So the assertions here are about what survives the bound — the
 * newest escalation whole, the excerpt attached to it and to nothing else, and
 * a fence that agent output cannot break out of.
 */

const FEATURE_ID = '01JQZZZZZZZZZZZZZZZZZZZZZZ';

function escalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    seq: 7,
    at: '2026-09-02T10:00:00.000Z',
    round: 3,
    fromState: 'gating',
    headline: 'escalated — the developer and the gate are at a stalemate',
    reason:
      'the developer and the gate are at a stalemate — the same finding kept recurring',
    ...overrides,
  };
}

function record(
  seq: number,
  event: TranscriptRecord['event'],
): TranscriptRecord {
  return { seq, at: '2026-09-02T09:59:00.000Z', event };
}

function excerptOf(
  records: readonly TranscriptRecord[],
  overrides: Partial<TranscriptExcerpt> = {},
): TranscriptExcerpt {
  return {
    records,
    stageAttemptId: '01JQATTEMPTATTEMPTATTEMPT',
    absent: false,
    ...overrides,
  };
}

describe('renderEscalationComment (M06 step 6.8)', () => {
  it('reports undefined — not an empty comment — for a feature that has never escalated', () => {
    expect(
      renderEscalationComment({ escalations: [], featureId: FEATURE_ID }),
    ).toBe(undefined);
  });

  it('leads with the escalation banner, the round, and the reason', () => {
    const body = renderEscalationComment({
      escalations: [escalation()],
      featureId: FEATURE_ID,
    });

    expect(body).toContain(`### ${ESCALATION_COMMENT_TITLE}`);
    expect(body).toContain(
      '**Round 3 — escalated — the developer and the gate',
    );
    expect(body).toContain('the same finding kept recurring');
    // The state it stopped in is part of "the disagreement" a reviewer needs.
    expect(body).toContain('`gating`');
  });

  it('expands the newest escalation and folds every earlier one', () => {
    const body =
      renderEscalationComment({
        escalations: [
          escalation({ seq: 9, round: 4, reason: 'the newest reason' }),
          escalation({ seq: 5, round: 2, reason: 'an older reason' }),
          escalation({ seq: 2, round: 1, reason: 'the oldest reason' }),
        ],
        featureId: FEATURE_ID,
      }) ?? '';

    // The newest is above the first fold; the other two are inside folds.
    const firstFold = body.indexOf('<details>');
    expect(firstFold).toBeGreaterThan(-1);
    expect(body.slice(0, firstFold)).toContain('the newest reason');
    expect(body.slice(firstFold)).toContain('an older reason');
    expect(body.slice(firstFold)).toContain('the oldest reason');
    expect(body).toContain('<summary>Round 2 —');
  });

  it('attaches the transcript excerpt and the resume command to the newest escalation only', () => {
    const body =
      renderEscalationComment({
        escalations: [
          escalation({ seq: 9, round: 4, reason: 'the newest reason' }),
          escalation({ seq: 5, round: 2, reason: 'an older reason' }),
        ],
        featureId: FEATURE_ID,
        excerpt: excerptOf([
          record(1, { kind: 'text', messageId: 'm1', delta: 'trying again' }),
        ]),
      }) ?? '';

    // Exactly one `adl logs` pointer, in the expanded newest escalation. A
    // transcript is a file on disk rather than a column, so re-reading one per
    // historical escalation on every republish would be an unbounded read for
    // content the budget could never hold — see the module docblock.
    expect(body.match(/adl logs/g)).toHaveLength(1);
    expect(body).toContain('adl logs 01JQATTEMPTATTEMPTATTEMPT');
    expect(body).toContain(`adl resume ${FEATURE_ID}`);
    expect(body).toContain('trying again');
    expect(body.indexOf('adl logs')).toBeLessThan(
      body.indexOf('<details>\n<summary>Round 2'),
    );
  });

  it('renders every AgentEvent kind as one line, and never prints an unreported token count as zero', () => {
    const body =
      renderEscalationComment({
        escalations: [escalation()],
        featureId: FEATURE_ID,
        excerpt: excerptOf([
          record(1, {
            kind: 'started',
            model: 'claude-opus-5',
            capabilities: {
              emitsIncrementalEvents: true,
              reportsUsage: true,
              reportsCost: true,
              supportsSessionResume: true,
              enforcesTurnCap: true,
            },
          }),
          record(2, { kind: 'thinking', messageId: 'm', delta: 'hmm' }),
          record(3, {
            kind: 'tool_call',
            callId: 'c1',
            name: 'Edit',
            input: { file_path: 'src/auth.ts' },
          }),
          record(4, {
            kind: 'tool_result',
            callId: 'c1',
            result: 'applied',
            isError: false,
          }),
          record(5, {
            kind: 'usage',
            inputTokens: 12,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: 3,
          }),
          record(6, { kind: 'result', outcome: 'completed', durationMs: 1500 }),
          record(7, {
            kind: 'error',
            errorKind: 'provider_error',
            detail: '429 rate limited',
          }),
        ]),
      }) ?? '';

    expect(body).toContain('claude-opus-5');
    expect(body).toContain('tool_call    Edit');
    expect(body).toContain('src/auth.ts');
    expect(body).toContain('tool_result  ok');
    expect(body).toContain('result       completed in 1500ms');
    expect(body).toContain('provider_error: 429 rate limited');
    // D-31: "the backend did not report this" is not the same fact as zero, so
    // the unreported pair is absent rather than printed as `out=0`.
    expect(body).toContain('in=12 cache_write=3');
    expect(body).not.toContain('out=0');
    expect(body).not.toContain('cache_read=0');
  });

  it('opens a code fence longer than any backtick run in the agent’s own output', () => {
    const body =
      renderEscalationComment({
        escalations: [
          escalation({ seq: 9, round: 4 }),
          // A prior escalation, so a real `<details>` fold exists below the
          // excerpt for the fence to be capable of breaking.
          escalation({ seq: 5, round: 2, reason: 'an older reason' }),
        ],
        featureId: FEATURE_ID,
        excerpt: excerptOf([
          record(1, {
            kind: 'tool_result',
            callId: 'c1',
            // Ordinary agent output: a tool that read a markdown file. A
            // three-backtick fence would be closed by this line, spilling the
            // rest of the excerpt into the comment as markdown — and, worse,
            // un-protecting the `<details>` fold below, because
            // `renderStickyComment` decides what a code span is by parsing the
            // markdown, and a broken fence changes that answer.
            result: 'here is a fence: ``` and a longer one: ````',
            isError: false,
          }),
        ]),
      }) ?? '';

    expect(body).toContain('`````text');
    // The prior escalation's fold is still a fold rather than an escaped
    // literal — which is what un-protecting it would have produced.
    expect(body).toContain('<details>');
    expect(body).not.toContain('&lt;details');
    expect(body.match(/<details>/g)).toHaveLength(1);
    expect(body.match(/<\/details>/g)).toHaveLength(1);
  });

  it('shows only the last MAX_TRANSCRIPT_EVENTS events and says so', () => {
    const many = Array.from({ length: MAX_TRANSCRIPT_EVENTS + 25 }, (_, i) =>
      record(i + 1, {
        kind: 'text',
        messageId: 'm',
        delta: `event-${String(i + 1)}`,
      }),
    );
    const body =
      renderEscalationComment({
        escalations: [escalation()],
        featureId: FEATURE_ID,
        excerpt: excerptOf(many),
      }) ?? '';

    expect(body).toContain(`the last ${String(MAX_TRANSCRIPT_EVENTS)} events`);
    expect(body).toContain(`event-${String(many.length)}`);
    // The head is gone — the tail is what a reviewer asking "what was it doing
    // when it stopped" wants.
    expect(body).not.toContain('event-1\n');
    expect(body).not.toContain('event-14 ');
  });

  it('says so when the stage that stopped wrote no transcript, and still gives the pointer', () => {
    const absent =
      renderEscalationComment({
        escalations: [escalation()],
        featureId: FEATURE_ID,
        excerpt: excerptOf([], { absent: true }),
      }) ?? '';
    expect(absent).toContain('No transcript was written');
    expect(absent).toContain('adl logs');

    // Distinct from a transcript that exists and is empty — two different
    // facts about a failed run, and a reviewer acts on them differently.
    const empty =
      renderEscalationComment({
        escalations: [escalation()],
        featureId: FEATURE_ID,
        excerpt: excerptOf([]),
      }) ?? '';
    expect(empty).toContain('is empty');
    expect(empty).toContain('adl logs');
  });

  it('never exceeds the comment budget, and keeps the newest escalation when it binds', () => {
    const huge = Array.from({ length: MAX_TRANSCRIPT_EVENTS }, (_, i) =>
      record(i + 1, { kind: 'text', messageId: 'm', delta: 'x'.repeat(5_000) }),
    );
    const body =
      renderEscalationComment({
        escalations: [
          escalation({ seq: 9, round: 4, reason: 'the newest reason' }),
          escalation({ seq: 5, round: 2, reason: 'an older reason' }),
          escalation({ seq: 2, round: 1, reason: 'the oldest reason' }),
        ],
        featureId: FEATURE_ID,
        excerpt: excerptOf(huge),
        maxLength: 4_000,
      }) ?? '';

    expect(body.length).toBeLessThanOrEqual(4_000);
    // The one a human opened the pull request to read survives; the older ones
    // are dropped with the omission stated rather than silently missing.
    expect(body).toContain('the newest reason');
    expect(body).toContain('earlier round');
  });
});
