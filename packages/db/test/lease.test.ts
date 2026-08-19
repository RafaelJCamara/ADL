import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';

import {
  assertIsoTimestamp,
  featuresRepository,
  ISO_TIMESTAMP_PATTERN,
  migrateToLatest,
  nowIso,
  type FeaturesRepository,
} from '../src/index.js';
import { MIGRATIONS_DIR, withTempDb } from './helpers/temp-db.js';

const NOW = '2026-08-19T12:00:00.000Z';
const PAST = '2026-08-19T11:00:00.000Z';
const FUTURE = '2026-08-19T13:00:00.000Z';

async function insertQueuedFeature(
  db: Parameters<typeof featuresRepository>[0],
  overrides: Partial<{
    lease_owner: string | null;
    lease_token: string | null;
    lease_expires_at: string | null;
    heartbeat_at: string | null;
  }> = {},
): Promise<string> {
  const repoId = ulid();
  const featureId = ulid();

  await db
    .insertInto('repos')
    .values({
      id: repoId,
      remote_url: 'https://github.com/example/target-repo.git',
      default_branch: 'main',
      forge: 'github',
      features_dir: 'features',
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();

  await db
    .insertInto('features')
    .values({
      id: featureId,
      repo_id: repoId,
      path: `features/${featureId}`,
      state: 'queued',
      state_version: 1,
      round: 0,
      current_stage_index: 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: null,
      lease_owner: overrides.lease_owner ?? null,
      lease_token: overrides.lease_token ?? null,
      lease_expires_at: overrides.lease_expires_at ?? null,
      heartbeat_at: overrides.heartbeat_at ?? null,
      crash_count: 0,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();

  return featureId;
}

describe('nowIso and assertIsoTimestamp', () => {
  it('nowIso returns a string matching the fixed-width ISO-8601 form', () => {
    expect(nowIso()).toMatch(ISO_TIMESTAMP_PATTERN);
  });

  it('assertIsoTimestamp accepts nowIso()-shaped strings', () => {
    expect(() => assertIsoTimestamp(nowIso(), 'field')).not.toThrow();
    expect(() => assertIsoTimestamp(NOW, 'field')).not.toThrow();
  });

  it('assertIsoTimestamp rejects any other shape, naming the field', () => {
    expect(() => assertIsoTimestamp('2026-08-19', 'leaseExpiresAt')).toThrow(
      /leaseExpiresAt/,
    );
    expect(() =>
      assertIsoTimestamp('2026-08-19T12:00:00Z', 'leaseExpiresAt'),
    ).toThrow(/leaseExpiresAt/);
    expect(() =>
      assertIsoTimestamp('Aug 19 2026 12:00:00', 'leaseExpiresAt'),
    ).toThrow(/leaseExpiresAt/);
  });
});

describe('acquireLease', () => {
  it('succeeds against an unheld row (lease_token null), writing owner, token, expiry, and heartbeat together', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);
      const featureId = await insertQueuedFeature(db);
      const token = ulid();

      const acquired = await repo.acquireLease({
        id: featureId,
        leaseOwner: 'worker-1',
        leaseToken: token,
        leaseExpiresAt: FUTURE,
        heartbeatAt: NOW,
      });

      expect(acquired).toBe(true);

      const row = await repo.findById(featureId);
      expect(row?.lease_owner).toBe('worker-1');
      expect(row?.lease_token).toBe(token);
      expect(row?.lease_expires_at).toBe(FUTURE);
      expect(row?.heartbeat_at).toBe(NOW);
    });
  });

  it('succeeds against a row whose lease_expires_at is in the past', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);
      const featureId = await insertQueuedFeature(db, {
        lease_owner: 'worker-stale',
        lease_token: ulid(),
        lease_expires_at: PAST,
        heartbeat_at: PAST,
      });
      const token = ulid();

      const acquired = await repo.acquireLease({
        id: featureId,
        leaseOwner: 'worker-2',
        leaseToken: token,
        leaseExpiresAt: FUTURE,
        heartbeatAt: NOW,
      });

      expect(acquired).toBe(true);

      const row = await repo.findById(featureId);
      expect(row?.lease_token).toBe(token);
    });
  });

  it('fails against a row whose lease_expires_at is in the future, leaving every lease column unchanged', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);
      const liveToken = ulid();
      const featureId = await insertQueuedFeature(db, {
        lease_owner: 'worker-1',
        lease_token: liveToken,
        lease_expires_at: FUTURE,
        heartbeat_at: PAST,
      });

      const acquired = await repo.acquireLease({
        id: featureId,
        leaseOwner: 'worker-2',
        leaseToken: ulid(),
        leaseExpiresAt: FUTURE,
        heartbeatAt: NOW,
      });

      expect(acquired).toBe(false);

      const row = await repo.findById(featureId);
      expect(row?.lease_owner).toBe('worker-1');
      expect(row?.lease_token).toBe(liveToken);
      expect(row?.lease_expires_at).toBe(FUTURE);
      expect(row?.heartbeat_at).toBe(PAST);
    });
  });

  it('two sequential calls with different tokens against the same unheld row: first wins, second loses', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);
      const featureId = await insertQueuedFeature(db);

      const first = await repo.acquireLease({
        id: featureId,
        leaseOwner: 'worker-1',
        leaseToken: ulid(),
        leaseExpiresAt: FUTURE,
        heartbeatAt: NOW,
      });
      const second = await repo.acquireLease({
        id: featureId,
        leaseOwner: 'worker-2',
        leaseToken: ulid(),
        leaseExpiresAt: FUTURE,
        heartbeatAt: NOW,
      });

      expect(first).toBe(true);
      expect(second).toBe(false);
    });
  });
});

