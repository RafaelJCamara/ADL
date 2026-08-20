import {
  migrateToLatest,
  nowIso,
  reposRepository,
  type Database,
  type FeaturesTable,
} from '@adl/db';
import { forkWorker } from '@adl/workspace';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  decodeLeaseOwner,
  encodeLeaseOwner,
  killBootOrphans,
  readProcessStartTime,
  type LeaseOwnerRecord,
} from '../../src/boot/orphans.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';
import { requirePlatform } from '../helpers/platform.js';
import { withScriptedWorker } from '../helpers/worker-harness.js';
// Reused directly, per 03-CONTEXT.md's read_first list.
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

async function insertLeasedFeature(
  db: Kysely<Database>,
  overrides: Partial<FeaturesTable> = {},
): Promise<string> {
  const now = nowIso();
  const repoId = 'repo-1';
  await reposRepository(db).upsert({
    id: repoId,
    remote_url: 'git@example.com:acme/repo.git',
    default_branch: 'main',
    forge: 'github',
    features_dir: 'features',
    created_at: now,
    updated_at: now,
  });
  const featureId = `feature-${Math.random().toString(36).slice(2)}`;
  await db
    .insertInto('features')
    .values({
      id: featureId,
      repo_id: repoId,
      path: `features/${featureId}`,
      state: 'leased',
      state_version: 1,
      round: 0,
      current_stage_index: 0,
      spec_hash: 'x',
      effective_config_json: null,
      workspace_handle: null,
      lease_owner: null,
      lease_token: 'tok-1',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      heartbeat_at: now,
      crash_count: 0,
      created_at: now,
      updated_at: now,
      ...overrides,
    })
    .execute();
  return featureId;
}

describe('encodeLeaseOwner / decodeLeaseOwner', () => {
  it('round-trips a PID and a start time through a single TEXT column', () => {
    const record: LeaseOwnerRecord = { pid: 4242, startTime: '123456' };
    const encoded = encodeLeaseOwner(record);
    expect(typeof encoded).toBe('string');
    expect(decodeLeaseOwner(encoded)).toEqual(record);
  });

  it('round-trips a null start time (Windows degradation)', () => {
    const record: LeaseOwnerRecord = { pid: 4242, startTime: null };
    expect(decodeLeaseOwner(encodeLeaseOwner(record))).toEqual(record);
  });

  it('decodes null and unparseable/undecodable content as undefined', () => {
    expect(decodeLeaseOwner(null)).toBeUndefined();
    expect(decodeLeaseOwner('manager')).toBeUndefined();
    expect(decodeLeaseOwner('{"not":"a lease owner"}')).toBeUndefined();
  });
});

describe('killBootOrphans — dead PID', () => {
  it('sends no signal for a dead PID, and reports it already gone', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await insertLeasedFeature(db, {
        lease_owner: encodeLeaseOwner({ pid: 999_999, startTime: '1' }),
      });

      const { logger } = createCapturingLogger();
      let signalled: number | undefined;
      const outcomes = await killBootOrphans({
        db,
        logger,
        isProcessAlive: () => false,
        signal: (pid) => {
          signalled = pid;
        },
      });

      expect(signalled).toBeUndefined();
      const outcome = outcomes.find((o) => o.featureId === featureId);
      expect(outcome?.outcome).toBe('skipped-dead');
    });
  });
});

