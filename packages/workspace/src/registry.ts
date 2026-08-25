/**
 * The named workspace-backend registry (D-04).
 *
 * A backend id comes out of daemon configuration and is resolved once at
 * manager startup, mirroring Phase 1's D-23 harness registry so contributors
 * carry one mental model of pluggability rather than two.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **THIS MODULE IS THE ONLY PLACE EITHER BACKEND FACTORY MAY BE NAMED.**
 *
 * That is Phase 2's success criterion 3 — "a second workspace backend is
 * registered and the loop runs against it unchanged, with zero call-site edits"
 * — expressed as a rule about the source tree, and
 * `test/contract/workspace-contract.test.ts` asserts it by reading every file
 * under `src/` and failing with the offending filename.
 *
 * The consequence is worth stating plainly, because the violation does not look
 * like one: a direct `import { worktreeWorkspace }` somewhere else compiles,
 * passes every test, and makes "zero call-site edits" false while the interface
 * still *looks* generic. So does a conditional on which id is in play. Both are
 * the shape that Phase 11's ban on backend-name comparisons exists to prevent,
 * and both are caught here rather than at review time.
 *
 * Everything outside this file receives a `Workspace` instance. It never
 * receives a factory, never learns which backend produced it, and has nothing
 * to branch on.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type {
  ManagedWorkspace,
  WorkspaceBackend,
  WorkspaceSpec,
} from '@adl/core/stage';
import { WorkspaceError } from './errors.js';
import {
  hostGitWorkspace,
  type HostGitWorkspaceOptions,
} from './git/host-backend.js';
import {
  attachStubWorkspace,
  listStubWorkspaces,
  stubWorkspace,
} from './stub/backend.js';
import { featureIdFromBranch } from './worktree/lifecycle.js';
import { listManagedWorktrees } from './worktree/list.js';
import {
  attachWorktreeWorkspace,
  worktreeWorkspace,
} from './worktree/backend.js';

/**
 * The backends that ship with ADL.
 *
 * Frozen const plus derived union, following `FEATURE_STATES` and
 * `TERMINAL_STATES` in `packages/core/src/state/feature-state.ts`: one list, no
 * transcribed second copy in a type, and adding an id extends both at once.
 * v2's `'container'` joins this tuple and gains an entry below — nothing else
 * in the repository changes, which is the whole claim.
 *
 * **Two of these three are feature backends; `'host-git'` is not.** `'worktree'`
 * and `'stub'` are peers that a feature runs inside, and the parameterised
 * contract suite runs over exactly those two. `'host-git'` is ADL's own
 * workspace — its root is the repository rather than a worktree, its `destroy()`
 * deletes nothing, and its `snapshot()` refuses — so it is deliberately outside
 * that suite. Forcing it through would mean either weakening the suite for the
 * two backends it exists to hold to a standard, or asserting things about this
 * one that are not true. `test/git/manager-git.test.ts` asserts the divergence
 * explicitly, so it is a stated boundary rather than an omission.
 */
export const WORKSPACE_BACKEND_IDS = Object.freeze([
  'worktree',
  'stub',
  'host-git',
] as const);

export type WorkspaceBackendId = (typeof WORKSPACE_BACKEND_IDS)[number];

/** What a daemon may configure about backend resolution. */
export interface WorkspaceRegistryConfig {
  /**
   * Backends beyond the built-ins, e.g. one loaded from an npm package.
   *
   * This is the seam D-04's "built-in id, then npm package, then repo-relative
   * path" resolution order will grow into. An out-of-tree backend implements
   * `WorkspaceBackend` from `@adl/core/stage` and arrives here; it never needs
   * this package at all. An entry whose id collides with a built-in replaces
   * it, so an operator can substitute a backend without a fork.
   */
  readonly backends?: readonly WorkspaceBackend[];
  /**
   * Options for the built-in `'host-git'` backend — in practice, where ADL's
   * own git home lives (D-08).
   *
   * Note what is **not** here and will not be added: a forge token. Credentials
   * reach a git subprocess through `ExecSpec.env`, on the one `exec()` that
   * needs them and nowhere else (D-09, WORK-06), so there is no configuration
   * field anywhere on this type — or on the worktree backend's — through which
   * one could be supplied. That absence is what makes D-12's claim true rather
   * than asserted, and `test/git/manager-git.test.ts` asserts it structurally.
   */
  readonly hostGit?: HostGitWorkspaceOptions;
}

export interface WorkspaceRegistry {
  /**
   * The backend registered under `id`.
   *
   * Takes a `string` rather than {@link WorkspaceBackendId} on purpose: the
   * argument arrives from a YAML file a human typed, so an unknown id is a
   * runtime event to report, not a compile error that never happens.
   */
  resolve(id: string): WorkspaceBackend;
  /** Every registered id, built-in and configured, in registration order. */
  ids(): readonly string[];
}

