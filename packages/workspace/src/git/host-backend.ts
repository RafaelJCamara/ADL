/**
 * The host-rooted `Workspace` backend — ADL's own root, ADL's own home (D-17).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **WHY THIS IS A BACKEND AND NOT A SECOND LINT EXEMPTION**
 *
 * D-12 says ADL's own git operations run through a manager-owned client, outside
 * the worker's `Workspace` entirely — so that the worker's workspace never has a
 * forge-token-bearing exec call to begin with. The obvious way to build that is
 * a small module that shells out on its own.
 *
 * That way is wrong, and the failure is invisible. `adl/no-direct-spawn` exempts
 * `packages/workspace/**`, so a manager-side client living in this package could
 * import `execa` directly and **every lint check would still pass** while
 * success criterion 2 — "no code path anywhere starts a process outside
 * `Workspace.exec()`" — quietly became false. The bypass would live inside the
 * one directory the rule cannot see into. That is threat T-2-40.
 *
 * D-17's resolution is this file: the manager's git client gets a `Workspace` of
 * its own, resolved from the same registry as the worker's, and runs its argv
 * through the same {@link run}. The cost is one registry entry. The return is
 * that there is exactly one exec primitive in the repository, one child
 * environment builder, and one place where the neutralisation of
 * `02-RESEARCH.md § Pitfall 5` is applied — by construction rather than by every
 * future call site remembering.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three things are deliberately different from the feature backends, and each
 * one is a consequence of the root being ADL's own repository rather than a
 * disposable worktree:
 *
 * 1. **The `HOME` is stable, not a `mkdtemp` per run.** D-08's guarantee is that
 *    a `.gitconfig` an agent leaves behind has nothing to reach *before teardown
 *    runs* — so ADL's git points `HOME` and `GIT_CONFIG_GLOBAL` at a directory
 *    that is ADL's, not at a fresh one. A per-run temp home would also work and
 *    would be worse: the manager would then have nowhere to keep a committer
 *    identity, and every operator would discover that as a mystery.
 * 2. **`snapshot()` throws.** See the implementation.
 * 3. **`destroy()` deletes nothing.** See the implementation.
 *
 * What is emphatically the *same*: `exec` goes through {@link run}, which is the
 * only process launch in the repository, with the same `buildChildEnv` — so this
 * backend's children get `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, and the
 * zero-inherit environment for free, and cannot be given a forge token except by
 * a caller naming it in `ExecSpec.env` for one call (D-09, WORK-06). This
 * backend holds no credential of its own and reads none from the daemon's
 * environment.
 */
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  ExecResult,
  ExecSpec,
  LogChunk,
  RestoreHandle,
  Workspace,
  WorkspaceSpec,
} from '@adl/core/stage';
import { WorkspaceError } from '../errors.js';
import { run } from '../exec/run.js';
import { assertWithinRoot, isWithinRoot } from '../paths.js';
import { report } from '../teardown.js';

/** The OS error code behind a failed filesystem call, when there is one. */
function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** What a daemon may configure about this backend beyond the spec. */
export interface HostGitWorkspaceOptions {
  /**
   * ADL's own git home — the directory `HOME` and `GIT_CONFIG_GLOBAL` point at
   * for every child of this workspace (D-08).
   *
   * Defaults to {@link defaultHostGitHome}. It is created if it does not exist,
   * `0700`, and is **never deleted** by {@link Workspace.destroy}: it is the
   * daemon's, not this instance's.
   *
   * Two placements are refused rather than accepted — see
   * {@link hostGitWorkspace}. Both refusals exist because a home an agent can
   * write is not a home at all, and the failure would be silent.
   */
  readonly configHome?: string;
}

/**
 * The default ADL-owned git home: `~/.adl/git-home`.
 *
 * A function rather than a module-level constant so a test can observe the
 * default without the module having read anything at import time. `homedir()`
 * resolves the *daemon's* own home — a non-secret path, never a credential —
 * and this is deliberately not a temp directory: an operator who configures a
 * committer identity for ADL expects it to still be there next week.
 */
export function defaultHostGitHome(): string {
  return join(homedir(), '.adl', 'git-home');
}

/**
 * The resource name this backend uses in its teardown reports.
 *
 * `WorkspaceTeardownReport.resource` is named by the backend because only the
 * backend knows what it owns — and what this one owns is nothing removable,
 * which is the whole point of the entry.
 */
const HOST_RESOURCE = 'host-repo';

/**
 * Stand up a `Workspace` rooted at ADL's own repository.
 *
 * `spec.baseRef` is accepted and unused: this backend does not branch, because
 * it does not create anything. `spec.scratchRoot` is used for one thing only —
 * proving that {@link HostGitWorkspaceOptions.configHome} is not inside it.
 *
 * @throws {WorkspaceError} when the configured home would sit inside the feature
 * scratch root or inside the repository itself. Both are refusals rather than
 * warnings: a git home an agent can write is a home an agent can put
 * `core.hooksPath` in, which is the exact vector this whole plan closes, and a
 * warning would be read once and then scrolled past.
 */
