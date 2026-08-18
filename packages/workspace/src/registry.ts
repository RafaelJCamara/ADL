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
import { listStubWorkspaces, stubWorkspace } from './stub/backend.js';
import { featureIdFromBranch } from './worktree/lifecycle.js';
import { listManagedWorktrees } from './worktree/list.js';
import { worktreeWorkspace } from './worktree/backend.js';

/**
 * The backends that ship with ADL.
 *
 * Frozen const plus derived union, following `FEATURE_STATES` and
 * `TERMINAL_STATES` in `packages/core/src/state/feature-state.ts`: one list, no
 * transcribed second copy in a type, and adding an id extends both at once.
 * v2's `'container'` joins this tuple and gains an entry below — nothing else
 * in the repository changes, which is the whole claim.
 */
export const WORKSPACE_BACKEND_IDS = Object.freeze([
  'worktree',
  'stub',
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
  list: (mainRepo: string) => Promise.resolve(listStubWorkspaces(mainRepo)),
};

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
  const backends = new Map<string, WorkspaceBackend>([
    [worktreeBackend.id, worktreeBackend],
    [stubBackend.id, stubBackend],
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
