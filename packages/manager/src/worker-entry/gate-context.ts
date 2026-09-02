/**
 * The one narrowing point between an `assign` message and a gate (ROLE-03,
 * M05 step 5.17).
 *
 * A forked worker receives an {@link AssignMessage} carrying everything it
 * needs for *any* stage — including `logsRoot`, `roundId` and `stageAttemptId`,
 * which together address the developer's own transcript file, and
 * `sendBackBriefJson`, which is a prior round's findings. None of that is spec,
 * diff, or repository, and M05's AC3 says gate context is assembled from those
 * three **only**.
 *
 * So a gate is never handed the message. It is handed a {@link GateContext},
 * which this module builds — and `GateContext` has no member through which any
 * of the above can be named (`@adl/core/stage`'s `gate-context.ts` carries the
 * full argument, plus the compile-time and suite-level guards that keep it
 * true). This file is where the wide type stops.
 *
 * **It is deliberately not under `worker-entry/gates/`.** That directory is
 * governed by `eslint.config.js`'s `adl/gate-fresh-context`, which bans
 * importing `../ipc/protocol.js` at all — the residual a type cannot reach, in
 * exactly the shape `adl/no-forge-merge` exists for (FORGE-10's port guard
 * cannot stop an adapter reaching past the port through the client it already
 * holds). A narrowing function has to import the thing it narrows, so it lives
 * on this side of the boundary and returns the narrow type across it.
 *
 * ── Classify, don't throw ─────────────────────────────────────────────────
 *
 * Assembly does real I/O — a directory listing, a file read, two `git`
 * invocations — and any of it can fail. Every failure is returned as a
 * {@link StageErrorKind} the caller turns into a `StageError`, never a verdict:
 * a gate whose context could not be assembled **judged nothing**, and reporting
 * a verdict anyway would make an infrastructure failure cost the developer a
 * round (CORE-06, D-12). That is the same discipline `command-gate.ts` applies
 * to a command ADL had to kill.
 */
import type {
  AgentEvent,
  AgentRunner,
  GateContext,
  Workspace,
} from '@adl/core/stage';
import type { StageErrorKind } from '@adl/core/stage';
import { managerGitClient } from '@adl/workspace';
import type { AssignMessage } from '../ipc/protocol.js';
import { loadSpecFromWorktree } from './spec-from-worktree.js';

/** What {@link buildGateContext} answers — the context, or why there isn't one. */
export type GateContextResult =
  | { readonly ok: true; readonly gate: GateContext }
  | {
      readonly ok: false;
      readonly kind: StageErrorKind;
      readonly detail: string;
    };

export interface BuildGateContextInput {
  /** The workspace this stage attached to — already carrying the developer's commit (M05 step 5.14). */
  readonly workspace: Workspace;
  /** The dispatch being narrowed. Nothing on it reaches the returned context except the fields named below. */
  readonly assign: AssignMessage;
  /** The transcript sink the caller already opened for this attempt. */
  readonly onEvent: (event: AgentEvent) => void;
  /**
   * This stage's own `with:` block, already resolved from the snapshotted
   * pipeline by the caller (M07 step 7.1, HARN-01).
   *
   * Resolved by the caller rather than here because the caller has already
   * parsed `effectiveConfigJson` for its own reasons, and resolving the
   * pipeline twice per dispatch would be two chances to disagree about what the
   * pipeline is — the exact hazard `resolveSnapshotPipeline`'s "exactly one
   * caller" note exists to prevent.
   */
  readonly config: Readonly<Record<string, unknown>>;
  /**
   * The agent runner this gate may call a model through — **already reporting
   * its own spend** (M07 step 7.1, closing `DEBT.md`'s D-5-18-1).
   *
   * The obligation lives on the runner, not on the gate, so there is no call a
   * gate can forget to make (rule 9). This function does not construct one: it
   * has no business deciding what a model invocation costs or where that cost
   * is reported, and the caller is the module that already owns both.
   */
  readonly agents: AgentRunner;
  readonly signal?: AbortSignal;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Assemble a gate's context from the repository, and nothing else.
 *
 * Exactly three fields of `assign` are read, and each is repository state
 * rather than anything the developer's agent produced:
 *
 * - `stageId` — which pipeline entry this is, straight from `adl.yml`;
 * - `workspaceHandle` — the feature's folder, so the spec can be found;
 * - `baseRef` — the commit the feature branched from, so the diff has a base.
 *
 * The commit under judgement is read from the workspace's own `HEAD` rather
 * than from the message: a stage's HEAD is what the previous stage actually
 * left there, and a sha reported over IPC is a second answer to the same
 * question. (`rounds.head_sha` exists for the manager's own use — 5.14 — and is
 * not on this wire.)
 *
 * The diff is `base...head`, three dots, so it compares against the merge base
 * rather than `base`'s own tip; `ManagerGitClient.diffNameOnly`'s docblock
 * carries the reasoning, and 5.16's protected-path check is the other caller
 * relying on it. This one runs inside the attached **worktree**, which shares
 * its parent repository's object database, so both ends of the range resolve
 * with no second workspace and no manager round trip.
 */
export async function buildGateContext(
  input: BuildGateContextInput,
): Promise<GateContextResult> {
  const { workspace, assign, onEvent } = input;

  let spec;
  try {
    spec = await loadSpecFromWorktree(workspace, assign.workspaceHandle);
  } catch (error) {
    return {
      ok: false,
      // `unparseable` and not `provider_error`: a spec that will not load is
      // not going to load on a retry either, and `stageErrorPolicy` makes this
      // kind non-retryable so the round loop escalates rather than spinning.
      kind: 'unparseable',
      detail: `the ${assign.stageId} gate's context could not be assembled — the spec failed to load from the worktree: ${messageOf(error)}`,
    };
  }

  const git = managerGitClient(workspace);
  let head: string;
  let changedPaths: readonly string[];
  try {
    head = await git.revParse('HEAD');
    changedPaths = await git.diffNameOnly(assign.baseRef, head);
  } catch (error) {
    return {
      ok: false,
      // Retryable, unlike the spec case: a `git` invocation that failed once
      // (a lock held by another process, an exhausted file handle) is the kind
      // of thing that succeeds on the next dispatch, and CORE-06 is emphatic
      // that a gate which could not run must not cost a round.
      kind: 'provider_error',
      detail: `the ${assign.stageId} gate's context could not be assembled — the diff against ${assign.baseRef} failed: ${messageOf(error)}`,
    };
  }

  return {
    ok: true,
    gate: {
      stageId: assign.stageId,
      workspace,
      spec,
      diff: { base: assign.baseRef, head, changedPaths },
      config: input.config,
      agents: input.agents,
      onEvent,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    },
  };
}
