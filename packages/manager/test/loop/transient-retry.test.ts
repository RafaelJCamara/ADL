import { monotonicFactory, ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { migrateToLatest, nowIso, type Database } from '@adl/db';
import {
  MAX_CONSECUTIVE_TRANSIENT_FAILURES,
  TRANSIENT_BACKOFF_BASE_MS,
  transientBackoffMs,
} from '@adl/core/loop';
import {
  TRANSIENT_HISTORY_LOOKBACK,
  checkTransientRetry,
  countConsecutiveTransientFailures,
  transientBackoffRemainingMs,
} from '../../src/loop/transient-retry.js';
import { MAX_CONSECUTIVE_CRASHES } from '../../src/recovery/policy.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * The database half of LOOP-07 (M06 step 6.7).
 *
 * `@adl/core/loop`'s own suite proves the schedule; this file proves what the
 * count is read off, and — the load-bearing half — that a read which *fails*
 * never reports a retry it did not earn.
 */

interface SeedAttempt {
  readonly status: string;
  readonly errorKind: string | null;
  /** Defaults to the round's own instant; set to backdate one attempt. */
  readonly endedAt?: string;
}

/** A feature with a repo row, and nothing else. */
async function seedFeature(db: Kysely<Database>): Promise<string> {
  const at = nowIso();
  const repoId = ulid();
  await db
    .insertInto('repos')
    .values({
      id: repoId,
      remote_url: 'https://example.invalid/demo.git',
      default_branch: 'main',
      forge: 'github',
      features_dir: 'features',
      created_at: at,
      updated_at: at,
    })
    .execute();

  const featureId = ulid();
  await db
    .insertInto('features')
    .values({
      id: featureId,
      repo_id: repoId,
      path: 'features/dark-mode',
      state: 'gating',
      state_version: 1,
      round: 1,
      current_stage_index: 1,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: null,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      heartbeat_at: null,
      crash_count: 0,
      created_at: at,
      updated_at: at,
    })
    .execute();
  return featureId;
}

/** Attempts in the order they happened — oldest first, as the caller reads them. */
async function seedAttempts(
  db: Kysely<Database>,
  featureId: string,
  attempts: readonly SeedAttempt[],
): Promise<void> {
  const at = nowIso();
  const roundId = ulid();
  await db
    .insertInto('rounds')
    .values({
      id: roundId,
      feature_id: featureId,
      number: 1,
      outcome: 'escalate',
      outcome_json: null,
      head_sha: null,
      started_at: at,
      ended_at: at,
    })
    .execute();

  // Strictly increasing ids: these rows are seeded inside one millisecond and
  // the read they feed is ordered newest-first by id, which plain `ulid()`
  // does not guarantee within a millisecond (it re-randomises entropy each
  // call). Production never hits this — attempts for one feature are opened a
  // worker-fork apart — but the seeding has to mean what it says.
  const nextId = monotonicFactory();
  let ordinal = 0;
  for (const attempt of attempts) {
    ordinal += 1;
    await db
      .insertInto('stage_attempts')
      .values({
        id: nextId(),
        round_id: roundId,
        stage_id: 'review',
        stage_index: 1,
        attempt: ordinal,
        status: attempt.status,
        error_kind: attempt.errorKind,
        error_retryable: attempt.errorKind === null ? null : 1,
        error_raw_ref: null,
        started_at: at,
        ended_at: attempt.endedAt ?? at,
      })
      .execute();
  }
}

const broke = (errorKind = 'provider_error'): SeedAttempt => ({
  status: 'error',
  errorKind,
});
const judged: SeedAttempt = { status: 'verdict', errorKind: null };

describe('countConsecutiveTransientFailures', () => {
  it('counts an unbroken run from the newest attempt', () => {
    expect(countConsecutiveTransientFailures([])).toBe(0);
    expect(
      countConsecutiveTransientFailures([
        { status: 'error', error_kind: 'provider_error' },
        { status: 'error', error_kind: 'timeout' },
      ]),
    ).toBe(2);
  });

  it('stops at an attempt that judged — the count is consecutive, not cumulative', () => {
    expect(
      countConsecutiveTransientFailures([
        { status: 'error', error_kind: 'provider_error' },
        { status: 'verdict', error_kind: null },
        { status: 'error', error_kind: 'provider_error' },
        { status: 'error', error_kind: 'provider_error' },
      ]),
    ).toBe(1);
  });

  it('stops at a failure another attempt cannot fix', () => {
    expect(
      countConsecutiveTransientFailures([
        { status: 'error', error_kind: 'auth' },
        { status: 'error', error_kind: 'provider_error' },
      ]),
    ).toBe(0);
  });

  it('treats an error kind it does not recognise as not transient', () => {
    // Fails **closed**, onto the bounded crash ceiling, rather than open onto
    // an unbounded retry budget. A row written by an older build, or by hand,
    // must not be able to buy retries by naming a kind that does not exist.
    expect(
      countConsecutiveTransientFailures([
        { status: 'error', error_kind: 'not-a-real-kind' },
      ]),
    ).toBe(0);
    // Nor by naming none at all.
    expect(
      countConsecutiveTransientFailures([
        { status: 'error', error_kind: null },
      ]),
    ).toBe(0);
  });
});

describe('checkTransientRetry', () => {
  it('retries while the budget lasts, and reports the count it decided on', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedFeature(db);
      await seedAttempts(db, featureId, [broke(), broke()]);

      const result = await checkTransientRetry(
        { db },
        { featureId, kind: 'provider_error' },
      );
      expect(result).toEqual({
        kind: 'retry',
        backoffMs: transientBackoffMs(2),
        consecutiveFailures: 2,
      });
    });
  });

  it('escalates once the run reaches the ceiling', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedFeature(db);
      await seedAttempts(
        db,
        featureId,
        Array.from({ length: MAX_CONSECUTIVE_TRANSIENT_FAILURES }, () =>
          broke(),
        ),
      );

      const result = await checkTransientRetry(
        { db },
        { featureId, kind: 'provider_error' },
      );
      expect(result.kind).toBe('escalate');
    });
  });

  it('never reports a retry when it could not read the history at all', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedFeature(db);
      await seedAttempts(db, featureId, [broke()]);
      // A read that cannot run must not become "no failures yet, retry
      // freely" — that is the fail-open bug this check exists to prevent
      // (CORE-06), the same discipline `checkStalemate` holds itself to. The
      // caller falls back to the bounded crash ceiling instead.
      await db.destroy();

      const result = await checkTransientRetry(
        { db },
        { featureId, kind: 'provider_error' },
      );
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.detail).toContain('stage-attempt history');
      }
    });
  });

  it('reads only as far back as the ceiling needs', () => {
    // Derived from the ceiling rather than restated, so raising one raises the
    // other and the lookback can never silently become too short to see the
    // run it is counting.
    expect(TRANSIENT_HISTORY_LOOKBACK).toBe(
      MAX_CONSECUTIVE_TRANSIENT_FAILURES + 1,
    );
  });

  it('gives the provider a longer run than a crashing feature gets', () => {
    // The whole reason the two budgets are separate. Asserted where both
    // constants are importable — `@adl/core` cannot see the manager's.
    expect(MAX_CONSECUTIVE_TRANSIENT_FAILURES).toBeGreaterThan(
      MAX_CONSECUTIVE_CRASHES,
    );
  });
});

