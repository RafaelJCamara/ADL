/**
 * `GateContext` — everything a gate is given, and ROLE-03's guarantee that the
 * list ends there (M05 step 5.17).
 *
 * ROLE-03: *"Reviewer works from fresh context — it never inherits the
 * developer's session, transcript, or reasoning."* M05's own acceptance
 * criterion states the mechanism as well as the property: *"Gate context is
 * assembled from spec, diff and repository only; the developer's session and
 * transcript are structurally unreachable."*
 *
 * **Structurally**, in this file, means: a gate is handed one of these and has
 * no member through which a session or a transcript can be *named*. Not a rule
 * in a prompt, not a review convention — a parameter list with nothing on it to
 * reach through. `docs/plan/DECISIONS.md` records why this matters more than it
 * looks: ImpossibleBench measured frontier models exploiting conflicting tests
 * up to 76% of the time, and a reviewer that can read the developer's own
 * reasoning about *why* a test is wrong is a reviewer being handed the argument
 * for agreeing with it.
 *
 * ## The three permitted sources, and what each one is
 *
 * | Member | Source | Why it is safe |
 * |---|---|---|
 * | {@link GateContext.spec} | the repository | the maintainer's own file, protected by ROLE-11 |
 * | {@link GateContext.diff} | the repository | what the branch *wrote*, never what it said about writing it |
 * | {@link GateContext.workspace} | the repository | the worktree, contained to its own root (D-02) |
 *
 * The workspace is the interesting one, because it is a live filesystem handle
 * and looks like the widest member here. It is not: `Workspace.read` and
 * `Workspace.exec` both refuse a path outside {@link Workspace.root} at the
 * interface (D-02, WR-01), and a transcript does not live under a workspace
 * root — it lives beside the database, under the manager's own logs directory.
 * So "the gate cannot read the developer's transcript" is a consequence of
 * containment that already exists, not a new promise made here.
 * `packages/manager/test/worker-entry/gate-context.test.ts` asserts that
 * separation rather than leaving it to be re-derived, because it is the one
 * link in this argument that lives outside the type.
 *
 * ## What is deliberately absent
 *
 * No `sessionRef` (the opaque resumable-session token `./agent.ts` models), no
 * transcript, no transcript root, no rendered prompt, no prior-round brief. Each
 * of those exists in this codebase and each is reachable from the `assign`
 * message a worker receives — which is exactly why the gate is handed *this*
 * instead. `packages/manager/src/worker-entry/gate-context.ts` is the single
 * narrowing point between the two, and `eslint.config.js`'s
 * `adl/gate-fresh-context` closes the residual that a type cannot reach: a gate
 * module importing the transcript store or the prompt builder directly, the
 * same shape `adl/no-forge-merge` exists for (FORGE-10's port guard cannot stop
 * an adapter reaching past the port through the client it already holds).
 *
 * ## This is not a second `StageContext`
 *
 * {@link StageContext} is the **published third-party** gate contract — what
 * `@adl/plugin-sdk` will republish, and what `Stage.run` takes. Four of its nine
 * members are still forward declarations that nothing supplies (`FeatureView`,
 * `StageConfig`, `ArtifactSink`, `RoundSummary`), and no production code
 * implements `Stage` at all: the built-in gates are plain functions. So
 * `StageContext` cannot carry this guarantee today — an `Exclude<>` assertion
 * over an interface whose members are opaque placeholders proves nothing.
 *
 * `GateContext` is what the **built-in** gates take now, and it is deliberately
 * **not** exported from `@adl/plugin-sdk`: publishing a second context type into
 * the third-party surface before M13 has a real harness to shape it against is
 * the one move here that would be one-way (D-01). When `StageContext`'s forward
 * declarations are filled, {@link GATE_CONTEXT_MEMBERS} is the list its own
 * fresh-context guarantee has to be re-derived over — and `FeatureView`'s
 * declared shape (spec, branch, round, headSha) is why it could not simply be
 * filled here: the round *number* is not on the worker's wire at all, only the
 * round id.
 */
import type { NormalizedSpec } from '../spec/types.js';
import type { AgentEvent } from './agent.js';
import type { Workspace } from './workspace.js';

/**
 * What this feature's branch wrote, as repository facts.
 *
 * Three fields, and the absence of a fourth is the point: there is no field for
 * *why* it was written. A gate judging a diff is judging the code; a gate
 * reading the developer's account of the code is ROLE-03 being violated with
 * extra steps.
 *
 * `changedPaths` rather than a unified diff body, for now. The command gate
 * (M05 step 5.14) reads neither, and an agent gate reads the files themselves
 * through {@link GateContext.workspace} — the path list is what tells it *where
 * to look*, which is the level M07's reviewer actually needs. A diff body is a
 * widening this type can take later if a gate is found that needs the text and
 * cannot read the tree; adding it speculatively would mean rendering, holding
 * and streaming a potentially enormous string for every gate that ignores it.
 */
