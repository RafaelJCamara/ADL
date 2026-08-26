import { describe, expect, it } from 'vitest';
import type { RoundsTable } from '@adl/db';
import type { SendBackBrief } from '@adl/core/verdict';
import {
  parseSendBackBriefJson,
  sendBackBriefFromClosedRound,
} from '../../src/loop/send-back-brief.js';

/**
 * `sendBackBriefFromClosedRound` / `parseSendBackBriefJson` (M05 step 5.15,
 * LOOP-02) — both directions of carrying a send-back verdict onto the next
 * developer dispatch, and both directions' "degrade, never throw" discipline.
 */

const FINDING = {
  fingerprint: 'a'.repeat(64),
  severity: 'blocker',
  title: 'the test command failed (exit 1)',
  detail: 'FAIL: 1 test failed',
  criterionRef: { kind: 'global', category: 'build' },
} as const;

const BRIEF: SendBackBrief = { findings: [FINDING] };

function round(overrides: Partial<RoundsTable>): RoundsTable {
  return {
    id: 'round-1',
    feature_id: 'feature-1',
    number: 1,
    outcome: null,
    outcome_json: null,
    head_sha: null,
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: null,
    ...overrides,
  };
}

describe('sendBackBriefFromClosedRound', () => {
  it('is undefined for no round at all — round 1', () => {
    expect(sendBackBriefFromClosedRound(undefined)).toBeUndefined();
  });

  it('is undefined when the round carries no outcome payload', () => {
    expect(
      sendBackBriefFromClosedRound(
        round({ outcome: null, outcome_json: null }),
      ),
    ).toBeUndefined();
  });

  it('is undefined for a green round — nothing to send back', () => {
    expect(
      sendBackBriefFromClosedRound(
        round({ outcome: 'green', outcome_json: '{"kind":"green"}' }),
      ),
    ).toBeUndefined();
  });

  it('is undefined for an escalate round', () => {
    expect(
      sendBackBriefFromClosedRound(
        round({
          outcome: 'escalate',
          outcome_json: '{"kind":"escalate","reason":"a human is needed"}',
        }),
      ),
    ).toBeUndefined();
  });

  it('is undefined for outcome_json that is not valid JSON', () => {
    expect(
      sendBackBriefFromClosedRound(
        round({ outcome: 'send_back', outcome_json: 'not json' }),
      ),
    ).toBeUndefined();
  });

  it('is undefined for outcome_json that does not match RoundOutcomeSchema', () => {
    expect(
      sendBackBriefFromClosedRound(
        round({ outcome: 'send_back', outcome_json: '{"kind":"send_back"}' }),
      ),
    ).toBeUndefined();
  });

  it('returns the brief for a real send_back round', () => {
    const result = sendBackBriefFromClosedRound(
      round({
        outcome: 'send_back',
        outcome_json: JSON.stringify({ kind: 'send_back', brief: BRIEF }),
      }),
    );
    expect(result).toEqual(BRIEF);
  });
});

describe('parseSendBackBriefJson', () => {
  it('is undefined for undefined input', () => {
    expect(parseSendBackBriefJson(undefined)).toBeUndefined();
  });

  it('is undefined for input that is not valid JSON', () => {
    expect(parseSendBackBriefJson('not json')).toBeUndefined();
  });

  it('is undefined for JSON that does not match SendBackBriefSchema', () => {
    expect(parseSendBackBriefJson('{"findings":[]}')).toBeUndefined();
    expect(parseSendBackBriefJson('{"kind":"send_back"}')).toBeUndefined();
  });

  it('returns the brief for a valid payload', () => {
    expect(parseSendBackBriefJson(JSON.stringify(BRIEF))).toEqual(BRIEF);
  });
});
