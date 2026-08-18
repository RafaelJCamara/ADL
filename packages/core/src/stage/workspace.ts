/**
 * The workspace a stage runs inside (`.planning/research/ARCHITECTURE.md` §5).
 *
 * This is the one place ADL's own process ends and an agent's begins. Everything
 * a gate is allowed to do to the filesystem or the process table, it does through
 * the {@link Workspace} it is handed — which is what makes the v2 container
 * backend a registry entry rather than a repository-wide call-site sweep (D-03).
 *
 * `@adl/core` stays pure: nothing here imports a builtin, spawns anything, or
 * reads an environment. These are declarations that erase at runtime, plus one
 * frozen data tuple. `@adl/workspace` supplies the implementations.
 *
 * Three things here differ from the ARCHITECTURE.md sketch, and each is a
 * decision this phase made after it was written:
 *
 * 1. `ExecSpec` carries `networkPolicy` and `resources` from the first commit
 *    (ROADMAP.md § Phase 2 Notes). v1 always passes `'full'` and `{}`. The
 *    roadmap calls this "the one mistake that is expensive to retrofit": a
 *    *value* of `'full'` written at forty call sites is forty edits when the
 *    container backend lands, whereas a union declared now costs nothing.
 * 2. `ExecSpec.path` is REQUIRED, not optional. The workspace runs children with
 *    `extendEnv: false`, and execa then resolves the binary from `env.PATH`
 *    rather than the parent's (execa#366). A missing `PATH` is therefore a
 *    Linux-only `ENOENT` at round 1 of a real feature — unless the type makes it
 *    a compile error here, which it does.
 * 3. There is no scratch-`HOME` field on `ExecSpec`. The scratch HOME belongs to
 *    the {@link Workspace} instance, not to one exec call (D-07), so it is a
 *    readonly member below and no caller can opt a child out of it or redirect
 *    it.
 *
 * The one-way part: `@adl/plugin-sdk` republishes this surface, so once it is
 * out, changing a signature here breaks every third-party harness (D-01).
 */
import type { LogChunk } from './stage.js';

/**
 * What a child may reach on the network.
 *
 * v1 always passes `'full'` — the worktree backend runs children on the host and
 * has no mechanism to restrict them, and pretending otherwise would be a lie in
 * the type. The union exists anyway so the v2 container backend is a *value*
 * change at the call sites and a real implementation in one backend, rather than
 * a signature change everywhere (ROADMAP.md § Phase 2 Notes).
 */
export const NETWORK_POLICIES = Object.freeze([
  'full',
  'none',
  'allowlist',
] as const);

export type NetworkPolicy = (typeof NETWORK_POLICIES)[number];

/**
 * CPU, memory, and process-count ceilings for a child.
 *
 * Every field is optional and v1 passes `{}`: the host worktree backend cannot
 * enforce any of them. Like {@link NetworkPolicy}, the shape is here so the
 * container backend is a drop-in.
 */
export interface ResourceLimits {
  /** Fractional CPUs, in the `docker --cpus` sense. */
  readonly cpus?: number;
  /** Hard memory ceiling in bytes. */
  readonly memoryBytes?: number;
  /** Maximum number of processes in the child's subtree. */
  readonly pids?: number;
}