export interface GateDiff {
  /**
   * The commit this feature's work branches from — `WorkspaceSpec.baseRef`.
   *
   * `base...head` is what produced {@link GateDiff.changedPaths}: three dots,
   * so the comparison is against the merge base rather than `base`'s own tip.
   * `ManagerGitClient.diffNameOnly`'s docblock carries the full reasoning; the
   * short version is that a default branch which moved on for unrelated reasons
   * must not appear in this feature's diff.
   */
  readonly base: string;
  /** The commit under judgement — the workspace's `HEAD` at the moment the gate was assembled. */
  readonly head: string;
  /** Repo-relative paths that differ between {@link GateDiff.base} and {@link GateDiff.head}. */
  readonly changedPaths: readonly string[];
}

/**
 * Everything a gate is given. See the module docblock for what is deliberately
 * not on it.
 */
export interface GateContext {
  /**
   * The pipeline entry this gate is running as — one half of a finding's
   * fingerprint, the other being the finding's own title.
   *
   * A stage *id*, never a stage attempt id: the attempt id addresses a
   * transcript, and handing a gate the coordinate of a transcript would give
   * back with one field what the rest of this type exists to withhold.
   */
  readonly stageId: string;
  /**
   * The repository, at the commit under judgement — already carrying the
   * developer's work, because a stage attaches to the workspace the previous
   * stage left rather than branching afresh (M05 step 5.14).
   */
  readonly workspace: Workspace;
  /** The feature's normalized spec, loaded from that same repository. */
  readonly spec: NormalizedSpec;
  /** What this feature's branch wrote. */
  readonly diff: GateDiff;
  /**
   * Every transcript event, as it happens — appended by the caller, never
   * buffered until the run ends, so `adl logs -f` is live on a gate for the
   * same reason it is live on the developer.
   *
   * A **sink**, not a source. A gate writes its own attempt's transcript
   * through this and has no read side, which is what keeps "the gate emits a
   * transcript" from quietly becoming "the gate can read one".
   */
  readonly onEvent: (event: AgentEvent) => void;
  /** Fires on budget interrupt, pause, or shutdown — the same signal `ExecSpec.signal` takes. */
  readonly signal?: AbortSignal;
}

/**
 * Every member {@link GateContext} declares, as runtime data — ROLE-03's guard,
 * in the same two-doors shape `@adl/core/forge`'s `FORGE_ADAPTER_MEMBERS` uses
 * for FORGE-10 (M05 step 5.12).
 *
 *  1. **Adding a member without listing it fails the BUILD.** The
 *     `Exclude<keyof GateContext, …> extends never` assertion below is the
 *     construction `FEATURE_EVENT_KINDS`, `AGENT_EVENT_KINDS` and
 *     `FORGE_ADAPTER_MEMBERS` already use.
 *  2. **Listing a forbidden one fails the SUITE.**
 *     `packages/core/test/stage/gate-context.test.ts` reads this list and
 *     rejects any session-, transcript- or prompt-shaped name in it.
 *
 * The `satisfies` clause closes the third direction: a name here that is not a
 * member of the interface — a stale entry left by a rename, which would quietly
 * shrink what the test is reading — is also a build error.
 */
export const GATE_CONTEXT_MEMBERS = Object.freeze([
  'stageId',
  'workspace',
  'spec',
  'diff',
  'onEvent',
  'signal',
] as const) satisfies readonly (keyof GateContext)[];

export type GateContextMember = (typeof GATE_CONTEXT_MEMBERS)[number];

/**
 * The same list for {@link GateDiff}, and it is not redundant.
 *
 * Door 2 reads member *names*, so a nested type is a hole in it: a
 * `developerTranscript` added to `GateDiff` would reach a gate through
 * `ctx.diff` while `GATE_CONTEXT_MEMBERS` still read `['stageId', 'workspace',
 * 'spec', 'diff', …]` and the test stayed green. `GateDiff` is the one member
 * type this file owns, so it is the one that needs its own list; `Workspace`
 * and `NormalizedSpec` are governed where they are declared, and the module
 * docblock says why each is safe.
 */
export const GATE_DIFF_MEMBERS = Object.freeze([
  'base',
  'head',
  'changedPaths',
] as const) satisfies readonly (keyof GateDiff)[];

export type GateDiffMember = (typeof GATE_DIFF_MEMBERS)[number];

/**
 * Compile-time proof that neither list omits a member — door 1 above. A member
 * added to either interface and not listed fails the **build**, not a test,
 * which is what stops the fresh-context assertion from silently narrowing to a
 * subset of the type it claims to read.
 */
type _EveryGateContextMemberListed =
  Exclude<keyof GateContext, GateContextMember> extends never ? true : never;
const _everyGateContextMemberListed: _EveryGateContextMemberListed = true;
void _everyGateContextMemberListed;

type _EveryGateDiffMemberListed =
  Exclude<keyof GateDiff, GateDiffMember> extends never ? true : never;
const _everyGateDiffMemberListed: _EveryGateDiffMemberListed = true;
void _everyGateDiffMemberListed;
