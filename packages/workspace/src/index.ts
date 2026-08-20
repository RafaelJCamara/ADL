/**
 * `@adl/workspace` — the exec boundary.
 *
 * Every process ADL starts goes through this package (WORK-02). That is enforced
 * by the `adl/no-direct-spawn` lint rule in `eslint.config.js`, whose single
 * exemption is `packages/workspace/**`, rather than by review: a direct spawn
 * reaching the OS process table bypasses the zero-inherit environment, the
 * scratch `HOME`, the privilege drop, and the git-config neutralisation all at
 * once.
 *
 * `@adl/core` declares the {@link Workspace} interface and nothing else; the
 * implementations live here, because core is pure and I/O-free.
 */

// Errors — the workspace layer's own failure types. `ContainmentError` is a
// sibling of `WorkspaceError`, not a subclass, so a caller can tell "the
// interface refused to address that path" apart from "the file was not there".
export { ContainmentError, WorkspaceError } from './errors.js';

// The D-02 containment guard. Exported because a backend living outside this
// package must be able to enforce the same rule with the same code — a second
// implementation would have to be argued equivalent instead of observed to be.
export { assertWithinRoot, isWithinRoot, resolveWithinRoot } from './paths.js';

// The exec boundary — the only process launch in the repository, and the per-run
// scratch HOME it points every child's `HOME` at (D-07, D-10).
//
// The child-environment builder in `exec/env.ts` is deliberately NOT
// re-exported. It is an implementation detail of `run`, which is its only
// caller; publishing it would invite a second one, and a second place where a
// child environment is assembled is a second door into the boundary this
// package exists to be.
export { run, type ExecOwner } from './exec/run.js';
//
// The manager's supervision seam (WORK-02, eslint.config.js:218): the second
// and last process-launch primitive in the repository, and the reason it is
// public rather than a second `adl/no-direct-spawn` exemption. `@adl/manager`
// obtains a forked worker with a live IPC channel by importing `forkWorker`
// from here — publishing this seam is precisely what keeps the exemption
// count at one, which `test/lint/no-restricted-imports.test.ts` measures
// rather than trusts.
export {
  forkWorker,
  WORKER_ENV_ALLOWLIST,
  type ForkedWorker,
  type ForkWorkerOptions,
} from './exec/fork.js';
//
// The privilege drop (WORK-05, D-05, D-18). Exported because the absence of the
// drop is an operator-facing fact, not an internal detail: a manager building a
// status view needs `privilegeWarning` and `PrivilegeMode` to say what a run
// was and was not contained by, and an out-of-tree backend needs
// `applyWorkerAccess` to grant its own directories the same way rather than
// inventing a second, unreviewed chmod policy.
export {
  ADL_WARNING_PREFIX,
  applyWorkerAccess,
  createPrivilegeWarner,
  parseGroupEntries,
  privilegeLauncher,
  privilegeWarning,
  readGroupEntries,
  reportWorkerAccess,
  resolveGroupId,
  resolveUserIds,
  warnPrivilegeModeOnce,
  workerAccessWarning,
  workerIdentityFromEnv,
  WORKER_GROUP_VAR,
  WORKER_USER_VAR,
  type GroupEntry,
  type PrivilegeConfig,
  type PrivilegeDecision,
  type PrivilegeMode,
  type PrivilegeWarningSink,
  type UserIds,
  type WorkerAccessConfig,
  type WorkerAccessReport,
  type WorkerIdentity,
  privilegeModeMismatch,
  reportPrivilegeModeMismatch,
} from './exec/privilege.js';
//
// `ScratchHomeTeardown` joins its producer on the barrel: `destroyScratchHome`
// was already exported while the type of what it returns was not, so a consumer
// could call it and then had no name for the value in their hands. That is a
// hole rather than a boundary — plan `02-05` flagged it as a carry-forward and
// this is the change it named.
//
// `writeScratchGitConfig` and `SCRATCH_GITCONFIG_FILENAME` are exported for the
// same reason `applyWorkerAccess` already is (D-2-08-1): an out-of-tree
// workspace backend that stands up its own scratch home faces the identical
// `safe.directory` problem — the child it launches runs as a different uid
// than whatever created its worktree, and git refuses to proceed without this
// exact marking — and it must be able to solve it with the same reviewed code
// rather than an unreviewed second implementation.
export {
  createScratchHome,
  destroyScratchHome,
  SCRATCH_GITCONFIG_FILENAME,
  type ScratchHome,
  type ScratchHomeTeardown,
  listScratchHomes,
  scratchHomeRoot,
  writeScratchGitConfig,
  type ScratchHomeEntry,
  type ScratchHomeOwner,
} from './exec/scratch-home.js';

// The git worktree lifecycle — one worktree and one adl/<featureId> branch per
// feature, torn down in the order git requires (WORK-01, D-13).
export {
  branchNameFor,
  createWorktree,
  destroyWorktree,
  featureIdFromBranch,
  type CreatedWorktree,
  type WorktreeTeardown,
} from './worktree/lifecycle.js';

