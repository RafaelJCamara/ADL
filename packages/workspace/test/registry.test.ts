/**
 * The registry itself, plus the one snapshot behaviour that cannot live in the
 * shared contract suite.
 *
 * Everything a backend does *as a backend* belongs in
 * `test/contract/workspace-contract.test.ts`, where it runs twice. What is here
 * is deliberately the residue: how ids resolve, and the worktree backend's
 * refusal to snapshot over untracked files — which is a statement about git,
 * not about the port, and would need a per-backend conditional to express in a
 * suite that must not have one.
 */
import type { WorkspaceBackend } from '@adl/core/stage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceError } from '../src/errors.js';
import { WORKSPACE_BACKEND_IDS, workspaceRegistry } from '../src/registry.js';
import { openTempRepo, type OpenedTempRepo } from './helpers/temp-repo.js';

describe('the workspace backend registry (D-04)', () => {
  it('resolves each built-in id to a backend that answers to it', () => {
    const registry = workspaceRegistry();

    for (const id of WORKSPACE_BACKEND_IDS) {
      expect(registry.resolve(id).id).toBe(id);
    }
  });

  it('registers exactly the built-in ids by default', () => {
    expect(workspaceRegistry().ids()).toEqual([...WORKSPACE_BACKEND_IDS]);
  });

  it('throws on an unknown id, naming it and listing what is registered', () => {
    // T-2-26. The failure mode this replaces is silent: an `undefined` backend
    // surfaces as a null dereference three frames from the typo, and a default
    // would run the feature under isolation guarantees nobody chose.
    let thrown: Error | undefined;
    try {
      workspaceRegistry().resolve('worktre');
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(WorkspaceError);
    expect(thrown!.message).toContain('worktre');
    expect(thrown!.message).toContain('worktree');
    expect(thrown!.message).toContain('stub');
  });

  it('accepts a backend the daemon configured, without this package knowing it', () => {
    // The seam v2's container backend arrives through: it implements
    // `WorkspaceBackend` from `@adl/core/stage` and never imports this package.
    const outOfTree: WorkspaceBackend = {
      id: 'container',
      create: () => Promise.reject(new Error('not called')),
      list: () => Promise.resolve([]),
    };

    const registry = workspaceRegistry({ backends: [outOfTree] });

    expect(registry.resolve('container')).toBe(outOfTree);
    expect(registry.ids()).toContain('container');
  });
});

describe('snapshot refuses rather than capturing a partial state', () => {
  let repo: OpenedTempRepo;

  beforeAll(async () => {
    repo = await openTempRepo();
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it('names the untracked paths instead of returning a handle that omits them', async () => {
    const workspace = await workspaceRegistry().resolve('worktree').create({
      featureId: 'snapshot-untracked',
      mainRepo: repo.mainRepo,
      scratchRoot: repo.scratchRoot,
      baseRef: 'HEAD',
    });

    try {
      // A clean worktree snapshots fine — established first so the failure
      // below is attributable to the untracked file and nothing else.
      const clean = await workspace.snapshot();
      await clean.release();

      await workspace.write('brand-new.txt', 'the agent wrote this');

      // `git stash create` has no --include-untracked, so a handle here would
      // silently omit the file and a later restore would delete the agent's
      // work without saying so.
      await expect(workspace.snapshot()).rejects.toThrow(WorkspaceError);
      await expect(workspace.snapshot()).rejects.toThrow('brand-new.txt');
    } finally {
      await workspace.destroy();
    }
  });
});
