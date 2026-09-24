/**
 * The workspace a gate declaring `visible_paths` receives — a materialised copy
 * of what it asked for, and demonstrably nothing else (ROLE-06, M08 step 8.1).
 *
 * ## Why a copy, and not the obvious three alternatives
 *
 * M08 step 8.0's spike measured the alternatives against real git 2.49 rather
 * than reasoning about them, and each failed in a way that is invisible from
 * the working tree:
 *
 * 1. **A second worktree with a sparse checkout.** The strongest candidate and
 *    the most dangerous. It genuinely removes the source from disk — a full
 *    file walk of the tree finds nothing, `git status` reports *clean* rather
 *    than a mass deletion, and a behaviour test runs from it against the app
 *    and passes. Then `git cat-file -p HEAD:src/server.mjs` prints the source
 *    straight back, because a linked worktree's `.git` points at the **main
 *    repository's object store**, which holds every blob that was excluded from
 *    the checkout. `git show <rev>:<path>` is a second spelling of the same
 *    door, and `git sparse-checkout disable` restores the entire tree in one
 *    command. Sparse-checkout is a *checkout preference, not a permission*.
 * 2. **A filtered `Workspace` decorator.** A gate's agent reads files through
 *    the operating system, not through {@link Workspace.read} — 7.5's reviewer
 *    walked its own root with its own process. There is nothing to intercept.
 * 3. **Telling the tester not to look.** Acceptance criterion 1 rules it out in
 *    so many words: *absent, not merely forbidden by instruction.*
 *
 * ## Location is part of the mechanism, not a deployment detail
 *
 * The spike's second finding is the one that reasoning alone would have missed.
 * **Git resolves a repository by walking UP the directory tree**, so a
 * perfectly `.git`-less copy is only blind if nothing above it is a repository
 * — and ADL's own `scratchRoot` defaults to `join(dirname(dbFilePath),
 * 'scratch')`, which is `<repo>/.adl/scratch`, *inside the watched repository*.
 * A copy placed there leaks the whole source through `git cat-file`, and
 * `.adl/` being gitignored makes no difference, because **ignore rules are not
 * access control**.
 *
 * So {@link visibleWorkspaceRoot} deliberately does not derive from
 * `scratchRoot`, and {@link composeVisibleWorkspace} does not *assume* the
 * property it depends on: it asks git, before the copy and again after it, and
 * refuses with a {@link VisibilityError} rather than handing back a workspace
 * that is blind in appearance only. `GIT_CEILING_DIRECTORIES` was measured too
 * and does block the walk-up, but it is an environment variable a child can
 * unset — defence in depth, never the guarantee.
 *
 * ## What this is not
 *
 * Not a {@link WorkspaceBackend}. A backend answers `WorkspaceSpec`, which
 * names a repository and a ref and has no room for an allowlist; widening it
 * would put M08's vocabulary into a published port that every other backend
 * implements. This is a workspace *derived from another workspace*, which is a
 * different relation, so it is a function and not a registry entry. A gate
 * still receives a plain {@link Workspace} and cannot tell which kind it holds
 * — which is HARN-04 holding, not an accident.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type {
  ExecResult,
  ExecSpec,
  LogChunk,
  RestoreHandle,
  Workspace,
} from '@adl/core/stage';
import { selectVisiblePaths } from '@adl/core/stage';
import { VisibilityError, WorkspaceError } from '../errors.js';
import { adlGit } from '../git/adl-git.js';
import { run } from '../exec/run.js';
import {
  applyWorkerAccess,
  privilegeLauncher,
  reportWorkerAccess,
  workerIdentityFromEnv,
  type WorkerIdentity,
} from '../exec/privilege.js';
import { createScratchHome, destroyScratchHome } from '../exec/scratch-home.js';
import { assertCwdWithinRoot, assertWithinRoot } from '../paths.js';

/**
 * Where composed workspaces live — a sibling of `scratchHomeRoot()`, and
 * deliberately **not** derived from the daemon's `scratchRoot`.
 *
 * See the module docblock: `scratchRoot` defaults to a directory inside the
 * watched repository, and a copy placed there is not blind no matter how
 * carefully it was composed. This is a default, not a guarantee — the guarantee
 * is the assertion {@link composeVisibleWorkspace} runs against it.
 */
export function visibleWorkspaceRoot(): string {
  return join(tmpdir(), 'adl-visible');
}

