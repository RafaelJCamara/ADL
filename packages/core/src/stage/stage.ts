/**
 * The gate abstraction (`.planning/research/ARCHITECTURE.md` §3).
 *
 * This is the interface a third-party harness author implements, and the one the
 * built-in reviewer and behaviour tester are themselves implemented against —
 * with no special-casing (HARN-04). If the built-ins needed a privileged path,
 * the extension point would not be real.
 *
 * Two things here differ from the ARCHITECTURE.md sketch, and both are decisions
 * this phase made after it was written:
 *
 * 1. `run` returns a {@link StageOutcome}, not a `Verdict`. D-12 puts the
 *    infrastructure-failure channel in the return type, so "the gate broke" is
 *    something the interface can say. This is the one-way part: once
 *    `@adl/plugin-sdk` is published, changing this signature breaks every
 *    external gate.
 * 2. The verdict union has six outcomes, not the four sketched there
 *    (`.planning/research/SUMMARY.md` § Reconciled Decisions §1).
 */
import type { Finding } from '../verdict/finding.js';
import type { StageOutcome } from './stage-error.js';
import type { Workspace } from './workspace.js';

/**
 * Re-exported so `@adl/core/stage` remains the single import path for the whole
 * stage surface, and so `StageContext.workspace` below needs no edit now that
 * the forward declaration has been replaced by the real interface.
 */
export type { Workspace } from './workspace.js';

/**
 * How a stage is implemented: a model-driven agent, or a shell command.
 *
 * The distinction is about *cost and failure modes*, not capability — a command
 * gate and an agent gate return the same `StageOutcome` and are interchangeable
 * in the pipeline. A command gate that is not a TypeScript module validates its
 * output against the published JSON Schema instead of importing anything.
 */
export type StageKind = 'agent' | 'command';

/**
 * Roughly what running this stage costs.
 *
 * Phase 1 only needs the vocabulary to exist; Phase 7 turns it into the
 * fail-fast policy (`cheap`/`free` default to `on_send_back: continue` so the
 * developer fixes lint, security and tests in one round; `expensive` defaults to
 * `stop` so nobody pays an agent reviewer to review code the tests already
 * rejected).
 */
export type CostClass = 'free' | 'cheap' | 'expensive';

/** One chunk of streamed output from a running stage. */
export interface LogChunk {
  readonly stream: 'stdout' | 'stderr' | 'agent';
  readonly text: string;
}

/* -------------------------------------------------------------------------
 * Forward declarations
 *
 * `@adl/core` is pure: no filesystem, no child processes, no environment. It
 * therefore cannot depend on a workspace implementation, an agent backend, or an
 * artifact store — and it does not need to, because a *type* is all this
 * interface requires. Declaring them here is precisely what lets `Stage` be
 * published in Phase 1, before any of the things it collaborates with exist.
 *
 * Each declaration below names the phase that replaces it with the real thing.
 * They are deliberately opaque rather than `{}`: an empty interface is satisfied
 * by every non-nullish value, so `workspace: {}` would happily accept a number.
 *
 * `Workspace` used to be one of them. Phase 2 replaced it with the real
 * interface in `./workspace.js`, which is imported and re-exported above — the
 * declarations below are what remains.
 * ---------------------------------------------------------------------- */

/** **Forward declaration.** Phase 3 supplies the feature view: normalized spec, branch, round, headSha. */
export interface FeatureView {
  /** Structural placeholder only; never read. */
  readonly __adlForwardDeclaration?: never;
}

/** **Forward declaration.** Plan 01-07 supplies this stage's resolved `adl.yml` config block. */
export interface StageConfig {
  /** Structural placeholder only; never read. */
  readonly __adlForwardDeclaration?: never;
}

/** **Forward declaration.** Phase 4 supplies the agent runner — the only way to call a model, and it meters cost. */
export interface AgentRunner {
  /** Structural placeholder only; never read. */
  readonly __adlForwardDeclaration?: never;
}

/** **Forward declaration.** Phase 3 supplies the artifact sink that `StageError.rawRef` points into. */
export interface ArtifactSink {
  /** Structural placeholder only; never read. */
  readonly __adlForwardDeclaration?: never;
}

/** **Forward declaration.** Phase 5 supplies the compressed prior-round summary. */
export interface RoundSummary {
  /** Structural placeholder only; never read. */
  readonly __adlForwardDeclaration?: never;
}

/** Everything a stage is given when it runs. */
export interface StageContext {
  /** Exec / read / write / snapshot. The real interface lives in `./workspace.ts`. */
  readonly workspace: Workspace;
  /** The normalized spec, branch, round and head sha for this feature. */
  readonly feature: FeatureView;
  /** This stage's own config block from `adl.yml`. */
  readonly config: StageConfig;
  /** Findings raised by *earlier* stages in this same round. */
  readonly priorFindings: readonly Finding[];
  /** Compressed summaries of prior rounds. */
  readonly history: readonly RoundSummary[];
  /** The only way to call a model. Meters cost, so budget enforcement is not optional. */
  readonly agents: AgentRunner;
  /** Where evidence blobs go — including the capped raw output behind `StageError.rawRef`. */
  readonly artifacts: ArtifactSink;
  /** Streams output to the manager as the stage runs. */
  readonly log: (chunk: LogChunk) => void;
  /** Fires on budget interrupt, pause, or shutdown. A stage that ignores it will be killed. */
  readonly signal: AbortSignal;
}

/** A gate in the pipeline. */
export interface Stage {
  /** Stable, and what `adl.yml` references. Also the `stageId` half of a finding's fingerprint. */
  readonly id: string;
  readonly kind: StageKind;
  /**
   * May this stage modify the workspace?
   *
   * `develop` is the implicit first mutator (D-05). The flag exists in Phase 1
   * because it is what gates the v2 `group:` parallel syntax — a mutating stage
   * cannot run alongside anything over one worktree.
   */
  readonly mutates: boolean;
  readonly costClass: CostClass;
  /**
   * Judge, or report that you could not (D-12).
   *
   * Returning a `StageError` is not a failure of the implementation — it is the
   * honest answer when the binary is missing, the provider is down, the clock
   * ran out, or the model produced something that is not a verdict. It costs the
   * developer no round.
   */
  run(ctx: StageContext): Promise<StageOutcome>;
}
