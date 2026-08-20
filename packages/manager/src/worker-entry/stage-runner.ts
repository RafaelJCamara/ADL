/**
 * `createProductionStageRunner` — the real production `StageRunner`
 * `worker-entry/index.ts`'s `main` calls, replacing the named
 * "no agent backend configured in this phase" gap `productionStageRunner`
 * left behind (that function's own docblock names this phase as its
 * replacement).
 *
 * Given an `assign` message, this module:
 *
 * 1. obtains a `Workspace` from the registry using the message's backend id
 *    and workspace fields — never naming a backend factory itself (the
 *    registry is the only module allowed to, per `@adl/workspace`'s own
 *    barrel comment);
 * 2. loads the normalized spec directly from the worktree (the assign
 *    message carries no spec, and this module — like every file under
 *    `worker-entry/` — must not import `@adl/db` to fetch one);
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
 * 7. closes the writer and destroys the workspace on every exit path,
 *    including a failure — a leaked worktree turns one bad run into an
 *    accumulating one.
 *
 * This module imports NO process library and NO `@adl/db` — the existing
 * `adl/no-direct-spawn` and `adl/worker-entry-no-db` lint rules cover the
 * whole `worker-entry/` directory and say so. Everything the manager needs
 * to persist travels over the existing `fork()` IPC channel as `verdictJson`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { EffectiveConfig } from '@adl/core/config';
import {
  detectFormat,
  loadAdlTemplateSpec,
  loadGherkinSpec,
  LoadError,
  type NormalizedSpec,
} from '@adl/core/spec';
import {
  stageErrorPolicy,
  type AgentErrorEvent,
  type AgentEvent,
  type AgentTask,
  type DeveloperOutcome,
  type StageError,
  type StageErrorKind,
  type Workspace,
} from '@adl/core/stage';
import { workspaceRegistry, managerGitClient } from '@adl/workspace';
import {
  CLAUDE_CODE_CAPABILITIES,
  claudeCodeBackend,
  type AgentUsageRecord,
  type ClaudeCodeAgentRunner,
} from '@adl/agent-claude-code';
import type { AssignMessage, WorkerToManagerMessage } from '../ipc/protocol.js';
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

/**
 * Detect the format and load the normalized spec directly from the worktree
 * — the assign message carries no spec.
 *
 * `workspaceHandle` (== `feature.path`, e.g. `"features/export-widgets"`) is
 * the repo-relative feature folder — NOT `assign.featureId`, which is the
 * `features` ROW's own ULID primary key (D-13's identity, unrelated to the
 * `features/<id>/` folder-name identity `NormalizedSpec.id` and the git
 * branch suffix use). Conflating the two here means resolving a folder that
 * does not exist for any feature whose folder name is not itself a ULID.
 * `NormalizedSpec`'s own `id` argument is the folder's *basename* —
 * `features/<basename>/` is the convention D-16 documents.
 */
async function loadSpecFromWorktree(
  workspaceRoot: string,
  workspaceHandle: string,
): Promise<NormalizedSpec> {
  const featureDir = join(workspaceRoot, workspaceHandle);
  const folderName = basename(workspaceHandle);
  const filenames = await readdir(featureDir);
  const detected = detectFormat(filenames);
  const entryPath = join(featureDir, detected.entryFile);
  const raw = await readFile(entryPath, 'utf8');
  return detected.sourceFormat === 'adl-template'
    ? loadAdlTemplateSpec(raw, folderName)
    : loadGherkinSpec(raw, folderName, detected.entryFile);
}

/** Envelope carried over IPC as `verdictJson` — either channel `StageOutcome`/`DeveloperOutcome` sits astride (D-05, D-12). */
export type StageRunnerVerdict =
  | { readonly kind: 'developer_outcome'; readonly outcome: DeveloperOutcome }
  | { readonly kind: 'stage_error'; readonly error: StageError };

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
    const registry = workspaceRegistry();
    const backend = registry.resolve(assign.workspaceBackendId);

    let workspace: Workspace | undefined;
    try {
      workspace = await backend.create({
        featureId: assign.featureId,
        mainRepo: assign.mainRepo,
        scratchRoot: assign.scratchRoot,
        baseRef: assign.baseRef,
      });
    } catch (error) {
      return stageErrorResult(
        'provider_error',
        `could not create the workspace: ${error instanceof Error ? error.message : String(error)}`,
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
      let spec: NormalizedSpec;
      try {
        spec = await loadSpecFromWorktree(
          workspace.root,
          assign.workspaceHandle,
        );
      } catch (error) {
        const detail =
          error instanceof LoadError
            ? `spec failed to load from the worktree: ${error.message}`
            : `could not load the spec from the worktree: ${error instanceof Error ? error.message : String(error)}`;
        return stageErrorResult('unparseable', detail);
      }

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

      const { systemPrompt, instructions } = buildDeveloperPrompt({
        spec,
        effectiveConfig,
        capabilities: CLAUDE_CODE_CAPABILITIES,
        // The declared `context.files` in `effectiveConfig` are resolved
        // against the feature's own worktree — never the daemon's cwd (04-09
        // Task 1's explicit-context surface).
        workspaceRoot: workspace.root,
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

      const controller = new AbortController();
      let firstError: AgentErrorEvent | undefined;
      const appendPromises: Promise<void>[] = [];

      const task: AgentTask = {
        systemPrompt,
        instructions,
        contextFiles: [],
        ...(effectiveConfig.agents.developer.model !== undefined
          ? { model: effectiveConfig.agents.developer.model }
          : {}),
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
      // property for Phase 3. An invocation whose backend reported no usage
      // at all (`runResult.usageRecord` undefined) sends nothing — an event
      // that did not happen is not the same as one with nothing in it.
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

      return developerOutcomeResult({ kind: 'committed', sha: headAfter });
    } finally {
      if (!writerClosed) {
        writerClosed = true;
        await writer.close();
      }
      await workspace.destroy();
    }
  };
}