describe('transientBackoffRemainingMs', () => {
  it('is undefined when nothing transient ended the run', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedFeature(db);

      // No history at all.
      expect(
        await transientBackoffRemainingMs({ db }, featureId, nowIso()),
      ).toBeUndefined();

      // And a run whose newest attempt judged is not waiting either.
      await seedAttempts(db, featureId, [broke(), judged]);
      expect(
        await transientBackoffRemainingMs({ db }, featureId, nowIso()),
      ).toBeUndefined();
    });
  });

  it('holds a feature for the backoff its failure count earned', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedFeature(db);
      const endedAt = '2026-09-01T12:00:00.000Z';
      await seedAttempts(db, featureId, [{ ...broke(), endedAt }]);

      // One failure buys the base wait. Immediately after it ended, the whole
      // wait is still outstanding.
      expect(
        await transientBackoffRemainingMs({ db }, featureId, endedAt),
      ).toBe(TRANSIENT_BACKOFF_BASE_MS);

      const halfway = new Date(
        Date.parse(endedAt) + TRANSIENT_BACKOFF_BASE_MS / 2,
      ).toISOString();
      expect(
        await transientBackoffRemainingMs({ db }, featureId, halfway),
      ).toBe(TRANSIENT_BACKOFF_BASE_MS / 2);
    });
  });

  it('releases the feature once the window has passed', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedFeature(db);
      const endedAt = '2026-09-01T12:00:00.000Z';
      await seedAttempts(db, featureId, [{ ...broke(), endedAt }]);

      const after = new Date(
        Date.parse(endedAt) + TRANSIENT_BACKOFF_BASE_MS,
      ).toISOString();
      // Boundary: exactly at the ready instant is *not* still waiting.
      expect(
        await transientBackoffRemainingMs({ db }, featureId, after),
      ).toBeUndefined();
    });
  });

  it('does not stall a feature indefinitely when the history cannot be read', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await seedFeature(db);
      await db.destroy();
      // The opposite direction from `checkTransientRetry`'s own read failure,
      // and deliberately so: a backoff that cannot be computed must not become
      // an indefinite hold on a feature. The retry budget is already bounded,
      // so letting the dispatch proceed is the conservative answer here.
      expect(
        await transientBackoffRemainingMs({ db }, featureId, nowIso()),
      ).toBeUndefined();
    });
  });
});