describe('renewLease', () => {
  it('with the current token returns true and advances heartbeat_at and lease_expires_at', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);
      const token = ulid();
      const featureId = await insertQueuedFeature(db, {
        lease_owner: 'worker-1',
        lease_token: token,
        lease_expires_at: FUTURE,
        heartbeat_at: PAST,
      });
      const newExpiry = '2026-08-19T14:00:00.000Z';

      const renewed = await repo.renewLease({
        id: featureId,
        leaseToken: token,
        heartbeatAt: NOW,
        leaseExpiresAt: newExpiry,
      });

      expect(renewed).toBe(true);

      const row = await repo.findById(featureId);
      expect(row?.heartbeat_at).toBe(NOW);
      expect(row?.lease_expires_at).toBe(newExpiry);
    });
  });

  it('with a stale token returns false and changes nothing — the fence at the SQL layer, no manager code involved', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);
      const currentToken = ulid();
      const featureId = await insertQueuedFeature(db, {
        lease_owner: 'worker-1',
        lease_token: currentToken,
        lease_expires_at: FUTURE,
        heartbeat_at: PAST,
      });

      const renewed = await repo.renewLease({
        id: featureId,
        leaseToken: ulid(), // stale — does not match the row's lease_token
        heartbeatAt: NOW,
        leaseExpiresAt: '2026-08-19T14:00:00.000Z',
      });

      expect(renewed).toBe(false);

      const row = await repo.findById(featureId);
      expect(row?.heartbeat_at).toBe(PAST);
      expect(row?.lease_expires_at).toBe(FUTURE);
      expect(row?.lease_token).toBe(currentToken);
    });
  });
});

describe('expireLease', () => {
  it('with the current token clears owner, token, and expiry', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);
      const token = ulid();
      const featureId = await insertQueuedFeature(db, {
        lease_owner: 'worker-1',
        lease_token: token,
        lease_expires_at: PAST,
        heartbeat_at: PAST,
      });

      const expired = await repo.expireLease({ id: featureId, leaseToken: token });

      expect(expired).toBe(true);

      const row = await repo.findById(featureId);
      expect(row?.lease_owner).toBeNull();
      expect(row?.lease_token).toBeNull();
      expect(row?.lease_expires_at).toBeNull();
    });
  });

  it('with a stale token returns false', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);
      const currentToken = ulid();
      const featureId = await insertQueuedFeature(db, {
        lease_owner: 'worker-1',
        lease_token: currentToken,
        lease_expires_at: PAST,
        heartbeat_at: PAST,
      });

      const expired = await repo.expireLease({
        id: featureId,
        leaseToken: ulid(),
      });

      expect(expired).toBe(false);

      const row = await repo.findById(featureId);
      expect(row?.lease_token).toBe(currentToken);
    });
  });
});

