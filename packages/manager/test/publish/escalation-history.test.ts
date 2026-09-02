import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { featuresRepository, migrateToLatest, nowIso } from '@adl/db';
import type { Database, FeaturesTable } from '@adl/db';
import type { Kysely } from 'kysely';
import type { FeatureEvent } from '@adl/core/state';
import { openAttempt } from '../../src/bookkeeping/attempt.js';
import { readEscalations } from '../../src/publish/escalation-history.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * M06 step 6.8's read half: every escalation this feature has had, from the
 * one table that records all of them.
 *
 * The properties worth the most here are the two that decide whether LOOP-08
 * is actually satisfied rather than nearly satisfied:
 *
 * 1. **All three escalating edges are read, not two.** `unrecoverable` and
 *    `limit_exceeded` are the obvious pair; `send_back` reaches `escalated`
 *    too, because `transition()` diverts it there when the round it would hand
 *    out is past `maxRounds` (LOOP-03, step 6.2). A reader that enumerated the
 *    obvious pair would be silent for the round ceiling — the first limit
 *    LOOP-08 names.
 * 2. **A row this build cannot label still produces an escalation.** Dropping
 *    it would hide the one thing this module exists to surface.
 */

async function seedFeature(db: Kysely<Database>): Promise<FeaturesTable> {
  const now = nowIso();
  const repoId = ulid();
  await db
    .insertInto('repos')
    .values({
      id: repoId,
      remote_url: 'https://github.com/adl-test-org/demo-repo.git',
      default_branch: 'main',
      forge: 'github',
      features_dir: 'features',
      created_at: now,
      updated_at: now,
    })
    .execute();

  const id = ulid();
  await db
    .insertInto('features')
    .values({
      id,
      repo_id: repoId,
      path: 'features/dark-mode',
      state: 'escalated',
      state_version: 1,
      round: 1,
      current_stage_index: 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: null,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      heartbeat_at: now,
      crash_count: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return (await featuresRepository(db).findById(id))!;
}

let seq = 0;

/** Append one audit row exactly as `applyEvent`/`reapOne` do. */
async function appendEvent(
  db: Kysely<Database>,
  featureId: string,
  toState: string,
  event: FeatureEvent | Record<string, unknown>,
  at = nowIso(),
  fromState: string | null = 'gating',
): Promise<void> {
  seq += 1;
  await featuresRepository(db).appendEvent({
    id: ulid(),
    feature_id: featureId,
    seq,
    from_state: fromState,
    to_state: toState,
    event_json: JSON.stringify(event),
    actor: 'round-loop',
    at,
  });
}

describe('readEscalations (M06 step 6.8)', () => {
  it('reads all three edges that reach `escalated`, including the round ceiling’s `send_back`', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      seq = 0;

      await appendEvent(db, feature.id, 'escalated', {
        t: 'unrecoverable',
        reason: 'the developer reported it is blocked: no database credentials',
      });
      await appendEvent(db, feature.id, 'escalated', {
        t: 'limit_exceeded',
        reason: 'budget_limit',
      });
      // LOOP-03's ceiling. The event on the row is the send-back itself — the
      // limit is implied by where it landed, which is exactly why a reader
      // keyed on event kind rather than on `to_state` would miss it.
      await appendEvent(db, feature.id, 'escalated', {
        t: 'send_back',
        stageId: 'review',
        findingCount: 3,
      });

      const escalations = await readEscalations(db, feature.id);

      expect(escalations).toHaveLength(3);
      // Newest first — the escalation blocking the feature right now is the
      // one a reader wants at the top.
      expect(escalations[0]?.reason).toContain('the round limit was reached');
      expect(escalations[0]?.reason).toContain('3 findings');
      expect(escalations[1]?.reason).toBe(
        'the per-feature budget was exhausted',
      );
      expect(escalations[2]?.reason).toContain('no database credentials');
    });
  });

  it('ignores every row that did not reach `escalated`', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      seq = 0;

      // The same `send_back` event kind, on the ordinary edge back to
      // `developing`. `to_state` is the whole difference, and it has to be —
      // a feature sends back far more often than it escalates.
      await appendEvent(db, feature.id, 'developing', {
        t: 'send_back',
        stageId: 'review',
        findingCount: 1,
      });
      await appendEvent(db, feature.id, 'queued', { t: 'lease_expired' });
      await appendEvent(db, feature.id, 'paused', {
        t: 'pause',
        by: 'someone',
      });

      expect(await readEscalations(db, feature.id)).toEqual([]);
    });
  });

  it('places each escalation in the round that had started when it happened', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      seq = 0;

      // Escalated before any round opened at all — reported as round 0, which
      // reads honestly as "nothing ran" rather than claiming round 1 did.
      await appendEvent(
        db,
        feature.id,
        'escalated',
        { t: 'unrecoverable', reason: 'before anything ran' },
        '2026-01-01T00:00:00.000Z',
        'queued',
      );

      const first = await openAttempt(
        { db },
        { featureId: feature.id, stageId: 'develop', stageIndex: 0 },
      );
      await db
        .updateTable('rounds')
        .set({ started_at: '2026-01-02T00:00:00.000Z', outcome: 'send_back' })
        .where('id', '=', first.roundId)
        .execute();

      const second = await openAttempt(
        { db },
        { featureId: feature.id, stageId: 'develop', stageIndex: 0 },
      );
      await db
        .updateTable('rounds')
        .set({ started_at: '2026-01-03T00:00:00.000Z' })
        .where('id', '=', second.roundId)
        .execute();

      // Between the two rounds — the dispatcher's budget escalation shape,
      // which fires with no round open. The round a human cares about is the
      // last one that ran.
      await appendEvent(
        db,
        feature.id,
        'escalated',
        { t: 'limit_exceeded', reason: 'budget_limit' },
        '2026-01-02T12:00:00.000Z',
      );
      // Inside round 2 — the round loop's shape.
      await appendEvent(
        db,
        feature.id,
        'escalated',
        { t: 'unrecoverable', reason: 'a stalemate' },
        '2026-01-03T06:00:00.000Z',
      );

      const escalations = await readEscalations(db, feature.id);
      expect(escalations.map((e) => [e.round, e.reason])).toEqual([
        [2, 'a stalemate'],
        [1, 'the per-feature budget was exhausted'],
        [0, 'before anything ran'],
      ]);
    });
  });

  it('still reports an escalation for a row it cannot label', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      seq = 0;

      // Three ways a row can defeat the labeller, and none of them may make an
      // escalation disappear: unreadable JSON, a limit reason this build does
      // not know, and an event kind that reaches `escalated` in some future
      // build without carrying a reason.
      seq += 1;
      await featuresRepository(db).appendEvent({
        id: ulid(),
        feature_id: feature.id,
        seq,
        from_state: 'gating',
        to_state: 'escalated',
        event_json: '{not json',
        actor: 'round-loop',
        at: nowIso(),
      });
      await appendEvent(db, feature.id, 'escalated', {
        t: 'limit_exceeded',
        reason: 'some_future_limit',
      });
      await appendEvent(db, feature.id, 'escalated', { t: 'future_edge' });

      const escalations = await readEscalations(db, feature.id);
      expect(escalations).toHaveLength(3);
      expect(escalations[0]?.reason).toContain('future_edge');
      expect(escalations[1]?.reason).toContain('some_future_limit');
      expect(escalations[2]?.reason).toContain('could not be read');
      // Every one of them still reads as an escalation, not as a blank.
      for (const escalation of escalations) {
        expect(escalation.headline).not.toBe('');
        expect(escalation.reason).not.toBe('');
      }
    });
  });

  it('clips a paragraph-length reason out of the `<summary>` line but keeps it whole in the body', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      seq = 0;

      // A `blocked` developer outcome quotes the agent verbatim, and nothing
      // in the type stops it being a paragraph. A `<summary>` is one line by
      // construction.
      const long = `${'the agent explained itself at length. '.repeat(20)}`;
      await appendEvent(db, feature.id, 'escalated', {
        t: 'unrecoverable',
        reason: `line one\n\nline two ${long}`,
      });

      const [escalation] = await readEscalations(db, feature.id);
      expect(escalation?.headline).not.toContain('\n');
      expect(escalation?.headline.length).toBeLessThan(160);
      expect(escalation?.headline).toContain('…');
      // The body keeps what the summary had to drop.
      expect(escalation?.reason).toContain('line one line two');
      expect(escalation?.reason.length).toBeGreaterThan(
        escalation?.headline.length ?? 0,
      );
    });
  });
});