/** One process to run inside a workspace. */
export interface ExecSpec {
  /**
   * The command and its arguments — never a shell string.
   *
   * `packages/core/src/config/adl-yml.ts` already committed to this shape for
   * `CommandSpecSchema` and said why: no shell means no quoting bugs and no
   * injection surface from repository config (threat T-1-01, T-2-10). There is
   * deliberately no field anywhere on this type that accepts a command string.
   */
  readonly argv: readonly string[];
  /** Working directory for the child. The backend resolves it inside the workspace root. */
  readonly cwd: string;
  /**
   * The child's `PATH`. Required — see note 2 in the module docblock.
   *
   * It is a distinct field rather than just another {@link ExecSpec.env} entry
   * so that "the caller forgot PATH" is a type error rather than an empty
   * record that typechecks fine.
   */
  readonly path: string;
  /**
   * Additional environment variables, and the ONLY way anything else reaches the
   * child (D-09, D-10).
   *
   * Nothing is inherited from the worker process. Credentials arrive here, on
   * the one `exec()` that needs them, and nowhere else (WORK-06).
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Kill the child after this many milliseconds. Omitted means no timeout. */
  readonly timeoutMs?: number;
  /**
   * Cancellation. `StageContext.signal` plugs straight in — it is the same
   * `AbortSignal` that fires on budget interrupt, pause, or shutdown.
   */
  readonly signal?: AbortSignal;
  /** v1 always `'full'`. See {@link NetworkPolicy}. */
  readonly networkPolicy: NetworkPolicy;
  /** v1 always `{}`. See {@link ResourceLimits}. */
  readonly resources: ResourceLimits;
}

/** How a child ended. */
export interface ExecResult {
  /** `null` when the child was killed by a signal rather than exiting. */
  readonly exitCode: number | null;
  /** The signal that killed the child, when one did. */
  readonly signal?: string;
  /** Wall-clock duration of the run, for cost and timeout accounting. */
  readonly durationMs: number;
}

/**
 * A point-in-time capture of a workspace, taken before a mutating stage runs.
 *
 * `release()` is not symmetry for its own sake: a snapshot that can only ever be
 * restored and never discarded leaks whatever backs it — a git ref, a container
 * layer, a copy on disk — for every round of every feature that ever passed.
 */
export interface RestoreHandle {
  /** Stable identifier, recorded in the audit trail. */
  readonly id: string;
  /** Return the workspace to the captured state. */
  restore(): Promise<void>;
  /** Discard the capture without restoring it. */
  release(): Promise<void>;
}

/**
 * What one `destroy()` managed to reclaim, reported rather than discarded.
 *
 * This is the answer to a defect plan `02-05` recorded and could not fix:
 * `destroyScratchHome` learned to report `removed | already-absent |
 * not-removed`, `destroy()` awaited it and dropped the result, and a leaked
 * scratch `HOME` on a long-running daemon was therefore invisible to the
 * operator it costs disk to.
 *
 * **`destroy()` still returns `Promise<void>`, deliberately.** Two reasons, and
 * the second is the load-bearing one. First, it is a port method that
 * `@adl/plugin-sdk` republishes, so its signature is one-way (D-01). Second,
 * and worse, the thing worth reporting is *`ScratchHomeTeardown`* — a
 * worktree-backend mechanism. Putting it in the shared return type would oblige
 * a container backend, which has no scratch directory in that sense, to model
 * one. So the report is pushed to an optional sink instead, and the shape here
 * is deliberately generic: a `resource` a backend names for itself, and the
 * three outcomes any reclamation has.
 *
 * The sink is optional because reporting must never be the reason teardown
 * fails, and it takes no return value because a caller cannot usefully answer.
 * It follows `GcDeps.onFailure`, which `packages/workspace/src/worktree/gc.ts`
 * introduced for the identical problem: a thing that must not throw and must
 * not vanish.
 */
export interface WorkspaceTeardownReport {
  /** The {@link Workspace.id} whose teardown this describes. */
  readonly workspaceId: string;
  /**
   * Which of the workspace's own resources this reports on — `'worktree'`,
   * `'scratch-home'`, `'container'`. Named by the backend, because only the
   * backend knows what it owns.
   */
  readonly resource: string;
  /** `already-absent` is what an idempotent second teardown looks like. */
  readonly outcome: 'reclaimed' | 'already-absent' | 'not-reclaimed';
  /**
   * Why, when the outcome is `not-reclaimed`. An OS error code and message.
   *
   * Never a value out of a child's environment — this string reaches a daemon
   * log, and WORK-06's whole point is that credentials do not travel.
   */
  readonly reason?: string;
}

