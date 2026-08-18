/**
 * The worktree backend's snapshot anchoring (02-REVIEW.md WR-09).
 *
 * The contract suite already covers capture / restore / release for both
 * backends. What it cannot cover is a property of *this* backend's storage: the
 * anchoring ref used to be `refs/adl-snapshots/<featureId>/<sha>`, keyed on
 * CONTENT, while a handle is per CAPTURE. Two snapshots of an unchanged
 * worktree — a clean tree twice, or two `stash create`s over the same tree and
 * parent — therefore shared one ref, and `release()` on the first deleted the
 * thing the second was still relying on. The second handle's `released` flag
 * stayed `false`, so it reported itself live and would have attempted a restore
 * of an object one `git gc` away from gone.
 *
 * That is exactly the failure `SNAPSHOT_REF_PREFIX`'s own docblock says the
 * anchoring exists to prevent: "a restore handle whose object was collected is
 * a restore that fails at the worst possible moment."
 *
 * This lives outside `test/helpers/contract.ts` on purpose. The contract file's
 * rule is that no case there may name a backend or reason about a concrete
 * implementation, and a ref layout is as concrete as it gets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Workspace } from '@adl/core/stage';
import { workspaceRegistry } from '../../src/registry.js';
import { CONTRACT_SEEDED_FILE } from '../helpers/contract.js';
import { openTempRepo, type OpenedTempRepo } from '../helpers/temp-repo.js';

let repo: OpenedTempRepo;

beforeAll(async () => {
  repo = await openTempRepo();
});

afterAll(async () => {
  await repo.cleanup();
});

/** A live worktree workspace, resolved the way the manager resolves one. */
async function freshWorkspace(featureId: string): Promise<Workspace> {
  return workspaceRegistry().resolve('worktree').create({
    featureId,
    mainRepo: repo.mainRepo,
    scratchRoot: repo.scratchRoot,
    baseRef: 'HEAD',
  });
}

/** Every snapshot ref the repository currently holds. */
async function snapshotRefs(): Promise<readonly string[]> {
  const raw = await repo.git.raw([
    'for-each-ref',
    '--format=%(refname)',
    'refs/adl-snapshots',
  ]);
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

describe('two snapshots at the same sha do not share one anchoring ref', () => {
  it('keeps the second handle anchored when the first is released', async () => {
    // A CLEAN worktree, which is the deterministic route to a shared sha and
    // the likelier one in production: there is nothing to stash, so `snapshot()`
    // captures `HEAD`, and every capture of an untouched worktree yields the
    // same commit. (The dirty route reaches the same place less reliably —
    // `git stash create` writes a commit whose committer timestamp lands in the
    // object, so two dirty captures a second apart differ. Asserting on that
    // would make this case depend on how fast the machine is.)
    const workspace = await freshWorkspace('snap-alias');
    const mine = (refs: readonly string[]): readonly string[] =>
      refs.filter((ref) => ref.includes('snap-alias'));

    try {
      const first = await workspace.snapshot();
      const second = await workspace.snapshot();

      expect(
        second.id,
        'the two captures produced different shas, so this case is no longer exercising the aliasing it exists for',
      ).toBe(first.id);

      // Two handles, two refs. Keyed on content — which is what shipped — this
      // was one, and the second `update-ref` merely rewrote the first's.
      expect(
        mine(await snapshotRefs()),
        'two captures must anchor independently; one ref for two live handles is WR-09',
      ).toHaveLength(2);

      await first.release();

      // The load-bearing assertion. The second handle never said it was
      // released — `restore()` still resolves rather than throwing — so
      // something must still be keeping its commit reachable. Before the fix,
      // releasing the first deleted the only ref there was.
      expect(
        mine(await snapshotRefs()),
        'releasing the FIRST handle unanchored the second, which still reports itself live (WR-09)',
      ).toHaveLength(1);

      await workspace.write(CONTRACT_SEEDED_FILE, 'mutated-contents');
      await expect(second.restore()).resolves.toBeUndefined();
      await expect(workspace.read(CONTRACT_SEEDED_FILE)).resolves.toBe(
        'original\n',
      );

      await second.release();

      expect(mine(await snapshotRefs())).toEqual([]);
    } finally {
      await workspace.destroy();
    }
  });

  it('deletes exactly its own anchor when captures genuinely differ', async () => {
    // The ordinary case, for the symmetric mistake: a per-capture ref that was
    // built from a counter alone would collide across features, and a release
    // that deleted a prefix rather than a ref would take a sibling's anchor
    // with it.
    const workspace = await freshWorkspace('snap-distinct');
    const mine = (refs: readonly string[]): readonly string[] =>
      refs.filter((ref) => ref.includes('snap-distinct'));

    try {
      await workspace.write(CONTRACT_SEEDED_FILE, 'first-contents');
      const first = await workspace.snapshot();

      await workspace.write(CONTRACT_SEEDED_FILE, 'second-contents');
      const second = await workspace.snapshot();

      expect(second.id).not.toBe(first.id);
      expect(mine(await snapshotRefs())).toHaveLength(2);

      await second.release();
      expect(mine(await snapshotRefs())).toHaveLength(1);

      await expect(first.restore()).resolves.toBeUndefined();
      await expect(workspace.read(CONTRACT_SEEDED_FILE)).resolves.toBe(
        'first-contents',
      );

      await first.release();
      expect(mine(await snapshotRefs())).toEqual([]);
    } finally {
      await workspace.destroy();
    }
  });
});
