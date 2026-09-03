/**
 * `createProductionStageRunner` — the real production `StageRunner`
 * `worker-entry/index.ts`'s `main` calls, replacing the named
 * "no agent backend configured in this phase" gap `productionStageRunner`
 * left behind (that function's own docblock names this phase as its
 * replacement).
 *
 * **It runs one of two things** (M05 step 5.14), decided by
 * {@link resolveStageRole} from the pipeline position and the stage id alone:
 * the developer agent at index 0, or a {@link runCommandGate} at any later
 * index whose stage id this build has an implementation for. A stage id it
 * cannot run is refused before a workspace is opened. The steps below describe
 * the developer path; the gate path shares 1, 4 and 7 and skips the rest.
 *
 * **The gate path also narrows** (M05 step 5.17). It does not hand a gate the
 * `assign` message — it calls `buildGateContext` and hands over the
 * {@link GateContext} that returns: spec, diff and repository, and no member
 * naming the developer's session, transcript, rendered prompt or send-back
 * brief. This module is therefore the last place both types are in scope
 * together, which is exactly why the narrowing lives at this boundary and not
 * inside the gate (ROLE-03, AC3).
 *
 * Given an `assign` message, this module:
 *
 * 1. obtains a `Workspace` from the registry using the message's backend id
 *    and workspace fields — **attaching to the one a previous stage left, and
 *    creating one only when there is none** (M05 step 5.14) — never naming a
 *    backend factory itself (the registry is the only module allowed to, per
 *    `@adl/workspace`'s own barrel comment);
 * 2. loads the normalized spec from the worktree through
 *    `spec-from-worktree.ts` — shared with gate-context assembly, since the
 *    developer and the gate judging it must not read two different documents
 *    (the assign message carries no spec, and this module — like every file
 *    under `worker-entry/` — must not import `@adl/db` to fetch one);
 * 3. renders the developer prompt through `buildDeveloperPrompt` — the
 *    adapter builds no prompt of its own;
 * 4. opens a transcript writer at the path the message's attempt address
 *    resolves to, and appends one record per event AS IT ARRIVES — never
 *    buffered until the run ends, which is what makes the live view live
 *    and what keeps a mid-run crash from losing everything;
 * 5. writes the rendered prompt as an artifact (`prompt/artifact.ts`),
 *    BEFORE launching the agent — a crash mid-run still leaves a record of
 *    what was asked (04-09 Task 2). A write failure fails the attempt
 *    rather than being swallowed: an attempt that ran with no recorded
 *    prompt is unauditable, which is the property that file exists to
 *    prevent;
 * 6. runs the backend, classifying its outcome; and
 * 7. closes the writer and **detaches** from the workspace on every exit path,
 *    including a failure — reclaiming the run's scratch `HOME` while leaving
 *    the worktree and its branch for the next stage. It deliberately does not
 *    `destroy()`: doing so at the end of every stage is `docs/plan/DEBT.md`
 *    D-5-13-1, which this step closes.
 *
 * This module imports NO process library and NO `@adl/db` — the existing
 * `adl/no-direct-spawn` and `adl/worker-entry-no-db` lint rules cover the
 * whole `worker-entry/` directory and say so. Everything the manager needs
 * to persist travels over the existing `fork()` IPC channel as `verdictJson`.
 */
import { basename } from 'node:path';
import {
  AGENT_ROLES,
  BACKEND_DEFAULT_MODEL,
  CommandGateWithSchema,
  type AgentRole,
  type CommandGateOutputMode,
  type CommandSpec,
  type EffectiveConfig,
  type ResolvedStage,
} from '@adl/core/config';
import { LoadError, type NormalizedSpec } from '@adl/core/spec';
import {
  stageErrorPolicy,
  type AgentErrorEvent,
  type AgentEvent,
  type AgentRunner,
  type AgentTask,
  type DeveloperOutcome,
  type GateContext,
  type StageErrorKind,
  type Workspace,
} from '@adl/core/stage';
import {
  workspaceRegistry,
  managerGitClient,
  branchNameFor,
} from '@adl/workspace';
import {
  CLAUDE_CODE_CAPABILITIES,
  claudeCodeBackend,
  type AgentUsageRecord,
  type ClaudeCodeAgentRunner,
} from '@adl/agent-claude-code';
import { composeBranchFeatureId } from '../branch-identity.js';
import { resolveSnapshotPipeline } from '../pipeline.js';
import { parseSendBackBriefJson } from '../loop/send-back-brief.js';
import { buildGateContext } from './gate-context.js';
import { runCommandGate } from './gates/command-gate.js';
import { runReviewerGate } from './gates/reviewer-gate.js';
import { loadSpecFromWorktree } from './spec-from-worktree.js';
import type { AssignMessage, WorkerToManagerMessage } from '../ipc/protocol.js';
import type { StageRunnerVerdict } from '../ipc/stage-verdict.js';
import { unknownCitedCriteria } from '@adl/core/verdict';
import { writePromptArtifact } from '../prompt/artifact.js';
import { buildDeveloperPrompt } from '../prompt/build.js';
import { openTranscriptWriter } from '../store/ndjson-log-store.js';
import {
  transcriptPathFor,
  type TranscriptAddress,
} from '../store/transcript-path.js';
import type { StageRunner, StageRunnerResult } from './index.js';

/**
 * Wall-clock ceiling for the one agent invocation this runner performs.
 *
 * `EffectiveConfig.limits` (`packages/core/src/config/adl-yml.ts`) has no
 * per-invocation wall-clock field today — `max_rounds`, `budget_usd`, and
 * `repeat_finding_threshold` are round/spend ceilings, not a single exec's
 * timeout. Phase 6's budget enforcement is where a configured value belongs;
 * this constant is a conservative placeholder documented as such rather than
 * an unbounded run.
 */
