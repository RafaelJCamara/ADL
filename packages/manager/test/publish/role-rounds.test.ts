import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  featuresRepository,
  migrateToLatest,
  nowIso,
  verdictsRepository,
} from '@adl/db';
import type { Database, FeaturesTable } from '@adl/db';
import type { Kysely } from 'kysely';
import { closeAttempt, openAttempt } from '../../src/bookkeeping/attempt.js';
import { readRoleRounds } from '../../src/publish/role-rounds.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * M05 step 5.11's DB half: a role's round history, derived from `rounds`,
 * `stage_attempts`, `verdicts` and `findings` rather than from a table
 * remembering what was published.
 */

const DEVELOP = 'develop';

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
      state: 'developing',
      state_version: 1,
      round: 0,
      current_stage_index: 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: null,
      lease_owner: 'manager',
      lease_token: ulid(),
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      heartbeat_at: now,
      crash_count: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return (await featuresRepository(db).findById(id))!;
}

/** Close the feature's open round so the next `openAttempt` starts a new one. */
async function endRound(
  db: Kysely<Database>,
  roundId: string,
  outcome: string,
  outcomeJson?: string,
): Promise<void> {
  await db
    .updateTable('rounds')
    .set({
      outcome,
      ...(outcomeJson !== undefined ? { outcome_json: outcomeJson } : {}),
      ended_at: nowIso(),
    })
    .where('id', '=', roundId)
    .execute();
}