/** What to compose, and from where. */
export interface VisibleWorkspaceSpec {
  /**
   * This workspace's id. Distinct from the developer's, because both are live
   * at once and the daemon's logs have to tell them apart.
   */
  readonly id: string;
  /** Absolute path of the workspace being copied *from* — the developer's worktree. */
  readonly source: string;
  /** Absolute destination root. Must not exist, and must not be inside a repository. */
  readonly root: string;
  /** The declared allowlist, straight off `ResolvedStage.visiblePaths`. */
  readonly visiblePaths: readonly string[];
  /** Whose identity the children run as; defaults to the environment's. */
  readonly worker?: WorkerIdentity;
}

/** Every repo-relative file path under `dir`, skipping `.git` entirely. */
async function listFiles(
  dir: string,
  base: string = dir,
): Promise<readonly string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Never descended into, and never copied. A `.git` in the SOURCE is the
    // developer's worktree pointer; copying it would hand the tester the exact
    // door the module docblock exists to close.
    if (entry.name === '.git') continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listFiles(absolute, base)));
    } else {
      found.push(relative(base, absolute).split('\\').join('/'));
    }
  }
  return found;
}

/**
 * Ask git what repository `dir` belongs to.
 *
 * `raw` rather than `rawOk` because a **non-zero exit is the answer we want**,
 * not a failure: `fatal: not a git repository` is this function returning
 * `undefined`, and treating it as an exception would make the success path the
 * one that throws.
 */
async function repositoryAbove(dir: string): Promise<string | undefined> {
  const outcome = await adlGit(dir).raw(['rev-parse', '--show-toplevel']);
  if (outcome.exitCode === 0 && outcome.stdout.trim() !== '') {
    return outcome.stdout.trim();
  }
  return undefined;
}

/**
 * Refuse unless nothing at or above `dir` is a git repository.
 *
 * Runs **twice** per composition — once against the parent before anything is
 * copied, so a misconfigured root costs no I/O, and once against the finished
 * root, because the first check cannot see a `.git` that the copy itself
 * introduced. Two checks rather than one is the difference between "the
 * location was right when we looked" and "the workspace we are handing over is
 * blind".
 */
async function assertNoRepositoryAbove(
  dir: string,
  id: string,
  when: string,
): Promise<void> {
  const repository = await repositoryAbove(dir);
  if (repository !== undefined) {
    throw new VisibilityError(
      id,
      `${when}: git resolves a repository at or above this workspace, so ` +
        '`git cat-file`, `git show` and `git log` read the implementation ' +
        'straight back out of its object store and the workspace is ' +
        'code-blind in appearance only (ROLE-06). Git finds a repository ' +
        'because it walks UP from the working directory; a `.gitignore` entry ' +
        'does not stop it, because ignore rules are not access control. ' +
        'Configure a composed-workspace root outside every repository.',
    );
  }
}

/**
 * Build the workspace, and prove it is blind before handing it over.
 *
 * Throws {@link VisibilityError} when the result would not satisfy ROLE-06 and
 * {@link WorkspaceError} when it simply could not be built — siblings, not
 * subclasses, for `ContainmentError`'s reason: "the copy failed" and "the copy
 * succeeded and is not blind" are different events, and a caller that cannot
 * tell them apart will report the second as the first.
 */
export async function composeVisibleWorkspace(
  spec: VisibleWorkspaceSpec,
): Promise<Workspace> {
  return (await composeVisibleWorkspaceWithReport(spec)).workspace;
}

/**
 * {@link composeVisibleWorkspace}, plus the evidence of what it excluded.
 *
 * This is the real implementation and the other is the thin wrapper, rather
 * than the other way round: the listing is walked **once**, so the report and
 * the workspace can never describe different compositions. Two walks of a live
 * tree are two answers, and the one the caller shows a human would be the one
 * that was not acted on.
 */