/** The worktree backend as the port sees it — the id, and nothing about git. */
const worktreeBackend: WorkspaceBackend = {
  id: 'worktree',
  create: (spec: WorkspaceSpec) => worktreeWorkspace(spec),
  attach: (spec: WorkspaceSpec) => attachWorktreeWorkspace(spec),
  async list(mainRepo: string): Promise<readonly ManagedWorkspace[]> {
    const entries = await listManagedWorktrees(mainRepo);
    return entries.flatMap((entry) => {
      const featureId = featureIdFromBranch(entry.branch);
      // `listManagedWorktrees` has already dropped everything without an ADL
      // branch; flatMap rather than map is what makes that a narrowing the
      // compiler can see instead of a `!` the reader has to trust.
      return featureId === undefined
        ? []
        : [{ featureId, locator: entry.path }];
    });
  },
};

/** The in-memory backend. Peer of the worktree one, not a lesser variant. */
const stubBackend: WorkspaceBackend = {
  id: 'stub',
  create: (spec: WorkspaceSpec) => stubWorkspace(spec),
  attach: (spec: WorkspaceSpec) => attachStubWorkspace(spec),
  list: (mainRepo: string) => Promise.resolve(listStubWorkspaces(mainRepo)),
};

/**
 * ADL's own workspace (D-17) — a third entry rather than a second lint
 * exemption.
 *
 * The manager-owned git client of D-12 needs to start a `git` process. The
 * cheap way is a module that shells out on its own; because
 * `adl/no-direct-spawn` exempts `packages/workspace/**`, that module would pass
 * every lint check in the repository while making success criterion 2 — "no code
 * path anywhere starts a process outside `Workspace.exec()`" — false, with the
 * bypass sitting inside the one directory the rule cannot see into (T-2-40).
 *
 * So the client is handed a `Workspace` like everything else, and this entry is
 * what it resolves. It costs one line in the id tuple and one factory below;
 * what it buys is that `exec/run.ts` remains the only process launch and
 * `exec/env.ts` the only child environment, for ADL's git as much as for an
 * agent's.
 *
 * `list` returns nothing, and that is a decision rather than a gap. The
 * inventory exists so the GC sweep can find workspaces to reclaim (D-20), and
 * the one resource this backend addresses is the repository ADL was installed
 * into. An entry here would invite a sweep to act on it.
 *
 * `attach` is the same function as `create` (M05 step 5.14), and for the
 * mirror-image reason `detach` and `destroy` collapse on this backend: the
 * thing `attach` exists to find is *always already there*, because it is the
 * repository ADL was installed into. There is no "nothing here" case to report,
 * so this is the one backend whose `attach` never returns `undefined`.
 */
function hostGitBackend(options: HostGitWorkspaceOptions): WorkspaceBackend {
  return {
    id: 'host-git',
    create: (spec: WorkspaceSpec) => hostGitWorkspace(spec, options),
    attach: (spec: WorkspaceSpec) => hostGitWorkspace(spec, options),
    list: () => Promise.resolve([]),
  };
}

/**
 * Build a registry over the built-in backends plus whatever the daemon
 * configured.
 *
 * A factory returning an object literal, following
 * `packages/db/src/repository/features.ts` — this repository has no service
 * classes, and what leaves a module is a handful of named functions rather than
 * a live handle. That shape is what makes the sole-construction-site assertion
 * possible at all: there is no registry *object* anyone can reach into for a
 * factory.
 */
export function workspaceRegistry(
  config: WorkspaceRegistryConfig = {},
): WorkspaceRegistry {
  const hostBackend = hostGitBackend(config.hostGit ?? {});

  const backends = new Map<string, WorkspaceBackend>([
    [worktreeBackend.id, worktreeBackend],
    [stubBackend.id, stubBackend],
    [hostBackend.id, hostBackend],
  ]);

  for (const backend of config.backends ?? []) {
    backends.set(backend.id, backend);
  }

  return {
    resolve(id: string): WorkspaceBackend {
      const backend = backends.get(id);
      if (backend === undefined) {
        // Throws rather than returning undefined, and there is deliberately no
        // default. An undefined backend surfaces as a null dereference three
        // frames away from the configuration mistake that caused it, and a
        // default would run the feature under isolation guarantees nobody
        // chose — the id decides how contained an agent is (T-2-26).
        throw new WorkspaceError(
          `Unknown workspace backend ${JSON.stringify(id)}. Registered: ${[...backends.keys()].join(', ')}.`,
        );
      }
      return backend;
    },

    ids(): readonly string[] {
      return [...backends.keys()];
    },
  };
}
