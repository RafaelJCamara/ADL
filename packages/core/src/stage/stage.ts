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
 *
 * A third difference arrived in M07 step 7.1: `run` takes a
 * {@link GateContext}, not the `StageContext` this file used to declare. See
 * the note where the forward declarations used to be.
 */
import type { GateContext } from './gate-context.js';
import type { StageOutcome } from './stage-error.js';

/**
 * Re-exported so `@adl/core/stage` remains the single import path for the whole
 * stage surface. Both were forward declarations in this file once; Phases 2 and
 * 4 replaced them with real interfaces, and M07 step 7.1 moved the place a gate
 * receives them to {@link GateContext}.
 */
export type { Workspace } from './workspace.js';
export type { AgentRunner } from './agent.js';

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
 * The forward declarations are gone (M07 step 7.1)
 *
 * `FeatureView`, `StageConfig`, `ArtifactSink` and `RoundSummary` used to be
 * declared here as opaque placeholders, each naming the phase that would supply
 * it, and `StageContext` was assembled from them. None was ever supplied, and
 * `Stage` was never implemented by any production code — the built-in gates are
 * plain functions taking a {@link GateContext}.
 *
 * M07 could not leave both types standing. HARN-04 asks that the reviewer run
 * on "the same interface third parties use", and with two candidate interfaces
 * that is not a statement that can be true. `GateContext` won, because it is the
 * one two real consumers take and the one carrying ROLE-03's machine-checked
 * member list — see its own module docblock, and `DECISIONS.md`, for the full
 * argument and for what each dropped declaration was replaced by (or
 * deliberately not).
 *
 * `Workspace` and `AgentRunner` were forward declarations here once too; Phases
 * 2 and 4 replaced them with real interfaces, which are imported and re-exported
 * above and now reach a gate through `GateContext`.
 * ---------------------------------------------------------------------- */

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
  run(ctx: GateContext): Promise<StageOutcome>;
}