const DEFAULT_MAX_WALL_CLOCK_MS = 10 * 60 * 1000;

/** The name every commit this backend produces is attributed to (Task 2, prohibition P2). */
const COMMIT_IDENTITY_NAME = 'ADL (claude-code)';
const COMMIT_IDENTITY_EMAIL = 'adl+claude-code@noreply.local';

/**
 * The commit identity supplied on the agent's own invocation — never derived
 * from the host's configured git identity, which differs between the
 * maintainer's machine and CI (Task 2). These travel as ordinary named
 * environment values on the one exec spec: `env.ts`'s
 * `GIT_EXECUTION_ENV_PREFIXES` refuses a variable that names a program git
 * executes, but `GIT_AUTHOR_*`/`GIT_COMMITTER_*` are data, explicitly carved
 * out by that module's own docblock ("GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL,
 * ... are data or booleans, not programs").
 */
function commitIdentityEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: COMMIT_IDENTITY_NAME,
    GIT_AUTHOR_EMAIL: COMMIT_IDENTITY_EMAIL,
    GIT_COMMITTER_NAME: COMMIT_IDENTITY_NAME,
    GIT_COMMITTER_EMAIL: COMMIT_IDENTITY_EMAIL,
  };
}

function stageErrorResult(
  kind: StageErrorKind,
  detail: string,
): StageRunnerResult {
  const policy = stageErrorPolicy(kind);
  const verdict: StageRunnerVerdict = {
    kind: 'stage_error',
    error: { kind, retryable: policy.retryable, detail },
  };
  return { verdictJson: JSON.stringify(verdict) };
}

function developerOutcomeResult(outcome: DeveloperOutcome): StageRunnerResult {
  const verdict: StageRunnerVerdict = { kind: 'developer_outcome', outcome };
  return { verdictJson: JSON.stringify(verdict) };
}

/**
 * Report one agent invocation's spend over the existing `fork()` IPC channel
 * (04-10 Task 2). This module must not import `@adl/db` — the worker
 * INSERTs nothing itself; the supervisor's `usage` message handler does,
 * through the one existing writer (`usageRepository(db).record`). Mirrors
 * `worker-entry/index.ts`'s own `send()`: `process.send` is only defined
 * when this process was forked with an IPC channel, which is true for every
 * real and scripted invocation of this module.
 */
function sendUsage(leaseToken: string, record: AgentUsageRecord): void {
  if (typeof process.send !== 'function') return;
  const message: WorkerToManagerMessage = {
    t: 'usage',
    leaseToken,
    modelId: record.modelId,
    speed: record.speed,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheCreationInputTokens: record.cacheCreationInputTokens,
    cacheReadInputTokens: record.cacheReadInputTokens,
    costUsd: record.costUsd,
    costSource: record.costSource,
    costCategory: record.costCategory,
  };
  process.send(message);
}