describe('releaseLease', () => {
  it('with the current token clears owner, token, and expiry, same as expireLease', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);
      const token = ulid();
      const featureId = await insertQueuedFeature(db, {
        lease_owner: 'worker-1',
        lease_token: token,
        lease_expires_at: FUTURE,
        heartbeat_at: NOW,
      });

      const released = await repo.releaseLease({ id: featureId, leaseToken: token });

      expect(released).toBe(true);

      const row = await repo.findById(featureId);
      expect(row?.lease_owner).toBeNull();
      expect(row?.lease_token).toBeNull();
      expect(row?.lease_expires_at).toBeNull();
    });
  });
});

describe('listExpiredLeases', () => {
  it('returns only rows whose lease_expires_at is strictly less than now, ordered by id', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);

      const expiredId = await insertQueuedFeature(db, {
        lease_owner: 'worker-1',
        lease_token: ulid(),
        lease_expires_at: PAST,
        heartbeat_at: PAST,
      });
      const liveId = await insertQueuedFeature(db, {
        lease_owner: 'worker-2',
        lease_token: ulid(),
        lease_expires_at: FUTURE,
        heartbeat_at: NOW,
      });
      const unleasedId = await insertQueuedFeature(db);
      void liveId;
      void unleasedId;

      const expired = await repo.listExpiredLeases(NOW);

      expect(expired.map((r) => r.id)).toEqual([expiredId]);
    });
  });
});

describe('listLeased', () => {
  it('returns every currently-leased row, ordered by id', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);

      const leasedId = await insertQueuedFeature(db, {
        lease_owner: 'worker-1',
        lease_token: ulid(),
        lease_expires_at: FUTURE,
        heartbeat_at: NOW,
      });
      const unleasedId = await insertQueuedFeature(db);
      void unleasedId;

      const leased = await repo.listLeased();

      expect(leased.map((r) => r.id)).toEqual([leasedId]);
    });
  });
});

describe('listQueued', () => {
  it('returns queued rows ordered by id — ULID order is FIFO (D-17)', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repo = featuresRepository(db);

      const firstId = await insertQueuedFeature(db);
      const secondId = await insertQueuedFeature(db);

      const queued = await repo.listQueued();

      expect(queued.map((r) => r.id)).toEqual([firstId, secondId].sort());
      expect(queued.every((r) => r.state === 'queued')).toBe(true);
    });
  });
});

describe('D-08: leaseToken is required, not optional, on every lease-scoped input (type-level)', () => {
  it('proves the compile-time guarantee — this test never runs its body', () => {
    // The point of this test is entirely in the annotations below. If any of
    // `leaseToken` were ever relaxed to optional, the `@ts-expect-error`
    // comment would report an unused-suppression error and turn
    // `pnpm --filter @adl/db typecheck` red — which is the guarantee itself,
    // not a description of it.
    const repo = {} as FeaturesRepository;

    const callAcquire = () =>
      // @ts-expect-error — leaseToken is required on AcquireLeaseInput; omitting it must fail to typecheck
      repo.acquireLease({
        id: 'feature-1',
        leaseOwner: 'worker-1',
        leaseExpiresAt: NOW,
        heartbeatAt: NOW,
      });

    const callRenew = () =>
      // @ts-expect-error — leaseToken is required on RenewLeaseInput; omitting it must fail to typecheck
      repo.renewLease({ id: 'feature-1', heartbeatAt: NOW, leaseExpiresAt: NOW });

    const callExpire = () =>
      // @ts-expect-error — leaseToken is required on ExpireLeaseInput; omitting it must fail to typecheck
      repo.expireLease({ id: 'feature-1' });

    const callRelease = () =>
      // @ts-expect-error — leaseToken is required on ReleaseLeaseInput; omitting it must fail to typecheck
      repo.releaseLease({ id: 'feature-1' });

    void callAcquire;
    void callRenew;
    void callExpire;
    void callRelease;
  });
});
