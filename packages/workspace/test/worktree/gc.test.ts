import { access, rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import {
  featuresRepository,
  migrateToLatest,
  type Database,
  type NewFeature,
} from '@adl/db';
import { sweepOrphans, type SweepFailure } from '../../src/worktree/gc.js';
import { createWorktree } from '../../src/worktree/lifecycle.js';
import { listManagedWorktrees } from '../../src/worktree/list.js';
import { openTempRepo, type OpenedTempRepo } from '../helpers/temp-repo.js';
// The db package's own fixture, reused rather than reimplemented: it insists on
// a real file rather than `:memory:` (D-30), and the point of this test is to
// prove the join works against the real schema instead of a hand-written fake
// that would agree with whatever the sweep happens to do.
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * The GC sweep, against a real git repository AND a real migrated database.
 *
 * Both halves are real on purpose. A fake lookup would prove the sweep calls
 * the function it was given; it would not prove that the thing the manager
 * will actually bind in Phase 3 — `featuresRepository.findById` reading the
 * `state` column — returns something the sweep understands.
 */

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** The `adl/*` branches git currently knows about. `+` marks linked worktrees. */
const adlBranches = async (repo: OpenedTempRepo): Promise<string[]> =>
  (await repo.git.raw(['branch', '--list', 'adl/*']))
    .split('\n')
    .map((line) => line.replace(/^[*+]/, '').trim())
    .filter((line) => line !== '');

const NOW = '2026-08-18T00:00:00.000Z';

/** A `features` row in the given state. Only `state` matters to the sweep. */
const featureRow = (id: string, state: string): NewFeature => ({
  id,
  repo_id: 'repo-1',
  path: `features/${id}`,
  state,
  state_version: 1,
  round: 0,
  current_stage_index: 0,
  spec_hash: 'sha256:none',
  effective_config_json: null,
  workspace_handle: null,
  lease_owner: null,
  lease_token: null,
  lease_expires_at: null,
  heartbeat_at: null,
  crash_count: 0,
  created_at: NOW,
  updated_at: NOW,
});

/**
 * Stand up a migrated database with a `repos` row, and hand back a lookup
 * bound the way the manager will bind it in Phase 3.
 */
async function withBoundLookup<T>(
  fn: (ctx: {
    readonly db: Kysely<Database>;
    readonly insert: (id: string, state: string) => Promise<void>;
    readonly lookupFeatureState: (id: string) => Promise<string | undefined>;
  }) => Promise<T>,
): Promise<T> {
  return withTempDb(async ({ db }) => {
    await migrateToLatest(db, MIGRATIONS_DIR);

    const features = featuresRepository(db);

    await db
      .insertInto('repos')
      .values({
        id: 'repo-1',
        remote_url: 'https://example.invalid/repo.git',
        default_branch: 'master',
        forge: 'github',
        features_dir: 'features',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();

    return fn({
      db,
      insert: (id, state) => features.insert(featureRow(id, state)),
      // Exactly the binding D-20 says the manager owns: findById, reading the
      // state column. Nothing about it is workspace-specific.
      lookupFeatureState: async (id) => (await features.findById(id))?.state,
    });
  });
}

describe('sweepOrphans', () => {
  it('collects terminal and unknown features, and spares the rest', async () => {
    const repo = await openTempRepo();

    try {
      await withBoundLookup(async ({ insert, lookupFeatureState }) => {
        // Four features with rows, one without.
        await insert('gone-merged', 'merged');
        await insert('gone-abandoned', 'abandoned');
        await insert('kept-escalated', 'escalated');
        await insert('kept-developing', 'developing');

        for (const id of [
          'gone-merged',
          'gone-abandoned',
          'kept-escalated',
          'kept-developing',
          'gone-unknown', // deliberately has no row at all
        ]) {
          await createWorktree(repo.mainRepo, repo.scratchRoot, id, 'HEAD');
        }

        const failures: SweepFailure[] = [];
        const removed = await sweepOrphans({
          mainRepo: repo.mainRepo,
          lookupFeatureState,
          onFailure: (failure) => failures.push(failure),
        });

        expect(failures).toEqual([]);
        expect([...removed].sort()).toEqual([
          'gone-abandoned',
          'gone-merged',
          'gone-unknown',
        ]);

        // Collected: worktree AND branch, both halves, for each.
        const branches = await adlBranches(repo);
        for (const id of ['gone-merged', 'gone-abandoned', 'gone-unknown']) {
          expect(await exists(`${repo.scratchRoot}/${id}`)).toBe(false);
          expect(branches).not.toContain(`adl/${id}`);
        }

        // Spared. `escalated` is the load-bearing one: the lifecycle draws a
        // human-retry edge out of it, so a human is coming back to this
        // worktree and destroying it would destroy their work (T-2-12).
        for (const id of ['kept-escalated', 'kept-developing']) {
          expect(await exists(`${repo.scratchRoot}/${id}`)).toBe(true);
          expect(branches).toContain(`adl/${id}`);
        }
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('is a no-op on a second consecutive pass', async () => {
    const repo = await openTempRepo();

    try {
      await withBoundLookup(async ({ insert, lookupFeatureState }) => {
        await insert('done-1', 'merged');
        await createWorktree(repo.mainRepo, repo.scratchRoot, 'done-1', 'HEAD');

        const first = await sweepOrphans({
          mainRepo: repo.mainRepo,
          lookupFeatureState,
        });
        expect(first).toEqual(['done-1']);

        // Nothing left to find, and finding nothing is not an error — this is
        // what a scheduled backstop does on almost every run.
        const second = await sweepOrphans({
          mainRepo: repo.mainRepo,
          lookupFeatureState,
        });
        expect(second).toEqual([]);
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('leaves a repository with no worktree and no adl/* branch (success criterion 1)', async () => {
    const repo = await openTempRepo();

    try {
      await withBoundLookup(async ({ insert, lookupFeatureState }) => {
        // Many features, reaching the end by the two different routes a real
        // daemon produces: a clean terminal transition, and a crash that left
        // the directory deleted out from under git.
        const merged = ['f-01', 'f-02', 'f-03', 'f-04'];
        const crashed = ['f-05', 'f-06'];
        const abandoned = ['f-07', 'f-08'];

        for (const id of [...merged, ...crashed]) await insert(id, 'merged');
        for (const id of abandoned) await insert(id, 'abandoned');

        for (const id of [...merged, ...crashed, ...abandoned]) {
          await createWorktree(repo.mainRepo, repo.scratchRoot, id, 'HEAD');
        }

        // The crash shape: the directory vanishes, git's administrative entry
        // and the branch both survive. This is precisely the state that makes
        // a worktree-only teardown check look green while the repo rots.
        for (const id of crashed) {
          await rm(`${repo.scratchRoot}/${id}`, {
            recursive: true,
            force: true,
          });
        }

        const removed = await sweepOrphans({
          mainRepo: repo.mainRepo,
          lookupFeatureState,
        });
        expect([...removed].sort()).toEqual(
          [...merged, ...crashed, ...abandoned].sort(),
        );

        // ── The criterion, asserted as two independent halves ──────────────
        // Worktrees: git names no path under the scratch root.
        const worktreeList = await repo.git.raw(['worktree', 'list']);
        expect(worktreeList).not.toContain(repo.scratchRoot);
        expect(await listManagedWorktrees(repo.mainRepo)).toEqual([]);

        // Branches: and no `adl/*` branch survived either. Plan 02-03 proved
        // the first assertion passes on its own while this one fails, which
        // is the entire reason both are here.
        expect((await repo.git.raw(['branch', '--list', 'adl/*'])).trim()).toBe(
          '',
        );
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('continues past a per-entry failure and reports it', async () => {
    const repo = await openTempRepo();

    try {
      await withBoundLookup(async ({ insert, lookupFeatureState }) => {
        await insert('boom', 'merged');
        await insert('after-boom', 'merged');
        for (const id of ['boom', 'after-boom']) {
          await createWorktree(repo.mainRepo, repo.scratchRoot, id, 'HEAD');
        }

        const failures: SweepFailure[] = [];
        const removed = await sweepOrphans({
          mainRepo: repo.mainRepo,
          // The lookup itself throws for one entry. A sweep that aborted here
          // would strand every orphan after it (T-2-13).
          lookupFeatureState: async (id) => {
            if (id === 'boom') throw new Error('state store unavailable');
            return lookupFeatureState(id);
          },
          onFailure: (failure) => failures.push(failure),
        });

        expect(removed).toEqual(['after-boom']);
        expect(failures).toHaveLength(1);
        expect(failures[0]?.featureId).toBe('boom');

        // The one that failed is untouched, both halves — a reported failure
        // must not be a partial teardown.
        expect(await exists(`${repo.scratchRoot}/boom`)).toBe(true);
        expect(await adlBranches(repo)).toContain('adl/boom');
      });
    } finally {
      await repo.cleanup();
    }
  });
});
