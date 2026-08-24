import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonConfigSchema } from '@adl/core/config';
import { migrateToLatest, nowIso } from '@adl/db';
import { sweepOrphans, sweepScratchHomes } from '@adl/workspace';
import {
  createApi,
  createFeatureStateLookup,
  runGcOnce,
  startGcSchedule,
} from '../../src/index.js';
import type { GcRunSummary } from '../../src/index.js';
import { composeBranchFeatureId } from '../../src/branch-identity.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';
import { withEphemeralPort } from '../helpers/ephemeral-port.js';

/**
 * Phase 3 Plan 08, Task 3: the GC schedule and `adl gc` — discharging Phase
 * 2's deferred D-15. `sweepOrphans`/`sweepScratchHomes` are mocked at the
 * `@adl/workspace` module boundary so these tests assert the *binding*
 * (call counts, failure propagation, overlap protection) rather than
 * re-testing the sweeps' own policy, which is Phase 2's own suite.
 */

vi.mock('@adl/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@adl/workspace')>();
  return {
    ...actual,
    sweepOrphans: vi.fn(),
    sweepScratchHomes: vi.fn(),
  };
});

const API_TOKEN = `test-token-${ulid()}`;

beforeEach(() => {
  vi.mocked(sweepOrphans).mockReset().mockResolvedValue([]);
  vi.mocked(sweepScratchHomes).mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runGcOnce', () => {
  it('invokes both sweeps exactly once each', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { logger } = createCapturingLogger();

      await runGcOnce({ mainRepo: '/tmp/main-repo', db, logger });

      expect(sweepOrphans).toHaveBeenCalledTimes(1);
      expect(sweepScratchHomes).toHaveBeenCalledTimes(1);
    });
  });

  it('a thrown failure from one sweep is logged and the other sweep still runs', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { logger, logs } = createCapturingLogger();
      vi.mocked(sweepOrphans).mockRejectedValueOnce(new Error('boom'));

      const summary = await runGcOnce({
        mainRepo: '/tmp/main-repo',
        db,
        logger,
      });

      expect(sweepScratchHomes).toHaveBeenCalledTimes(1);
      expect(summary.worktreesRemoved).toEqual([]);
      expect(
        logs.some(
          (line) =>
            line.level >= 40 &&
            String(line.msg ?? '').includes('orphan-worktree'),
        ),
      ).toBe(true);
    });
  });

  it('binds the real FeatureStateLookup against a temp database', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const now = nowIso();
      const repoId = ulid();
      await db
        .insertInto('repos')
        .values({
          id: repoId,
          remote_url: 'https://github.com/example/target-repo.git',
          default_branch: 'main',
          forge: 'github',
          features_dir: 'features',
          created_at: now,
          updated_at: now,
        })
        .execute();
      const featureId = ulid();
      await db
        .insertInto('features')
        .values({
          id: featureId,
          repo_id: repoId,
          path: `features/${featureId}`,
          state: 'gating',
          state_version: 1,
          round: 0,
          current_stage_index: 0,
          spec_hash: 'a'.repeat(64),
          effective_config_json: null,
          workspace_handle: null,
          lease_owner: null,
          lease_token: null,
          lease_expires_at: null,
          heartbeat_at: null,
          crash_count: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();

      const lookup = createFeatureStateLookup(db);
      expect(await lookup(featureId)).toBe('gating');
      expect(await lookup(ulid())).toBeUndefined();

      // DETECT-05 (5.6): a real dispatch's branch is `featureIdFromBranch`'d
      // down to a composed `<folderName>--<ulid>` string, never the bare
      // row id — the lookup must decode it back to the ULID half before
      // asking the repository, or every real production worktree's GC
      // sweep would treat a live feature's row as unknown and collect it.
      expect(await lookup(composeBranchFeatureId('dark-mode', featureId))).toBe(
        'gating',
      );
      expect(
        await lookup(composeBranchFeatureId('dark-mode', ulid())),
      ).toBeUndefined();
    });
  });
});

describe('the GC interval vs. the reaper cadence', () => {
  it('the default GC interval is at least two orders of magnitude larger than heartbeat_interval_ms', () => {
    const config = DaemonConfigSchema.parse({});
    expect(config.gc.interval_ms).toBeGreaterThanOrEqual(
      config.heartbeat_interval_ms * 100,
    );
  });
});

describe('startGcSchedule — overlap protection', () => {
  it('does not run two passes concurrently when one pass is slower than the tick interval', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;
    vi.mocked(sweepOrphans).mockImplementation(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      concurrent -= 1;
      return [];
    });

    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { logger } = createCapturingLogger();

      const handle = startGcSchedule({
        mainRepo: '/tmp/main-repo',
        db,
        logger,
        intervalMs: 1000,
      });

      await new Promise((resolve) => setTimeout(resolve, 3800));
      handle.stop();

      expect(maxConcurrent).toBeLessThanOrEqual(1);
      expect(calls).toBeGreaterThanOrEqual(2);
    });
  }, 10_000);
});

describe('POST /control/gc', () => {
  it('returns a summary body and requires the bearer token', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      vi.mocked(sweepOrphans).mockResolvedValue(['feature-a']);
      vi.mocked(sweepScratchHomes).mockResolvedValue(['/tmp/scratch-1']);

      const app = createApi({
        apiToken: API_TOKEN,
        schemaVersion: 1,
        listFeatureViews: async () => [],
        db,
        logger: (await import('pino')).default({ level: 'silent' }),
        mainRepo: '/tmp/main-repo',
      });

      await withEphemeralPort(app, async ({ port }) => {
        const unauthed = await fetch(`http://127.0.0.1:${port}/control/gc`, {
          method: 'POST',
        });
        expect(unauthed.status).toBe(401);

        const response = await fetch(`http://127.0.0.1:${port}/control/gc`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${API_TOKEN}` },
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as GcRunSummary;
        expect(body.worktreesRemoved).toEqual(['feature-a']);
        expect(body.scratchHomesRemoved).toEqual(['/tmp/scratch-1']);
      });
    });
  });
});