describe('readRoleRounds', () => {
  it('reports one round per round the role ran in, oldest first', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);

      const first = await openAttempt(
        { db },
        { featureId: feature.id, stageId: DEVELOP, stageIndex: 0 },
      );
      await closeAttempt(
        { db },
        { stageAttemptId: first.stageAttemptId, status: 'verdict' },
      );
      await endRound(db, first.roundId, 'send_back');

      const second = await openAttempt(
        { db },
        { featureId: feature.id, stageId: DEVELOP, stageIndex: 0 },
      );
      await closeAttempt(
        { db },
        { stageAttemptId: second.stageAttemptId, status: 'verdict' },
      );

      const rounds = await readRoleRounds(db, {
        featureId: feature.id,
        stageId: DEVELOP,
      });

      expect(rounds.map((r) => r.number)).toEqual([1, 2]);
      expect(rounds[0]?.body).toContain('- Attempt 1 — completed');
      // A closed round reports its own outcome as the headline; an open one
      // falls back to describing its attempts.
      expect(rounds[0]?.headline).toBe('send_back');
      expect(rounds[1]?.headline).toBe('1 attempt');
    });
  });

  it('renders a finished round’s real outcome from rounds.outcome_json (D-5-11-1)', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);

      const attempt = await openAttempt(
        { db },
        { featureId: feature.id, stageId: DEVELOP, stageIndex: 0 },
      );
      await closeAttempt(
        { db },
        { stageAttemptId: attempt.stageAttemptId, status: 'verdict' },
      );
      // Exactly what M05 step 5.13's round loop writes when a round sends the
      // developer back. The `outcome` column alone is the bare kind; the
      // payload is the only durable record of *what* it sent back, and a
      // comment re-derived from the database is the only reader there is.
      await endRound(
        db,
        attempt.roundId,
        'send_back',
        JSON.stringify({
          kind: 'send_back',
          brief: {
            findings: [{ title: 'one' }, { title: 'two' }, { title: 'three' }],
          },
        }),
      );

      const rounds = await readRoleRounds(db, {
        featureId: feature.id,
        stageId: DEVELOP,
      });
      expect(rounds[0]?.headline).toBe('send_back — 3 findings');
    });
  });

  it('falls back to the bare outcome for a round closed before outcome_json carried a payload', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);

      const attempt = await openAttempt(
        { db },
        { featureId: feature.id, stageId: DEVELOP, stageIndex: 0 },
      );
      await closeAttempt(
        { db },
        { stageAttemptId: attempt.stageAttemptId, status: 'verdict' },
      );
      // A round row an older build closed, and a payload no build can read —
      // a fold that says less beats one that throws while rendering a public
      // pull request.
      await endRound(db, attempt.roundId, 'escalate', 'not json at all');

      const rounds = await readRoleRounds(db, {
        featureId: feature.id,
        stageId: DEVELOP,
      });
      expect(rounds[0]?.headline).toBe('escalate');
    });
  });

  it('lists every attempt within a round — a repair reprompt is history, not an overwrite (D-13)', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);

      const first = await openAttempt(
        { db },
        { featureId: feature.id, stageId: DEVELOP, stageIndex: 0 },
      );
      await closeAttempt(
        { db },
        { stageAttemptId: first.stageAttemptId, status: 'error' },
      );
      await db
        .updateTable('stage_attempts')
        .set({ error_kind: 'provider_error' })
        .where('id', '=', first.stageAttemptId)
        .execute();

      // The round is still open, so this is a second attempt at the same
      // position rather than a new round.
      const second = await openAttempt(
        { db },
        { featureId: feature.id, stageId: DEVELOP, stageIndex: 0 },
      );
      await closeAttempt(
        { db },
        { stageAttemptId: second.stageAttemptId, status: 'verdict' },
      );

      const rounds = await readRoleRounds(db, {
        featureId: feature.id,
        stageId: DEVELOP,
      });

      expect(rounds).toHaveLength(1);
      expect(rounds[0]?.body).toContain(
        '- Attempt 1 — errored (`provider_error`)',
      );
      expect(rounds[0]?.body).toContain('- Attempt 2 — completed');
      expect(rounds[0]?.headline).toBe('2 attempts');
    });
  });

  it('describes a still-running attempt as such rather than as completed', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      await openAttempt(
        { db },
        { featureId: feature.id, stageId: DEVELOP, stageIndex: 0 },
      );

      const rounds = await readRoleRounds(db, {
        featureId: feature.id,
        stageId: DEVELOP,
      });

      expect(rounds[0]?.body).toContain('- Attempt 1 — still running');
      expect(rounds[0]?.headline).toBe('in progress');
    });
  });

  it('renders a verdict and its findings when one exists (5.13/5.14 inherit this)', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      const attempt = await openAttempt(
        { db },
        { featureId: feature.id, stageId: 'test', stageIndex: 1 },
      );
      await closeAttempt(
        { db },
        { stageAttemptId: attempt.stageAttemptId, status: 'verdict' },
      );

      const verdictId = ulid();
      await verdictsRepository(db).recordVerdict({
        verdict: {
          id: verdictId,
          stage_attempt_id: attempt.stageAttemptId,
          outcome: 'send_back',
          summary: 'Two tests fail.\nBoth in the auth suite.',
          reason: null,
          waiver_id: null,
          created_at: nowIso(),
        },
        findings: [
          // Inserted nit-first, so the rendered order proves a sort rather
          // than an insertion order that happened to look right.
          {
            id: ulid(),
            verdict_id: verdictId,
            fingerprint: 'a'.repeat(64),
            severity: 'nit',
            title: 'Prefer const',
            detail: 'detail',
            criterion_ref_kind: 'global',
            criterion_id: null,
            global_category: 'style',
            path: null,
            line: null,
            end_line: null,
            suggested_action: null,
            created_at: nowIso(),
          },
          {
            id: ulid(),
            verdict_id: verdictId,
            fingerprint: 'b'.repeat(64),
            severity: 'blocker',
            title: 'Redirect is not validated',
            detail: 'detail',
            criterion_ref_kind: 'criterion',
            criterion_id: 'AC-3',
            global_category: null,
            path: 'src/auth/login.ts',
            line: 42,
            end_line: 47,
            suggested_action: 'Compare against an allowlist.',
            created_at: nowIso(),
          },
        ],
      });

      const rounds = await readRoleRounds(db, {
        featureId: feature.id,
        stageId: 'test',
      });

      // The summary is inlined on one line — a multi-line summary would break
      // out of the bullet it belongs to.
      expect(rounds[0]?.body).toContain(
        '- Attempt 1 — **send_back** — Two tests fail. Both in the auth suite.',
      );
      expect(rounds[0]?.body).toContain(
        '  - `blocker` Redirect is not validated (`src/auth/login.ts:42`)',
      );
      // A finding with no location renders without a dangling empty locator.
      expect(rounds[0]?.body).toContain('  - `nit` Prefer const');
      expect(rounds[0]?.body).not.toContain('Prefer const (');
      // blocker before nit — severity order, not insertion order.
      expect(rounds[0]?.body.indexOf('`blocker`')).toBeLessThan(
        rounds[0]?.body.indexOf('`nit`') ?? -1,
      );
      expect(rounds[0]?.headline).toBe('send_back');
    });
  });

  it('reports only the named role — another stage in the same round is invisible', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      await openAttempt(
        { db },
        { featureId: feature.id, stageId: DEVELOP, stageIndex: 0 },
      );
      await openAttempt(
        { db },
        { featureId: feature.id, stageId: 'test', stageIndex: 1 },
      );

      const developer = await readRoleRounds(db, {
        featureId: feature.id,
        stageId: DEVELOP,
      });
      const gate = await readRoleRounds(db, {
        featureId: feature.id,
        stageId: 'test',
      });

      expect(developer[0]?.body).not.toContain('test');
      expect(developer).toHaveLength(1);
      expect(gate).toHaveLength(1);
    });
  });

  it('applies a note to its own round only, replacing that round headline', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);

      const first = await openAttempt(
        { db },
        { featureId: feature.id, stageId: DEVELOP, stageIndex: 0 },
      );
      await closeAttempt(
        { db },
        { stageAttemptId: first.stageAttemptId, status: 'verdict' },
      );
      await endRound(db, first.roundId, 'send_back');
      const second = await openAttempt(
        { db },
        { featureId: feature.id, stageId: DEVELOP, stageIndex: 0 },
      );
      await closeAttempt(
        { db },
        { stageAttemptId: second.stageAttemptId, status: 'verdict' },
      );

      const rounds = await readRoleRounds(db, {
        featureId: feature.id,
        stageId: DEVELOP,
        note: {
          roundId: second.roundId,
          line: 'Committed `abc1234`.',
          headline: 'committed `abc1234`',
        },
      });

      expect(rounds[1]?.headline).toBe('committed `abc1234`');
      expect(rounds[1]?.body.startsWith('Committed `abc1234`.')).toBe(true);
      // Round 1 is untouched by a note addressed to round 2.
      expect(rounds[0]?.headline).toBe('send_back');
      expect(rounds[0]?.body).not.toContain('abc1234');
    });
  });

  it('returns nothing for a role that has never run', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const feature = await seedFeature(db);
      await openAttempt(
        { db },
        { featureId: feature.id, stageId: DEVELOP, stageIndex: 0 },
      );

      const rounds = await readRoleRounds(db, {
        featureId: feature.id,
        stageId: 'security-scan',
      });

      expect(rounds).toEqual([]);
    });
  });
});
