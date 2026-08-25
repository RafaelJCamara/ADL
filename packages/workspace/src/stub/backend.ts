/**
 * The second `Workspace` backend — the one that makes success criterion 3
 * provable instead of asserted.
 *
 * A swappable interface with one implementation is unfalsifiable. This backend
 * exists so that "the loop runs against a second backend unchanged" is a thing
 * the contract suite *demonstrates*, twice, with only the registry id differing
 * — and so that v2's container backend is a registry entry rather than a
 * repository-wide sweep.
 *
 * **It is a real implementation, not a mock**, and three specific choices are
 * what keep it from degenerating into one:
 *
 * 1. **`exec` goes through the same `run` as the worktree backend**, with the
 *    same `buildChildEnv` and the same per-run scratch `HOME`. A stub that
 *    faked `exec` would let the contract suite prove that two fakes agree.
 * 2. **Its root is a real `mkdtemp` directory** — see {@link stubWorkspace}.
 * 3. **It calls the same {@link assertWithinRoot}**, not a lexical variant of
 *    its own. Two guards would have to be *argued* to behave identically; one
 *    guard is *observed* to, by the same cases running twice.
 *
 * What is genuinely stubbed is durability: file contents live in a `Map` and
 * die with the process. That is the one axis on which it is weaker than the
 * worktree backend, it is loud when it matters (nothing persists), and T-2-27
 * accepts it at ASVS L1 precisely because the exec path and the credential
 * boundary are not weakened at all.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExecResult,
  ExecSpec,
  LogChunk,
  ManagedWorkspace,
  RestoreHandle,
  Workspace,
  WorkspaceSpec,
} from '@adl/core/stage';
import { WorkspaceError } from '../errors.js';
import { run } from '../exec/run.js';
import { createScratchHome, destroyScratchHome } from '../exec/scratch-home.js';
import { assertCwdWithinRoot, assertWithinRoot } from '../paths.js';
import { report, reportScratchHomeTeardown } from '../teardown.js';

/** One live stub workspace, as the inventory sees it. */
interface LiveStub {
  readonly featureId: string;
  readonly mainRepo: string;
  readonly root: string;
  /**
   * The stub's whole storage, held here rather than in the instance closure so
   * that {@link attachStubWorkspace} hands a second instance the *same* files
   * (M05 step 5.14).
   *
   * A stub whose attach returned an empty map would be a backend on which the
   * contract suite's "a gate sees what the developer wrote" case passes for the
   * wrong reason, which is the failure mode this file's own header warns about
   * for the `mkdtemp` root.
   */
  readonly files: Map<string, string>;
}

/**
 * Every stub workspace this process is currently holding.
 *
 * Module-level mutable state, which is unusual in this repository and is the
 * honest analogue of what the worktree backend reads: `listManagedWorktrees`
 * consults the git repository, a store that also outlives any one instance and
 * is also shared by everything in the process. The stub's "disk" is this map.
 */
const live = new Map<string, LiveStub>();

/** The stub backend's half of D-20's inventory mechanism. */
export function listStubWorkspaces(
  mainRepo: string,
): readonly ManagedWorkspace[] {
  return [...live.values()]
    .filter((entry) => entry.mainRepo === mainRepo)
    .map((entry) => ({ featureId: entry.featureId, locator: entry.root }));
}

/**
 * Stand up an in-memory workspace whose signature matches `worktreeWorkspace`
 * exactly.
 *
 * **The root is a real, empty temp directory, and that is a correctness
 * requirement rather than a convenience.** {@link assertWithinRoot} defeats
 * symlink escape by realpathing the deepest *existing* part of the resolved
 * candidate. Given a root with no filesystem presence, that walk climbs past
 * the intended boundary to some unrelated real ancestor — the OS temp
 * directory, or the drive root — and the containment test silently stops
 * testing containment while still returning cleanly. The contract suite's
 * "write outside the root is rejected" case would then pass on this backend for
 * no reason at all, which is the worst available outcome: a suite that looks
 * like it is proving the guard while proving nothing.
 *
 * So the directory exists so the guard has real ground to stand on. **Nothing
 * is ever written into it** — contents live in `files`, keyed by the path the
 * guard blessed — and `destroy()` removes it. A future contributor optimising
 * away "an empty directory nobody writes to" would silently disarm half the
 * contract suite, which is why this paragraph is here.
 *
 * The alternative considered and rejected: a second, purely lexical guard for
 * the stub to use. That splits containment into two implementations whose
 * behaviour must be argued rather than observed to be identical — the same
 * drift argument that makes `paths.ts` reuse `isRepoRelativePath` instead of
 * writing a second path check.
 */
export async function stubWorkspace(spec: WorkspaceSpec): Promise<Workspace> {
  if (live.has(spec.featureId)) {
    throw new WorkspaceError(
      `Refusing to create a second stub workspace for feature ${JSON.stringify(spec.featureId)}: one is already live. Reclaiming it is a decision made from feature state, not from what happens to be in memory (WORK-04).`,
      spec.featureId,
    );
  }

  // realpath for the same reason `test/helpers/temp-repo.ts` does it: on macOS
  // `os.tmpdir()` is a symlink into /private, and a root that is one spelling
  // of a directory while the guard's realpath produces another would reject
  // every path in it.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'adl-stub-')));

  const entry: LiveStub = {
    featureId: spec.featureId,
    mainRepo: spec.mainRepo,
    root,
    files: new Map<string, string>(),
  };
  live.set(spec.featureId, entry);

  return openStubWorkspace(spec, entry);
}