/**
 * What a backend needs in order to stand one workspace up.
 *
 * Lives in `@adl/core` rather than in `@adl/workspace` for the same reason
 * `Stage` does: an out-of-tree backend must be able to implement the port
 * without taking a dependency on ADL's built-in implementations of it. A
 * container backend written by someone else imports this file and nothing from
 * `@adl/workspace` at all.
 */
export interface WorkspaceSpec {
  /** The feature this workspace belongs to; also the workspace id. */
  readonly featureId: string;
  /** The repository ADL is running against. */
  readonly mainRepo: string;
  /** Directory the backend may create its per-feature workspace under. Must already exist. */
  readonly scratchRoot: string;
  /** The commit-ish the feature's work branches from. */
  readonly baseRef: string;
  /**
   * Optional sink for {@link WorkspaceTeardownReport}s emitted by
   * {@link Workspace.destroy}. See that type for why the report is not a return
   * value.
   */
  readonly onTeardown?: (report: WorkspaceTeardownReport) => void;
}

/**
 * One entry in a backend's inventory of the workspaces it is currently holding.
 *
 * Deliberately two fields. The `featureId` is the only thing a caller can act
 * on — reclamation decisions are made from feature *state* (D-16, WORK-04),
 * never from what is on disk — and the `locator` exists so an operator reading
 * a log can find the thing. Anything richer would invite a caller to make the
 * decision from the inventory.
 */
export interface ManagedWorkspace {
  readonly featureId: string;
  /** Wherever the backend keeps it: a worktree path, a container id, a URL. */
  readonly locator: string;
}

/**
 * One workspace *implementation*, addressed by id (D-04).
 *
 * The registry that maps ids to these is the only place a concrete backend is
 * ever named; everything else in the loop receives a {@link Workspace}. That is
 * what makes "a second backend runs the loop unchanged" a property of the code
 * rather than a claim — see `packages/workspace/src/registry.ts`.
 *
 * `list` is here rather than on {@link Workspace} because it answers a question
 * about the *set* of workspaces, which no single instance can. It is the
 * mechanism half of D-20: it reports what exists and decides nothing.
 */
export interface WorkspaceBackend {
  /** The registry id this backend answers to — `'worktree'`, `'stub'`, later `'container'`. */
  readonly id: string;
  create(spec: WorkspaceSpec): Promise<Workspace>;
  list(mainRepo: string): Promise<readonly ManagedWorkspace[]>;
}

/**
 * Exec, read, write, snapshot — the whole of what a stage may do to the world.
 *
 * A stage receives one of these through `StageContext.workspace` and has no
 * other route to the filesystem or the process table (WORK-02, enforced by the
 * `adl/no-direct-spawn` lint rule rather than by review).
 */
export interface Workspace {
  /** Stable id for this workspace instance, used in logs and error context. */
  readonly id: string;
  /** Absolute path to the workspace root. Everything the stage may touch is under it. */
  readonly root: string;
  /**
   * Absolute path to this run's private `HOME` (D-07).
   *
   * It belongs to the instance, not to an {@link ExecSpec}: every child of this
   * workspace gets the same one, no caller may opt out of it, and it is deleted
   * by {@link Workspace.destroy}. It is reached by children through their
   * environment at exec time — never through {@link Workspace.read} or
   * {@link Workspace.write}, which are scoped to {@link Workspace.root}.
   */
  readonly scratchHome: string;
  /** Run one process inside this workspace, streaming its output as it arrives. */
  exec(spec: ExecSpec, log: (chunk: LogChunk) => void): Promise<ExecResult>;
  /**
   * Read a file, by a path relative to {@link Workspace.root}.
   *
   * D-02: anything resolving outside the root is rejected at the interface, not
   * by the caller remembering to check.
   */
  read(relPath: string): Promise<string>;
  /** Write a file, by a path relative to {@link Workspace.root}. Same containment rule as {@link Workspace.read}. */
  write(relPath: string, contents: string): Promise<void>;
  /** Capture the current state so a later round can return to it. */
  snapshot(): Promise<RestoreHandle>;
  /** Tear the workspace down, including the scratch `HOME`. */
  destroy(): Promise<void>;
}