// The disk inventory (D-20). Deliberately the MECHANISM only: it reports which
// worktrees exist, and decides nothing about which should be reclaimed. The
// POLICY — joining this inventory against feature state — is `sweepOrphans`,
// and keeping the two separable is what lets the manager own the trigger and
// the state binding without owning the parsing.
export {
  listManagedWorktrees,
  parseWorktreeList,
  type WorktreeEntry,
} from './worktree/list.js';

// The GC backstop (D-15, D-16, D-20) — the POLICY half. It reaches feature
// state through an injected lookup rather than importing @adl/db, so the
// swappable backend layer carries no database dependency. The manager binds
// the lookup and owns the trigger; both are Phase 3.
export {
  sweepOrphans,
  type FeatureStateLookup,
  type GcDeps,
  type SweepFailure,
  // Phase 3's manager owns the schedule that must call this beside
  // `sweepOrphans`; it cannot reach it until it is on the barrel (WR-06).
  sweepScratchHomes,
  processIsAlive,
  type ScratchHomeGcDeps,
  type ScratchHomeSweepFailure,
} from './worktree/gc.js';

// The named backend registry (D-04) — how a `Workspace` is obtained.
//
// `registry.ts` is the ONLY module in this repository that names either backend
// factory; everything else asks the registry for an id and receives a
// `Workspace`. That is success criterion 3 stated as a property of the source
// tree, and `test/contract/workspace-contract.test.ts` enforces it.
export {
  WORKSPACE_BACKEND_IDS,
  workspaceRegistry,
  type WorkspaceBackendId,
  type WorkspaceRegistry,
  type WorkspaceRegistryConfig,
} from './registry.js';

// Backends — implementations of the Workspace interface @adl/core declares.
//
// Exporting the factories here is intentional and is NOT a contradiction of the
// rule above: the sole-construction-site assertion measures *imports*, and the
// registry needs a way to reach them. What it forbids is another module
// importing one, which is a different statement from this package publishing
// them for a test or an embedder to construct directly.
export {
  worktreeWorkspace,
  type WorktreeWorkspaceOptions,
} from './worktree/backend.js';
export { listStubWorkspaces, stubWorkspace } from './stub/backend.js';
//
// ADL's own workspace (D-17). Registered as `'host-git'`, and the reason it is a
// backend rather than a second `adl/no-direct-spawn` exemption is written out at
// the top of `git/host-backend.ts`.
export {
  hostGitWorkspace,
  type HostGitWorkspaceOptions,
} from './git/host-backend.js';
//
// `defaultHostGitHome` is exported because an operator-facing status view has to
// be able to say where ADL's git home is without constructing a workspace to
// ask. It lives beside `adlGit` — the chokepoint every ADL-side git invocation
// in `src/` goes through (02-REVIEW.md CR-01, CR-02) — rather than beside the
// host-git backend, because the worktree modules need the same home and may not
// import a backend module by rule.
//
// What is deliberately NOT exported is `adlGit` itself, for the reason
// `managerGitClient`'s private argv builder is not exported: publishing it would
// publish a git invocation an out-of-tree caller could point anywhere, and the
// package's promise is that there is one.
export { defaultHostGitHome } from './git/adl-git.js';

// The manager-owned git client (D-12) and the neutralisation every one of its
// invocations carries (D-19, WORK-07).
//
// `NEUTRALISED_CONFIG` and `NEUTRALISE_ARGS` are exported for two audiences and
// neither of them is "a caller who wants to build their own git argv": the
// poisoned-config suite iterates the list so that trimming it makes the proof
// smaller rather than making it fail, and an operator-facing view has to be able
// to state what ADL overrides. T-2-42 — "the neutralisation disables something
// an operator legitimately relies on" — is *accepted* rather than mitigated, and
// an accepted risk is only acceptable while it is discoverable, which is why
// README.md § What ADL's own git overrides lists every entry and why
// `test/git/manager-git.test.ts` fails when the two drift apart.
//
// What is deliberately NOT exported is the argv builder inside
// `managerGitClient`. It is the reason there is no reachable path to a git
// invocation without the overrides, and publishing it would be publishing the
// bypass.
//
// `NEUTRALISATION_RESIDUAL_RISK` travels with them for the same reason and is
// the half that was missing: a status view that lists what ADL overrides and
// stays silent about what it does not lets a reader infer a completeness the
// list does not have (02-REVIEW.md WR-12).
export {
  managerGitClient,
  NEUTRALISATION_RESIDUAL_RISK,
  NEUTRALISE_ARGS,
  NEUTRALISED_CONFIG,
  type GitStatusEntry,
  type ManagerGitClient,
  type ManagerGitClientOptions,
} from './git/manager-git.js';

// The teardown-report sink's mapping helpers. `WorkspaceSpec.onTeardown` is
// declared in `@adl/core/stage`; these turn this package's own teardown results
// into it, and an out-of-tree backend can reuse them.
export {
  report,
  reportScratchHomeTeardown,
  type TeardownSink,
} from './teardown.js';