/**
 * Re-open the stub workspace this spec names, or `undefined` if none is live
 * (M05 step 5.14) — the stub's half of {@link WorkspaceBackend.attach}.
 *
 * **Its answer is honestly weaker than the worktree backend's, and the weakness
 * is the same one this file already declares.** The inventory is a process-local
 * `Map`, so a stub workspace does not survive the process that created it: a
 * forked worker attaching for its second stage finds nothing and creates
 * instead, where the worktree backend would have found the real directory git
 * left on disk. That is durability — the one axis T-2-27 already accepts this
 * backend being weaker on — and not a difference in the *contract*: within one
 * process, attach returns the same root and the same files, which is what the
 * contract suite exercises on both backends.
 *
 * There is no half-present state to refuse here, so unlike the worktree
 * backend this never throws: a `Map` either has the entry or does not.
 */
export function attachStubWorkspace(
  spec: WorkspaceSpec,
): Promise<Workspace | undefined> {
  const entry = live.get(spec.featureId);
  return entry === undefined
    ? Promise.resolve(undefined)
    : openStubWorkspace(spec, entry);
}

/**
 * The instance both entry points return — a fresh scratch `HOME` (per run,
 * D-07) over an existing root and an existing file map (per workspace).
 */
async function openStubWorkspace(
  spec: WorkspaceSpec,
  entry: LiveStub,
): Promise<Workspace> {
  const { root, files } = entry;
  const scratchHome = await createScratchHome();
  let destroyed = false;

  return {
    id: spec.featureId,
    root,
    scratchHome: scratchHome.path,

    async exec(
      execSpec: ExecSpec,
      log: (chunk: LogChunk) => void,
    ): Promise<ExecResult> {
      // The same cwd guard as the worktree backend, against this backend's own
      // real `mkdtemp` root (WR-01) — and the same shared function rather than a
      // variant of its own, for the reason stated at the top of this file about
      // `assertWithinRoot`: two guards would have to be argued to behave
      // identically, one guard is observed to, by the contract case running
      // twice.
      await assertCwdWithinRoot(root, execSpec.cwd);

      // The same runner, the same environment builder, the same scratch home.
      // This line is the reason the contract suite's exec cases mean something.
      return run(execSpec, scratchHome.path, log);
    },

    async read(relPath: string): Promise<string> {
      const absolute = await assertWithinRoot(root, relPath);
      const contents = files.get(absolute);
      if (contents === undefined) {
        throw new WorkspaceError(
          `Cannot read ${JSON.stringify(relPath)} from the workspace: ENOENT.`,
          spec.featureId,
        );
      }
      return contents;
    },

    async write(relPath: string, contents: string): Promise<void> {
      // Intermediate directories need no creating here, which is exactly why
      // the guard has to be the shared one: this backend has no filesystem call
      // that would incidentally reject a bad path for it.
      files.set(await assertWithinRoot(root, relPath), contents);
    },

    snapshot(): Promise<RestoreHandle> {
      const captured = new Map(files);
      let released = false;

      return Promise.resolve({
        // Content-free but stable and unique per capture, matching the worktree
        // backend's contract that `id` is something an audit trail can record.
        id: `stub-${spec.featureId}-${captured.size}-${Date.now()}`,

        restore(): Promise<void> {
          if (released) {
            return Promise.reject(
              new WorkspaceError(
                'Cannot restore this snapshot: it has been released.',
                spec.featureId,
              ),
            );
          }
          // Mutated in place rather than reassigned: since M05 step 5.14 the
          // map is the *workspace's* (`LiveStub.files`), shared with every
          // instance an `attach` hands out, so rebinding a local would restore
          // this instance's view and leave every other one on the pre-restore
          // contents.
          files.clear();
          for (const [path, contents] of captured) files.set(path, contents);
          return Promise.resolve();
        },

        release(): Promise<void> {
          released = true;
          captured.clear();
          return Promise.resolve();
        },
      });
    },

    /**
     * Reclaim this run's scratch `HOME` and leave the workspace live (M05 step
     * 5.14) — the stub's half of `Workspace.detach`.
     *
     * The root directory, the file map, and the inventory entry all survive, so
     * a later {@link attachStubWorkspace} in this process finds exactly what the
     * previous stage left. Delegates the idempotency and the never-throws
     * contract to {@link destroyScratchHome}, identically to the worktree
     * backend — the whole point of the contract suite running the same cases
     * over both.
     */
    async detach(): Promise<void> {
      reportScratchHomeTeardown(
        spec.onTeardown,
        spec.featureId,
        await destroyScratchHome(scratchHome.path),
      );
    },

    async destroy(): Promise<void> {
      live.delete(spec.featureId);

      report(spec.onTeardown, {
        workspaceId: spec.featureId,
        resource: 'state',
        outcome: destroyed ? 'already-absent' : 'reclaimed',
      });
      files.clear();
      destroyed = true;

      // `force: true` is off here for the reason `destroyScratchHome` documents
      // at length: it swallows ENOENT, which is the only signal that tells
      // `already-absent` apart from `reclaimed`.
      try {
        await rm(root, { recursive: true });
        report(spec.onTeardown, {
          workspaceId: spec.featureId,
          resource: 'root',
          outcome: 'reclaimed',
        });
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code: unknown }).code)
            : undefined;
        report(spec.onTeardown, {
          workspaceId: spec.featureId,
          resource: 'root',
          outcome: code === 'ENOENT' ? 'already-absent' : 'not-reclaimed',
          ...(code === 'ENOENT'
            ? {}
            : { reason: `${code ?? 'unknown'}: ${(error as Error).message}` }),
        });
      }

      reportScratchHomeTeardown(
        spec.onTeardown,
        spec.featureId,
        await destroyScratchHome(scratchHome.path),
      );
    },
  };
}