/** An empty `with:` block, shared rather than reallocated per dispatch. */
const NO_STAGE_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * This stage's own `with:` block from the snapshotted pipeline (HARN-01, M07
 * step 7.1).
 *
 * **Empty, never absent**, for the two reasons `GateContext.config` records: a
 * gate reads `ctx.config.foo` without first asking whether `ctx.config` exists,
 * and "this entry declared no configuration" and "the pipeline could not be
 * resolved" must not be told apart by a gate — they are the caller's problem,
 * and by the time this runs the dispatcher has already refused an unresolvable
 * pipeline before forking (`resolveSnapshotPipeline`'s one production caller).
 * So an unresolvable pipeline here is a should-not-happen that degrades to "no
 * configuration" rather than a second refusal path with nothing to refuse.
 *
 * Read by index rather than by stage id because a pipeline may legitimately run
 * the same harness twice with different `with:` blocks; the index is what
 * `dispatcher.ts` assigned and the id is not unique to it.
 */
function stageConfigFor(
  assign: AssignMessage,
): Readonly<Record<string, unknown>> {
  return resolvedStageFor(assign)?.with ?? NO_STAGE_CONFIG;
}

/**
 * The snapshotted pipeline entry this dispatch is running, or `undefined` when
 * the pipeline will not resolve or does not agree with the message.
 *
 * Looked up by **index**, then **checked against the id**, and both halves
 * matter. The index is the unambiguous coordinate — `dispatcher.ts` assigns it
 * and `transition()` only ever advances within the same pipeline — so it is
 * what a lookup must key on. But a message whose index and id disagree is a
 * message about a pipeline this worker is not looking at, and reading a
 * *different* stage's `with:` block would hand a gate someone else's
 * configuration: the wrong program, or the wrong `emits` mode, with nothing
 * anywhere reporting a mismatch.
 *
 * `undefined` rather than an error, because every caller already has an honest
 * answer for "this dispatch has no resolved entry": no `with:` block, and no
 * command source. A dispatch that genuinely needed one then fails where it
 * needs it, naming what it could not find.
 */
function resolvedStageFor(assign: AssignMessage): ResolvedStage | undefined {
  const pipeline = resolveSnapshotPipeline(assign.effectiveConfigJson);
  if (!pipeline.ok) return undefined;
  const stage = pipeline.stages[assign.stageIndex];
  return stage?.id === assign.stageId ? stage : undefined;
}

/** What {@link resolveGateCommand} answers — the program to run, or why there isn't one. */
type GateCommandResult =
  | {
      readonly ok: true;
      readonly command: CommandSpec;
      readonly emits?: CommandGateOutputMode;
    }
  | { readonly ok: false; readonly detail: string };

/**
 * Decide which program a command gate runs (HARN-02, M07 step 7.3).
 *
 * Two sources, and the gate's own is the more specific one:
 *
 * 1. **The stage's `with:` block**, validated against `CommandGateWithSchema`.
 *    A third party's gate carries its own program, and `adl.yml`'s
 *    `commands.test` is none of its business.
 * 2. **`commands.test`**, for the built-in `test` stage, which declares no
 *    `with:` block. 5.14's behaviour, unchanged.
 *
 * A `with:` block that is present but will not validate is refused by name
 * rather than silently falling through to `commands.test` — a gate that ran
 * something other than what its configuration said would be worse than one
 * that refused to run.
 */
function resolveGateCommand(
  gate: GateContext,
  effectiveConfig: EffectiveConfig,
): GateCommandResult {
  if (Object.keys(gate.config).length === 0) {
    return { ok: true, command: effectiveConfig.commands.test };
  }

  const parsed = CommandGateWithSchema.safeParse(gate.config);
  if (!parsed.success) {
    return {
      ok: false,
      detail:
        `the ${gate.stageId} gate's \`with:\` block is not a valid command-gate ` +
        `configuration: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    };
  }

  return {
    ok: true,
    command: parsed.data.command,
    emits: parsed.data.emits,
  };
}

/**
 * Wrap an agent runner so every invocation through it reports its own spend
 * (M07 step 7.1, closing `DEBT.md`'s D-5-18-1).
 *
 * **This is why `GateContext` has no `reportUsage` member.** The debt asked for
 * a channel a gate-invoked agent could report usage through; a channel on the
 * *gate* is a call a gate can forget to make, and after M06 a forgotten call is
 * spend that never reaches 6.4's per-feature budget or 6.5's global cap — an
 * agent gate would burn tokens invisibly and the gates would keep running as
 * though it had not. Wrapping the runner makes the obligation unforgettable:
 * the only way a gate can call a model is through this, and this reports (rule
 * 9, structural impossibility over a runtime check).
 *
 * `usageRecord` absent means the agent process was never started, so nothing
 * was invoked and nothing was billed — the same guard, for the same reason, as
 * the developer path's own `sendUsage` call below.
 *
 * **Exported for its own test, and that is the honest state of this step.** No
 * gate calls a model until M07 step 7.4's reviewer exists, so there is no
 * end-to-end path through which this could be observed yet; testing the
 * mechanism directly is better than asserting nothing about it and calling the
 * debt closed. 7.4 is where a real invocation runs through it.
 */
export function reportingAgentRunner(
  inner: ClaudeCodeAgentRunner,
  leaseToken: string,
): AgentRunner {
  return {
    async run(task, ctx) {
      const result = await inner.run(task, ctx);
      if (result.usageRecord !== undefined) {
        sendUsage(leaseToken, result.usageRecord);
      }
      return result;
    },
    probe: () => inner.probe(),
  };
}

/**
 * The BUILT-IN stage ids whose implementation is {@link runCommandGate} (M05
 * step 5.14).
 *
 * One of `BUILT_IN_STAGE_IDS`, and the only one of the three this build can run
 * as a gate: `develop` is the mutator at index 0, and `review` is the reviewer
 * agent, which is M07 step 7.4's.
 *
 * **This list is no longer the whole answer** (HARN-02, M07 step 7.3). A
 * pipeline entry that declares its own `with.command` resolves to
 * `source: 'command'` and runs as a command gate whatever it is called — the
 * point of a plain-command gate being that a third party adds one without
 * ADL knowing its name. This map is what remains: the built-in `test` stage,
 * whose command comes from `adl.yml`'s `commands.test` rather than from its own
 * `with:` block.
 *
 * A `Record<stageId, …>` rather than a chain of `if`s so that adding a built-in
 * is one entry, and so that "what built-ins can this build run?" is a value a
 * test can read rather than control flow it has to re-derive.
 */
/**
 * The model ADL selected for one role, or `undefined` when it selected none
 * (BACK-10, M06 steps 6.9/6.10, shared by the developer and gate paths as of
 * M07 step 7.4).
 *
 * `BACKEND_DEFAULT_MODEL` means "ADL selected no model", which is not the same
 * statement as "ADL selected a model called `default`". Returning `undefined`
 * is what keeps those two apart at the port boundary rather than in each
 * adapter's own head (rule 9).
 *
 * One function rather than the expression written twice, now that two paths
 * need it — a transcribed copy is exactly the mistake that would make the
 * sentinel leak through one path while the other stayed correct (rule 8).
 */
function modelForRole(
  effectiveConfig: EffectiveConfig,
  role: AgentRole,
): string | undefined {
  const model = effectiveConfig.agents[role].model;
  return model === BACKEND_DEFAULT_MODEL ? undefined : model;
}

/**
 * Wrap an agent runner so every task it runs carries the model ADL selected for
 * this role, unless the caller chose one itself (BACK-10, M07 step 7.4).
 *
 * **A gate does not, and should not, know about model selection.** It composes
 * a prompt; which model answers it is the daemon's decision (D-22 as amended by
 * 6.11), read from `effectiveConfig.agents[role].model` by the one module that
 * holds the effective config. Making the gate read it would put the
 * daemon/repo trust boundary inside every third-party gate.
 */
function withSelectedModel(
  inner: AgentRunner,
  model: string | undefined,
): AgentRunner {
  if (model === undefined) return inner;
  return {
    // The gate's own choice wins if it made one — nothing does today, and a
    // gate that genuinely needs a specific model (a security harness pinned to
    // one it was evaluated against) should be able to say so.
    run: (task, ctx) =>
      inner.run(task.model === undefined ? { ...task, model } : task, ctx),
    probe: () => inner.probe(),
  };
}

/**
 * Which gate function implements each agent role (M07 step 7.4).
 *
 * Separate from {@link AGENT_ROLE_PRODUCERS}, which answers "what dispatches
 * this role"; this answers "what runs when it does". A role with a producer and
 * no implementation here is refused by name rather than dispatched into
 * nothing — the honest state of `tester` until M08.
 */
const AGENT_GATE_IMPLEMENTATIONS: Readonly<
  Partial<Record<AgentRole, (gate: GateContext) => Promise<StageRunnerVerdict>>>
> = Object.freeze({ reviewer: runReviewerGate });

const GATE_IMPLEMENTATIONS: Readonly<Record<string, 'command'>> = Object.freeze(
  { test: 'command' },
);

/**
 * The mutator slot's producer — a pipeline *position*, not a stage id (D-05).
 * Named rather than inlined so {@link AGENT_GATE_ROLES} below can tell "this
 * role arrives by position" apart from "this role arrives by stage id"
 * without matching on a bare literal in two places.
 */
const DEVELOPER_PRODUCER = 'pipeline-index-0';

/**
 * How each agent role is produced in this build (BACK-10, M06 step 6.10).
 *
 * {@link DEVELOPER_PRODUCER} — the mutator slot, whatever the stage is called.
 * A stage id — the gate stage that dispatches this role. `null` — a role this
 * build has no producer for at all, which is the honest state of `reviewer`
 * (M07) and `tester` (M08): the branch that reads their configured model is
 * built and unreached, on the `forge.promoteToReady` precedent (5.9 built it,
 * 5.13 wired it in one line) rather than given an invented consumer.
 *
 * Keyed by `AgentRole` and machine-checked against the frozen `AGENT_ROLES`
 * below, so a fourth role fails the **build** rather than silently falling
 * back to the developer's model. That fallback would be an accounting defect
 * and not a cosmetic one: the round's spend would be attributed to a model
 * nobody selected for that role, and `agents.<role>.model` would join
 * `agents.<role>.backend` as a config shape that validates and does nothing.
 */
const AGENT_ROLE_PRODUCERS = Object.freeze({
  developer: DEVELOPER_PRODUCER,
  // M07 step 7.4: the reviewer's producer. This is the one-entry change 6.10
  // was built for — `AGENT_GATE_ROLES` is derived from this map, so the stage
  // classification, the per-role model read and the dispatch all followed from
  // changing `null` to a stage id, with nothing else edited.
  reviewer: 'review',
  tester: null,
}) satisfies Record<AgentRole, string | null>;

/**
 * Compile-time proof the map above covers `AGENT_ROLES` — the frozen list's
 * half of convention 7's pairing. `satisfies` alone checks the *type*; this
 * checks it against the runtime list the rest of the codebase enumerates.
 */
type _EveryAgentRoleProduced =
  Exclude<
    (typeof AGENT_ROLES)[number],
    keyof typeof AGENT_ROLE_PRODUCERS
  > extends never
    ? true
    : never;
const _everyAgentRoleProduced: _EveryAgentRoleProduced = true;
void _everyAgentRoleProduced;

/**
 * Stage id → the agent role that stage runs as, **derived** from
 * {@link AGENT_ROLE_PRODUCERS} rather than restated beside it (convention 8).
 *
 * Holds `review → reviewer` as of M07 step 7.4, and holds it without this
 * declaration being edited: `reviewer: null` became `reviewer: 'review'` in the
 * map above and this lookup, `resolveStageRole`, the per-role model read and
 * the dispatch classification all followed. That is what deriving it bought.
 */
const AGENT_GATE_ROLES: ReadonlyMap<string, AgentRole> = new Map(
  AGENT_ROLES.flatMap((role) => {
    const producer = AGENT_ROLE_PRODUCERS[role];
    return producer === null || producer === DEVELOPER_PRODUCER
      ? []
      : [[producer, role] as const];
  }),
);

/**
 * What this runner is being asked to be for one `assign`.
 *
 * The agent variant carries the `AgentRole` itself (M06 step 6.10) rather
 * than being a bare `'developer'` marker: it is what the model read below
 * indexes `effectiveConfig.agents` with, so "which role is this?" is answered
 * once, here, instead of assumed at the point of use.
 */
type StageRole =
  | { readonly kind: 'agent'; readonly role: AgentRole }
  | { readonly kind: 'command-gate' }
  | { readonly kind: 'unsupported'; readonly detail: string };

/**
 * Decide what to run, from the pipeline position and the stage id alone.
 *
 * **Index 0 is the developer, whatever it is called.** D-05 and
 * `@adl/core/stage/developer-outcome.ts` both state it — "the sequencer
 * special-cases index 0 because `develop` is always the implicit first
 * mutator" — and `@adl/core/loop`'s `planRoundStep` enforces it on the other
 * side by escalating a gate verdict that arrives in the developer's slot. So
 * this branches on the *index* first and the id second, rather than looking up
 * `'develop'`: a pipeline that names its first entry something else still gets
 * the mutator, and the two halves of the contract cannot disagree.
 *
 * Everything else is looked up in {@link AGENT_GATE_ROLES} and then
 * {@link GATE_IMPLEMENTATIONS}, and an id in neither is refused **before a
 * workspace is opened**. The classification is `binary_missing`, which
 * `stageErrorPolicy` makes non-retryable, so the round loop escalates rather
 * than looping forever on a stage that will never exist in this build — and
 * the message names the milestone that supplies it.
 *
 * The agent lookup runs first because it is the more specific claim: a stage
 * id that names an agent role is an agent stage, whatever else it might also
 * appear in. Today the two lookups cannot collide — `AGENT_GATE_ROLES` is
 * empty — but the order is the one that stays correct when M07 fills it.
 */
function resolveStageRole(assign: AssignMessage): StageRole {
  if (assign.stageIndex === 0) return { kind: 'agent', role: 'developer' };
  const agentRole = AGENT_GATE_ROLES.get(assign.stageId);
  if (agentRole !== undefined) return { kind: 'agent', role: agentRole };
  // HARN-02 (M07 step 7.3): an entry carrying its own program is a command
  // gate whatever it is called. Checked before the built-in map because it is
  // the more specific claim — this entry said what it runs, where a built-in
  // id only says which of ADL's own implementations to look up.
  if (resolvedStageFor(assign)?.source === 'command') {
    return { kind: 'command-gate' };
  }
  if (GATE_IMPLEMENTATIONS[assign.stageId] === 'command') {
    return { kind: 'command-gate' };
  }
  return {
    kind: 'unsupported',
    detail:
      `no implementation exists yet for pipeline stage "${assign.stageId}" at index ` +
      `${String(assign.stageIndex)} — this build ships the developer stage and the ` +
      `command gate (${Object.keys(GATE_IMPLEMENTATIONS).join(', ')}). The reviewer ` +
      'is M07, the behaviour tester M08, and third-party harnesses M13.',
  };
}

export interface ProductionStageRunnerDeps {
  /** The agent CLI as an argv prefix — a test seam for the replay double. Defaults to `['claude']`. */
  readonly claudeBinary?: readonly string[];
  /** The child's `PATH`. Defaults to this worker process's own `PATH`. */
  readonly claudeCliPath?: string;
  /** The model credential's value. Defaults to `process.env.ANTHROPIC_API_KEY` (absent, when the worker's own environment does not carry it). */
  readonly credentialEnvValue?: string;
  readonly now?: () => string;
  /**
   * Overrides the real `claudeCodeBackend` entirely — a test seam for
   * asserting ordering (e.g. "the prompt artifact exists on disk the moment
   * `run()` is invoked", 04-09 Task 2) without a real subprocess. Never used
   * in production: `daemon.ts` never sets this field.
   *
   * Typed as {@link ClaudeCodeAgentRunner} (04-10), not the plain
   * `AgentRunner` port, so this module can read `usageRecord` off the
   * resolved run result with no cast. A test double built against the
   * narrower `AgentRunner` interface still satisfies this field structurally
   * — `AgentRunResultWithUsage`'s one extra field is optional, and a
   * function returning the base `AgentRunResult` is still assignable
   * wherever the superset is expected.
   */
  readonly agentBackend?: ClaudeCodeAgentRunner;
}

/**
 * Build the real production `StageRunner`. Every invocation resolves a fresh
 * workspace, agent backend, and transcript writer — this factory holds only
 * the injectable seams (`ProductionStageRunnerDeps`), never per-run state.
 */
export function createProductionStageRunner(
  deps: ProductionStageRunnerDeps = {},
): StageRunner {
  const now = deps.now ?? (() => new Date().toISOString());

  return async (assign: AssignMessage): Promise<StageRunnerResult> => {
    // Decided before a workspace is opened: a stage this build cannot run must
    // not leave a worktree behind on its way to being refused.
    const role = resolveStageRole(assign);
    if (role.kind === 'unsupported') {
      return stageErrorResult('binary_missing', role.detail);
    }

    const registry = workspaceRegistry();
    const backend = registry.resolve(assign.workspaceBackendId);

    // DETECT-05 (5.6): the identity a real dispatch hands the backend is
    // NOT the bare row ULID — it is the folder's basename and the ULID
    // composed together, so the branch this creates can later answer both
    // GC's "which row does this belong to" and DETECT-05's "which folder
    // does this abandoned change request belong to, now that the row is
    // gone" (see `../branch-identity.js`'s own docblock). `assign.featureId`
    // itself is untouched everywhere else in this function — the transcript
    // address, the usage/IPC messages — all of that stays keyed on the bare
    // ULID exactly as before; only the workspace/branch identity changes.
    //
    // M05 step 5.14: **attach first, create only if there is nothing to attach
    // to.** A workspace outlives the stage that created it now, so by the time
    // a gate runs — or round 2's developer, or a crash-recovery dispatch — the
    // worktree carrying the work already exists and `create()` would refuse it
    // (`docs/plan/DEBT.md` D-5-13-1). `attach` reports "nothing here" as
    // `undefined` and a half-present workspace as a throw, so this single
    // expression covers both without a filesystem probe of its own —
    // reclamation decisions still come from feature state, never from disk
    // (WORK-04).
    const workspaceSpec = {
      featureId: composeBranchFeatureId(
        basename(assign.workspaceHandle),
        assign.featureId,
      ),
      mainRepo: assign.mainRepo,
      scratchRoot: assign.scratchRoot,
      baseRef: assign.baseRef,
    };

    let workspace: Workspace;
    try {
      workspace =
        (await backend.attach(workspaceSpec)) ??
        (await backend.create(workspaceSpec));
    } catch (error) {
      return stageErrorResult(
        'provider_error',
        `could not open the workspace: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Shared by the transcript writer AND the prompt artifact (04-09 Task 2)
    // — one address, resolved once, so the two files can never disagree
    // about which attempt they belong to.
    const address: TranscriptAddress = {
      featureId: assign.featureId,
      roundId: assign.roundId,
      stageId: assign.stageId,
      stageIndex: assign.stageIndex,
      // The ordinal from `openAttempt` is not yet threaded through
      // `AssignMessage` (only `stageAttemptId` is). Every dispatch this
      // plan's own code produces is a fresh first attempt, so `1` is
      // correct for the cases this plan proves; a repair/retry ordinal is
      // a natural, non-urgent follow-up.
      attempt: 1,
    };

    let writerClosed = false;
    const writer = await openTranscriptWriter(
      transcriptPathFor(assign.logsRoot, address),
    );

    let seq = 0;
    async function appendRecord(
      event: AgentEvent,
      raw?: string,
    ): Promise<void> {
      await writer.append({
        seq: seq++,
        at: now(),
        event,
        ...(raw !== undefined ? { raw } : {}),
      });
    }

    try {
      let effectiveConfig: EffectiveConfig;
      try {
        effectiveConfig = JSON.parse(
          assign.effectiveConfigJson,
        ) as EffectiveConfig;
      } catch (error) {
        return stageErrorResult(
          'unparseable',
          `effectiveConfigJson on the assign message did not parse as JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Built here rather than inside the developer branch (M07 step 7.1): a
      // gate needs one too, now that `GateContext` carries `agents`. One
      // construction site for both paths, so a gate and the developer cannot
      // end up running against differently-configured backends.
      const credential =
        deps.credentialEnvValue ?? process.env['ANTHROPIC_API_KEY'];
      const backendEnv: Record<string, string> = { ...commitIdentityEnv() };
      if (credential !== undefined) {
        backendEnv['ANTHROPIC_API_KEY'] = credential;
      }

      const agentBackend =
        deps.agentBackend ??
        claudeCodeBackend({
          ...(deps.claudeBinary !== undefined
            ? { binary: deps.claudeBinary }
            : {}),
          path: deps.claudeCliPath ?? process.env['PATH'] ?? '',
          env: backendEnv,
        });

      // Both gate kinds take the same context and differ only in what runs
      // against it (M07 step 7.4). The reviewer sharing this construction with
      // the command gate is HARN-04 as code rather than as a claim: there is no
      // branch here that gives an agent gate anything a third party's gate
      // would not also get.
      const isAgentGate = role.kind === 'agent' && role.role !== 'developer';
      if (role.kind === 'command-gate' || isAgentGate) {
        // M05 step 5.17. **This is the only place a gate is constructed, and
        // `assign` does not cross the line.** `buildGateContext` narrows the
        // message down to spec + diff + repository — ROLE-03's permitted
        // sources — and a gate then sees nothing but that context and its own
        // `adl.yml` block. There is no parameter through which the developer's
        // session, transcript, rendered prompt, or send-back brief could
        // arrive, which is the property AC3 asks for stated as a type rather
        // than as a rule (`@adl/core/stage`'s `gate-context.ts` carries the
        // guard, `eslint.config.js`'s `adl/gate-fresh-context` the residual).
        const appendPromises: Promise<void>[] = [];
        const built = await buildGateContext({
          workspace,
          assign,
          onEvent: (event: AgentEvent) => {
            appendPromises.push(appendRecord(event));
          },
          // HARN-01 (M07 step 7.1): this stage's own `with:` block. Resolved
          // from the same snapshotted pipeline `dispatcher.ts` named this stage
          // from, so the gate reads the configuration the dispatch was made
          // under and not whatever `adl.yml` says now.
          config: stageConfigFor(assign),
          // D-5-18-1 closed by construction: a gate that calls a model does so
          // through a runner that already reports the spend. See
          // `reportingAgentRunner` above for why the obligation is on the
          // runner rather than on a `GateContext` member.
          // Two wrappers, one job each. `reportingAgentRunner` makes the spend
          // unforgettable (D-5-18-1); `withSelectedModel` applies the model
          // ADL chose for this role, so the gate never has to know that model
          // selection exists.
          agents: withSelectedModel(
            reportingAgentRunner(agentBackend, assign.leaseToken),
            role.kind === 'agent'
              ? modelForRole(effectiveConfig, role.role)
              : undefined,
          ),
        });
        if (!built.ok) {
          // Context assembly failed, so the gate never ran, so nothing was
          // judged. A `StageError`, never a verdict (CORE-06, D-12) — the same
          // answer `command-gate.ts` gives for a command it had to kill.
          await Promise.all(appendPromises);
          return stageErrorResult(built.kind, built.detail);
        }
        // HARN-02 (M07 step 7.3): where this gate's program comes from.
        //
        // A stage that declared its own `with.command` runs THAT — it is a
        // third party's gate and `adl.yml`'s `commands.test` is none of its
        // business. The built-in `test` stage has no `with:` block and keeps
        // 5.14's behaviour exactly.
        //
        // A malformed `with:` block is a `StageError`, never a verdict: a gate
        // whose configuration would not parse never ran, so it judged nothing
        // (CORE-06, D-12). Classified `unparseable` rather than
        // `provider_error` because a bad block will not parse on a retry
        // either, and `stageErrorPolicy` makes that kind non-retryable so the
        // round escalates instead of spinning.
        let verdict: StageRunnerVerdict;
        if (role.kind === 'agent') {
          // ROLE-02 (M07 step 7.4). A role with a producer but no
          // implementation is refused by name rather than dispatched into
          // nothing — the honest state of `tester` until M08.
          const implementation = AGENT_GATE_IMPLEMENTATIONS[role.role];
          if (implementation === undefined) {
            await Promise.all(appendPromises);
            return stageErrorResult(
              'binary_missing',
              `pipeline stage "${assign.stageId}" dispatches the ${role.role} role, but this ` +
                'build ships no implementation for it — the behaviour tester is M08.',
            );
          }
          verdict = await implementation(built.gate);
        } else {
          const gateCommand = resolveGateCommand(built.gate, effectiveConfig);
          if (!gateCommand.ok) {
            await Promise.all(appendPromises);
            return stageErrorResult('unparseable', gateCommand.detail);
          }
          verdict = await runCommandGate(built.gate, {
            command: gateCommand.command,
            path: process.env['PATH'] ?? '',
            ...(gateCommand.emits !== undefined
              ? { emits: gateCommand.emits }
              : {}),
          });
        }
        // ROLE-04 (M07 step 7.6): a citation naming a criterion the spec does
        // not contain is `unparseable`, never a verdict.
        //
        // **Applied to every gate, of every kind, and that is deliberately
        // wider than the step sketch asked for.** The sketch put this inside
        // the reviewer, on the grounds that the reviewer is what holds the
        // spec. But a plain-command gate in `emits: verdict` mode (7.3) can
        // print `{"kind":"criterion","id":"AC-99"}` exactly as easily as an
        // agent can, and the `verdict_checked_criteria` row it would write —
        // the table the pull request's coverage section is drawn from — is
        // exactly as false. One check for all gates is both stricter and
        // *less* special-casing than one check for the reviewer, which is what
        // HARN-04 asks for. `citations.ts` carries the full argument.
        //
        // `unparseable` and not a gate failure, for CORE-06's reason and the
        // one that matters more: a gate whose verdict cites a criterion that
        // does not exist did not judge this spec, and reading it as approval
        // is the exact failure ROLE-04 exists to prevent. Non-retryable, so
        // the round escalates to a human rather than spinning.
        //
        // Only a `kind: 'verdict'` envelope cites anything: a `stage_error`
        // carries a `StageError` and is already the answer this check would
        // produce.
        const criterionIds = built.gate.spec.acceptanceCriteria.map(
          (criterion) => criterion.id,
        );
        const unknown =
          verdict.kind === 'verdict'
            ? unknownCitedCriteria({
                verdict: verdict.verdict,
                knownCriterionIds: criterionIds,
              })
            : [];
        if (unknown.length > 0) {
          await Promise.all(appendPromises);
          return stageErrorResult(
            'unparseable',
            `the ${assign.stageId} gate's verdict cites ${unknown.length === 1 ? 'a criterion' : 'criteria'} ` +
              `the spec does not contain: ${unknown.join(', ')}. The spec defines ` +
              `${criterionIds.length === 0 ? 'none' : criterionIds.join(', ')}.`,
          );
        }
        // BACK-09 (M05 step 5.18): this path sends NO `usage` message, and
        // that is the honest answer rather than an omission — a command gate
        // runs `adl.yml`'s test command, not an agent, so there is no model,
        // no token count and no cost. A zero-valued row would be a *claim*
        // that an agent ran for free, which is exactly the shape of lie D-31
        // exists to prevent, and `spendByCategory` would fold it into the
        // totals as one. The ledger's silence here is legible because every
        // stage attempt is a row in `stage_attempts`: a reader joining spend
        // to attempts sees which stage invoked an agent and which did not.
        // A future agent-backed gate (M07's reviewer) reports through this
        // same function's `sendUsage`, one level above the role — see
        // `docs/plan/DEBT.md` D-5-18-1.
        // Every record on disk before the result is reported, matching the
        // developer path's own `await Promise.all(appendPromises)` — a verdict
        // the manager acts on while its evidence is still buffered is a
        // transcript that can lose the thing it was written to explain.
        await Promise.all(appendPromises);
        return { verdictJson: JSON.stringify(verdict) };
      }

      let spec: NormalizedSpec;
      try {
        spec = await loadSpecFromWorktree(workspace, assign.workspaceHandle);
      } catch (error) {
        const detail =
          error instanceof LoadError
            ? `spec failed to load from the worktree: ${error.message}`
            : `could not load the spec from the worktree: ${error instanceof Error ? error.message : String(error)}`;
        return stageErrorResult('unparseable', detail);
      }

      // LOOP-02 (M05 step 5.15): `undefined` on round 1, and degrading to
      // `undefined` on anything malformed — see `send-back-brief.ts`'s own
      // docblock. Either way `buildDeveloperPrompt` renders the same fixed
      // "no prior feedback" placeholder it would render for an absent field.
      const sendBackBrief = parseSendBackBriefJson(assign.sendBackBriefJson);

      const { systemPrompt, instructions } = buildDeveloperPrompt({
        spec,
        effectiveConfig,
        capabilities: CLAUDE_CODE_CAPABILITIES,
        // The declared `context.files` in `effectiveConfig` are resolved
        // against the feature's own worktree — never the daemon's cwd (04-09
        // Task 1's explicit-context surface).
        workspaceRoot: workspace.root,
        ...(sendBackBrief !== undefined ? { sendBackBrief } : {}),
      });

      // Written BEFORE the agent is launched (04-09 Task 2): ordering is the
      // point — a crash during the agent's own run still leaves a record of
      // what was asked. A write failure fails the attempt outright rather
      // than being swallowed; see this module's own docblock and
      // `prompt/artifact.ts`'s.
      try {
        await writePromptArtifact(assign.logsRoot, address, {
          systemPrompt,
          instructions,
        });
      } catch (error) {
        return stageErrorResult(
          'provider_error',
          `could not write the rendered prompt artifact: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const controller = new AbortController();
      let firstError: AgentErrorEvent | undefined;
      const appendPromises: Promise<void>[] = [];

      const task: AgentTask = {
        systemPrompt,
        instructions,
        contextFiles: [],
        // BACK-10 (M06 steps 6.9 and 6.10): the model ADL selected **for this
        // role**, or **nothing at all** when the resolved value is the
        // sentinel. 6.10 replaced a hardcoded `.agents.developer` here; M07
        // step 7.4 moved the read itself into {@link modelForRole}, which the
        // gate path now shares. See that function for why absence rather than
        // the sentinel is what crosses the port.
        ...(modelForRole(effectiveConfig, role.role) === undefined
          ? {}
          : { model: modelForRole(effectiveConfig, role.role) }),
        limits: { maxWallClockMs: DEFAULT_MAX_WALL_CLOCK_MS },
      };

      const git = managerGitClient(workspace);
      let headBefore: string;
      try {
        headBefore = await git.revParse('HEAD');
      } catch (error) {
        return stageErrorResult(
          'provider_error',
          `could not read the workspace's starting HEAD: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const runResult = await agentBackend.run(task, {
        workspace,
        onEvent: (event: AgentEvent) => {
          if (event.kind === 'error' && firstError === undefined) {
            firstError = event;
          }
          appendPromises.push(appendRecord(event));
        },
        signal: controller.signal,
      });
      await Promise.all(appendPromises);

      // 04-10 Task 2: reported over IPC — never inserted from here, since
      // this module must not import `@adl/db` — and sent BEFORE the stage
      // result is reported (`worker-entry/index.ts`'s `runAssignedStage`
      // sends `stage_result` only once THIS function returns). An invocation
      // killed between the two still has its spend on the ledger, matching
      // `.planning/STATE.md`'s existing "burned spend survives a crash"
      // property for Phase 3.
      //
      // BACK-09 (M05 step 5.18): this fires for EVERY round, because the
      // developer stage is dispatched afresh each round with its own
      // `roundId`/`stageAttemptId`, and the record travels keyed to nothing —
      // the supervisor supplies the join keys from its own assignment
      // (T-4-38). What changed in 5.18 is the meaning of the guard below.
      // `usageRecord` is now absent for exactly one reason — the agent
      // process was never started, so nothing was invoked and nothing was
      // billed (see `AgentRunResultWithUsage.usageRecord`). A run that DID
      // start and reported nothing now arrives here carrying an honest
      // `costSource: 'unknown'` record instead of vanishing, which is the
      // difference between a ledger with a visible gap and one with an
      // invisible one.
      if (runResult.usageRecord !== undefined) {
        sendUsage(assign.leaseToken, runResult.usageRecord);
      }

      if (firstError !== undefined) {
        // Prohibition P1: a stage runner whose backend reports a failure —
        // missing binary, auth rejection, non-zero exit, an unclassifiable
        // terminal event — produces an infrastructure-failure outcome, never
        // a passing developer outcome. `agentBackend.run` translates and
        // logs; classifying the observed event stream into the round's
        // terminal report is THIS module's job, not the delegated-loop
        // adapter's (see backend.ts's own docblock).
        return stageErrorResult(firstError.errorKind, firstError.detail);
      }

      let headAfter: string;
      try {
        headAfter = await git.revParse('HEAD');
      } catch (error) {
        return stageErrorResult(
          'provider_error',
          `could not read the workspace's ending HEAD: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (headAfter === headBefore) {
        // Prohibition P1's other half: a run that produced no commit reports
        // that honestly, as a `blocked` DeveloperOutcome — never as a pass.
        return developerOutcomeResult({
          kind: 'blocked',
          reason:
            'the agent run completed with no reported error, but HEAD did not move — no commit was made',
        });
      }

      // M05 step 5.10: push the branch before this function returns — still
      // inside this `try`, before the `finally` below destroys the workspace
      // and reclaims the branch along with it (`Workspace.destroy`'s own
      // contract; see 5.0b's tracer for the same ordering constraint proven
      // by hand). `assign.pushUrl` is a fresh, already-credentialed URL the
      // manager minted for this dispatch (`dispatcher.ts`) — this module
      // never constructs one itself, matching WORK-02's "no forge adapter, no
      // new external dependency" discipline for `worker-entry/**`. Absent
      // (`options.forge` not configured, or the manager's own mint attempt
      // failed) means nothing is pushed.
      if (assign.pushUrl !== undefined) {
        try {
          await git.push(
            assign.pushUrl,
            `HEAD:refs/heads/${branchNameFor(workspace.id)}`,
          );
        } catch (error) {
          // A push failure is reported through the exact same channel as
          // "could not create the workspace" / "could not read HEAD" above —
          // never a degraded-but-`committed` outcome (docs/plan/DEBT.md
          // D-5-R-1's owner step made this call: a retry of a `stage_error`
          // naturally retries the publish too, where a third
          // `DeveloperOutcome` variant would need a core, exhaustiveness-
          // guarded union to grow just for this).
          return stageErrorResult(
            'provider_error',
            `commit ${headAfter} succeeded locally, but pushing the branch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return developerOutcomeResult({ kind: 'committed', sha: headAfter });
    } finally {
      if (!writerClosed) {
        writerClosed = true;
        await writer.close();
      }
      // `detach`, not `destroy` (M05 step 5.14). This stage is over; the
      // workspace is not. The gate at the next index has to judge the commit
      // this stage just made, and round 2's developer has to build on it, so
      // reclaiming the worktree here is precisely the defect D-5-13-1 records.
      // What the *run* owns — the scratch `HOME` — still goes, on every exit
      // path including the failing ones. Reclaiming the workspace itself is a
      // decision made from feature state, and `worktree/gc.ts`'s sweep is what
      // makes it (D-16).
      await workspace.detach();
    }
  };
}