export async function composeVisibleWorkspaceWithReport(
  spec: VisibleWorkspaceSpec,
): Promise<VisibleComposition> {
  const { id, source, root, visiblePaths } = spec;
  const worker = spec.worker ?? workerIdentityFromEnv();

  // Before anything is copied: a root whose parent is inside a repository can
  // never be made blind, so finding out after the copy would be a wasted walk
  // of the developer's whole tree.
  await mkdir(dirname(root), { recursive: true });
  await assertNoRepositoryAbove(dirname(root), id, 'before composing');

  // `createWorktree`'s rule, for its reason: reclaiming something that is
  // already there is the GC sweep's decision, made from feature state, never a
  // decision made here from what happens to be on disk (WORK-04).
  try {
    await readdir(root);
    throw new WorkspaceError(
      `Refusing to compose a workspace at an existing path for ${JSON.stringify(id)}. ` +
        "Reclaiming it is the GC sweep's decision, and the sweep asks feature state.",
      id,
    );
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    // ENOENT is the expected, correct case: the path is free.
  }

  const candidates = await listFiles(source);
  const { visible, hidden } = selectVisiblePaths(candidates, visiblePaths);

  await mkdir(root, { recursive: true });
  for (const relPath of visible) {
    const destination = join(root, relPath);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(source, relPath), destination);
  }

  // After the copy, against the root itself. The check above was about the
  // location; this one is about the artefact, and an allowlist that matched a
  // path under `.git` would pass the first and fail this. (Spelling that glob
  // out here would be a comment that opens a block comment, which is a real
  // trap: the contract suite's comment stripper runs the block rule first, so
  // a line comment containing one silently swallows the code beneath it.)
  await assertNoRepositoryAbove(root, id, 'after composing');

  const scratchHome = await createScratchHome();
  const privilege = await privilegeLauncher({
    worker,
    path: process.env['PATH'] ?? '',
  });
  reportWorkerAccess(
    await applyWorkerAccess([scratchHome.path, root], {
      mode: privilege.mode,
      group: worker.group,
      // Nothing to protect: there is no `.git/config` here, which is the whole
      // point. The empty list is written out rather than omitted so that a
      // future reader looking for the worktree backend's `protect:` entry finds
      // the reason it is absent instead of assuming an oversight.
      protect: [],
    }),
  );

  let destroyed = false;

  const workspace: Workspace = {
    id,
    root,
    scratchHome: scratchHome.path,

    async exec(
      execSpec: ExecSpec,
      log: (chunk: LogChunk) => void,
    ): Promise<ExecResult> {
      await assertCwdWithinRoot(root, execSpec.cwd);
      return run(execSpec, scratchHome.path, log, worker);
    },

    async read(relPath: string): Promise<string> {
      const absolute = await assertWithinRoot(root, relPath);
      try {
        return await readFile(absolute, 'utf8');
      } catch (error) {
        throw new WorkspaceError(
          `Cannot read ${JSON.stringify(relPath)} from the composed workspace: ${
            error instanceof Error ? error.message : 'unknown error'
          }.`,
          id,
        );
      }
    },

    async write(relPath: string, contents: string): Promise<void> {
      const absolute = await assertWithinRoot(root, relPath);
      try {
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, contents, 'utf8');
      } catch (error) {
        throw new WorkspaceError(
          `Cannot write ${JSON.stringify(relPath)} into the composed workspace: ${
            error instanceof Error ? error.message : 'unknown error'
          }.`,
          id,
        );
      }
    },

    /**
     * A copy of the copy — and it has to be, because the worktree backend's
     * implementation is `git stash create`, and the absence of git is this
     * workspace's defining property. Cheap for the reason the whole design is
     * viable: an allowlist is small.
     */
    async snapshot(): Promise<RestoreHandle> {
      const capture = `${root}.snapshot`;
      await rm(capture, { recursive: true, force: true });
      await cp(root, capture, { recursive: true });
      let released = false;

      return {
        id: `visible:${id}`,
        async restore(): Promise<void> {
          if (released) {
            throw new WorkspaceError(
              `Cannot restore the composed workspace for ${JSON.stringify(id)}: its snapshot was released.`,
              id,
            );
          }
          await rm(root, { recursive: true, force: true });
          await cp(capture, root, { recursive: true });
        },
        async release(): Promise<void> {
          released = true;
          await rm(capture, { recursive: true, force: true });
        },
      };
    },

    /**
     * Nothing to detach from. The worktree backend detaches so a later stage
     * can attach to the work the previous one left; a composed workspace is
     * built fresh for one gate and has no successor, so this is a no-op rather
     * than an unimplemented method — the port requires it, and refusing would
     * make a legitimate teardown path throw.
     */
    detach(): Promise<void> {
      return Promise.resolve();
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await rm(root, { recursive: true, force: true });
      await rm(`${root}.snapshot`, { recursive: true, force: true });
      await destroyScratchHome(scratchHome.path);
    },
  };

  return { workspace, visible, hidden };
}

/**
 * What a composition withheld, for the caller that asked for it.
 *
 * Returned **beside** the workspace rather than on it, because a gate holding a
 * `Workspace` must not be able to ask what it was not given: a member listing
 * the hidden paths would tell the tester the implementation's file names, which
 * is not the source but is the map to it.
 */
export interface VisibleComposition {
  readonly workspace: Workspace;
  readonly visible: readonly string[];
  readonly hidden: readonly string[];
}