export async function hostGitWorkspace(
  spec: WorkspaceSpec,
  options: HostGitWorkspaceOptions = {},
): Promise<Workspace> {
  const configured = options.configHome ?? defaultHostGitHome();

  if (!isAbsolute(configured)) {
    throw new WorkspaceError(
      `The ADL git home must be an absolute path; received ${JSON.stringify(configured)}. A relative one would resolve against whatever directory the daemon happened to be started in.`,
      spec.featureId,
    );
  }

  const configHome = resolve(configured);

  // Both checks run against the LEXICAL paths, before anything is created. The
  // realpath-based guard in `paths.ts` answers a different question (is this
  // candidate inside a root that already exists); this one has to be answerable
  // for a home that does not exist yet, which is the normal first-run case.
  if (isWithinRoot(resolve(spec.scratchRoot), configHome)) {
    throw new WorkspaceError(
      "The ADL git home resolves inside the feature scratch root, so it is reachable by the agents it exists to be out of reach of (D-08). Configure a path outside it — the default is the daemon user's own ~/.adl/git-home.",
      spec.featureId,
    );
  }

  if (isWithinRoot(resolve(spec.mainRepo), configHome)) {
    throw new WorkspaceError(
      'The ADL git home resolves inside the repository ADL is running against. A git home inside a working tree is both writable through the repository and visible to every `git status` ADL runs. Configure a path outside it.',
      spec.featureId,
    );
  }

  // `recursive: true` makes first run and every run after it the same code path.
  // The mode applies only to directories this call creates; an existing one is
  // left exactly as the operator set it, which is correct — widening someone
  // else's directory is not this function's business.
  await mkdir(configHome, { recursive: true, mode: 0o700 });

  let home: string;
  let root: string;
  try {
    // realpath both for the reason `test/helpers/temp-repo.ts` documents: on
    // macOS `os.tmpdir()` is a symlink into /private, and a root that is one
    // spelling of a directory while `assertWithinRoot`'s realpath produces
    // another would reject every path in it.
    home = await realpath(configHome);
    root = await realpath(resolve(spec.mainRepo));
  } catch (error) {
    throw new WorkspaceError(
      `Cannot stand up the host git workspace: ${codeOf(error) ?? 'unknown error'}. The repository ADL is running against must exist on disk before a manager-side git operation can address it.`,
      spec.featureId,
    );
  }

  return {
    id: spec.featureId,
    root,
    scratchHome: home,

    exec(
      execSpec: ExecSpec,
      log: (chunk: LogChunk) => void,
    ): Promise<ExecResult> {
      // The same runner and the same environment builder as the worktree
      // backend — this line is the whole of D-17. `'adl'` marks the child as
      // ADL's own, which suppresses the privilege drop and, more importantly,
      // stops it from spending WORK-05's once-per-process banner on a workspace
      // the banner does not describe. See `ExecOwner` in `exec/run.ts`.
      return run(execSpec, home, log, {}, 'adl');
    },

    /**
     * Read a file from ADL's own repository, through the same D-02 guard.
     *
     * The guard is not decoration here. The manager will read `adl.yml` and
     * feature specs through this backend, and the path it reads is derived from
     * configuration and from a feature folder's name — both of which arrive from
     * the repository, which is the thing an agent writes to.
     */
    async read(relPath: string): Promise<string> {
      const absolute = await assertWithinRoot(root, relPath);
      try {
        return await readFile(absolute, 'utf8');
      } catch (error) {
        throw new WorkspaceError(
          `Cannot read ${JSON.stringify(relPath)} from the host repository: ${codeOf(error) ?? 'unknown error'}.`,
          spec.featureId,
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
          `Cannot write ${JSON.stringify(relPath)} into the host repository: ${codeOf(error) ?? 'unknown error'}.`,
          spec.featureId,
        );
      }
    },

    /**
     * Refused, loudly.
     *
     * A snapshot is a *restore point for a stage that is about to mutate a
     * feature's worktree*. This workspace's root is ADL's own repository, which
     * no stage mutates and which nothing should ever be rolled back to a
     * previous state by ADL. Returning a handle that silently did nothing would
     * be worse than either alternative: a caller that later called `restore()`
     * would be told the rollback succeeded when nothing had been captured.
     *
     * Returning a rejected promise rather than throwing synchronously so the
     * failure arrives the same way on every backend — a `snapshot()` that threw
     * before its promise existed would escape a caller's `.catch()`.
     */
    snapshot(): Promise<RestoreHandle> {
      return Promise.reject(
        new WorkspaceError(
          'snapshot() is not supported on the host-rooted workspace: its root is ADL’s own repository, which exists to run ADL’s own git commands and is never checkpointed or rolled back. Snapshot the feature’s workspace instead — that is the one a stage mutates.',
          spec.featureId,
        ),
      );
    },

    /**
     * Release the instance. **Deletes nothing.**
     *
     * ⚠ Every other backend's `destroy()` removes a directory. This one must
     * not, and the difference is not subtle: this workspace's root is the
     * repository ADL was installed into, and its `scratchHome` is the daemon's
     * own configuration directory shared by every host-git workspace ever
     * created. Deleting either would destroy the user's work and the operator's
     * configuration respectively. A future contributor "restoring symmetry"
     * here would ship the worst bug in this package.
     *
     * The report says so rather than staying silent: `already-absent` is the
     * accurate outcome — there was never a resource of this instance's own to
     * reclaim — and an operator reading the teardown log sees the host-git entry
     * behave differently from the feature ones, which it does.
     */
    destroy(): Promise<void> {
      report(spec.onTeardown, {
        workspaceId: spec.featureId,
        resource: HOST_RESOURCE,
        outcome: 'already-absent',
      });
      return Promise.resolve();
    },
  };
}