describe('killBootOrphans — start time unavailable', () => {
  it('sends no signal when the start-time probe reports unavailable — asserted by injection, runs on every platform', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await insertLeasedFeature(db, {
        lease_owner: encodeLeaseOwner({ pid: 12345, startTime: '999' }),
      });

      const { logger } = createCapturingLogger();
      let signalled: number | undefined;
      const outcomes = await killBootOrphans({
        db,
        logger,
        isProcessAlive: () => true,
        readStartTime: () => ({ kind: 'unavailable', reason: 'simulated' }),
        signal: (pid) => {
          signalled = pid;
        },
      });

      expect(signalled).toBeUndefined();
      const outcome = outcomes.find((o) => o.featureId === featureId);
      expect(outcome?.outcome).toBe('skipped-unattributable');
    });
  });

  it('sends no signal when the recorded start time itself is null (Windows origin)', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await insertLeasedFeature(db, {
        lease_owner: encodeLeaseOwner({ pid: 12345, startTime: null }),
      });

      const { logger } = createCapturingLogger();
      let signalled: number | undefined;
      const outcomes = await killBootOrphans({
        db,
        logger,
        isProcessAlive: () => true,
        readStartTime: () => ({ kind: 'available', startTime: '1' }),
        signal: (pid) => {
          signalled = pid;
        },
      });

      expect(signalled).toBeUndefined();
      const outcome = outcomes.find((o) => o.featureId === featureId);
      expect(outcome?.outcome).toBe('skipped-unattributable');
    });
  });
});

describe('killBootOrphans — no lease_owner recorded at all', () => {
  it('is not attributable and is skipped silently (no outcome recorded)', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const featureId = await insertLeasedFeature(db, { lease_owner: null });

      const { logger } = createCapturingLogger();
      const outcomes = await killBootOrphans({ db, logger });

      expect(outcomes.find((o) => o.featureId === featureId)).toBeUndefined();
    });
  });
});

describe('killBootOrphans — the load-bearing mismatch case (Linux-gated, a real forked child)', () => {
  it('leaves a real child alive when its recorded start time does not match the current one', async () => {
    const gate = requirePlatform(
      'linux',
      'start-time verification reads /proc, which has no Windows subject (D-33)',
      'EXEC-01',
    );
    if (gate.kind === 'skip') return;

    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const worker = withScriptedWorker();
      const child = forkWorker(worker.entryPath, {
        cwd: worker.cwd,
        execArgv: worker.execArgv,
      });

      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const realStartTime = readProcessStartTime(child.pid);
        expect(realStartTime.kind).toBe('available');

        const featureId = await insertLeasedFeature(db, {
          lease_owner: encodeLeaseOwner({
            pid: child.pid,
            startTime: 'deliberately-wrong',
          }),
        });

        const { logger } = createCapturingLogger();
        let signalled: number | undefined;
        const outcomes = await killBootOrphans({
          db,
          logger,
          signal: (pid) => {
            signalled = pid;
          },
        });

        expect(signalled).toBeUndefined();
        const outcome = outcomes.find((o) => o.featureId === featureId);
        expect(outcome?.outcome).toBe('skipped-mismatch');
        expect(child.child.exitCode).toBeNull(); // still alive — never signalled
      } finally {
        child.child.kill('SIGKILL');
      }
    });
  });

  it('signals a real child whose recorded start time matches exactly', async () => {
    const gate = requirePlatform(
      'linux',
      'start-time verification reads /proc, which has no Windows subject (D-33)',
      'EXEC-01',
    );
    if (gate.kind === 'skip') return;

    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const worker = withScriptedWorker();
      const child = forkWorker(worker.entryPath, {
        cwd: worker.cwd,
        execArgv: worker.execArgv,
      });

      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const realStartTime = readProcessStartTime(child.pid);
        if (realStartTime.kind !== 'available') {
          throw new Error('expected start time to be available on Linux');
        }

        const featureId = await insertLeasedFeature(db, {
          lease_owner: encodeLeaseOwner({
            pid: child.pid,
            startTime: realStartTime.startTime,
          }),
        });

        const { logger } = createCapturingLogger();
        let signalled: number | undefined;
        const outcomes = await killBootOrphans({
          db,
          logger,
          signal: (pid) => {
            signalled = pid;
          },
        });

        expect(signalled).toBe(child.pid);
        const outcome = outcomes.find((o) => o.featureId === featureId);
        expect(outcome?.outcome).toBe('killed');
      } finally {
        child.child.kill('SIGKILL');
      }
    });
  });
});
