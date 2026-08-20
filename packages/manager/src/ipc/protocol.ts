import * as z from 'zod';
import { WORKSPACE_BACKEND_IDS } from '@adl/workspace';

/**
 * The manager <-> worker IPC contract, carried over the `fork()` channel
 * `@adl/workspace`'s `forkWorker` opens (D-01).
 *
 * Two Zod discriminated unions on a `t` discriminator, following the
 * `.strictObject` + `.meta({ id })` convention `effective-config.ts` already
 * establishes. Every lease-scoped kind carries `leaseToken` as a *required*
 * field — D-06 says the fence is applied in both places (the message check
 * here, and every lease-scoped SQL `UPDATE`), and this is the message half's
 * precondition.
 *
 * `IPC_MESSAGE_KINDS` pairs a frozen runtime list with a compile-time
 * `Exclude<>` exhaustiveness assertion, exactly like `FEATURE_EVENT_KINDS`
 * (`@adl/core/state`) does: a kind added to either union but missing from the
 * list fails the **build**, not a test.
 *
 * `assign` carries the full workspace spec (`mainRepo`, `scratchRoot`,
 * `baseRef`, `workspaceBackendId`) and the round/attempt addressing a worker
 * needs (`roundId`, `stageAttemptId`, `stageId`, `stageIndex`) — 04-04's
 * point. A forked worker cannot read the daemon's own configuration file (it
 * holds no handle to it) and must not read the database
 * (`adl/worker-entry-no-db`), so this message is the only channel it has.
 * Every one of these fields is required for exactly that reason: an
 * optional one would be a worker that has to guess, and a guessed workspace
 * root is a process running somewhere nobody chose (T-4-14).
 */

const LeaseTokenSchema = z.string().min(1);

// ---------------------------------------------------------------------------
// Worker -> manager
// ---------------------------------------------------------------------------

export const ReadyMessageSchema = z
  .strictObject({
    t: z.literal('ready'),
    leaseToken: LeaseTokenSchema,
    pid: z.number().int().positive(),
    startedAt: z.string(),
  })
  .meta({ id: 'WorkerReadyMessage' });

export const HeartbeatMessageSchema = z
  .strictObject({
    t: z.literal('heartbeat'),
    leaseToken: LeaseTokenSchema,
    at: z.string(),
  })
  .meta({ id: 'WorkerHeartbeatMessage' });

export const StageResultMessageSchema = z
  .strictObject({
    t: z.literal('stage_result'),
    leaseToken: LeaseTokenSchema,
    roundId: z.number().int().nonnegative(),
    stageIndex: z.number().int().nonnegative(),
    verdictJson: z.string(),
  })
  .meta({ id: 'WorkerStageResultMessage' });

export const FatalMessageSchema = z
  .strictObject({
    t: z.literal('fatal'),
    leaseToken: LeaseTokenSchema,
    reason: z.string(),
  })
  .meta({ id: 'WorkerFatalMessage' });

export const WorkerToManagerMessageSchema = z
  .discriminatedUnion('t', [
    ReadyMessageSchema,
    HeartbeatMessageSchema,
    StageResultMessageSchema,
    FatalMessageSchema,
  ])
  .meta({ id: 'WorkerToManagerMessage' });

export type ReadyMessage = z.infer<typeof ReadyMessageSchema>;
export type HeartbeatMessage = z.infer<typeof HeartbeatMessageSchema>;
export type StageResultMessage = z.infer<typeof StageResultMessageSchema>;
export type FatalMessage = z.infer<typeof FatalMessageSchema>;
export type WorkerToManagerMessage = z.infer<
  typeof WorkerToManagerMessageSchema
>;

// ---------------------------------------------------------------------------
// Manager -> worker
// ---------------------------------------------------------------------------

export const AssignMessageSchema = z
  .strictObject({
    t: z.literal('assign'),
    featureId: z.string().min(1),
    leaseToken: LeaseTokenSchema,
    workspaceHandle: z.string(),
    effectiveConfigJson: z.string(),
    heartbeatIntervalMs: z.number().int().positive(),
    /** Absolute path to the repository ADL is running against — `WorkspaceSpec.mainRepo`. */
    mainRepo: z.string().min(1),
    /** The directory the backend may create the per-feature workspace under — `WorkspaceSpec.scratchRoot`. Must already exist. */
    scratchRoot: z.string().min(1),
    /** The commit-ish the feature's work branches from — `WorkspaceSpec.baseRef`. */
    baseRef: z.string().min(1),
    /** Constrained against the registry's own id list, not a free string — a typo is a validation failure here, not a registry miss inside a forked child. */
    workspaceBackendId: z.enum(WORKSPACE_BACKEND_IDS),
    /** The round this attempt belongs to (04-04 Task 2's `openAttempt`). */
    roundId: z.string().min(1),
    /** This stage attempt's own id — the join key the transcript path and usage events address through. */
    stageAttemptId: z.string().min(1),
    stageId: z.string().min(1),
    stageIndex: z.number().int().nonnegative(),
    /**
     * The directory transcripts live under — `logsRootFor(dbFilePath)`
     * (04-06), computed once by `daemon.ts` and threaded through so the
     * worker (which may not import `@adl/db` and therefore cannot see
     * `dbFilePath` itself) resolves the IDENTICAL root the manager's own
     * `GET /stages/:id/logs` route reads from. Required, like every other
     * workspace field on this message (D-04's "a worker that has to guess
     * is a process running somewhere nobody chose", T-4-14) — a worker
     * deriving its own guess from `scratchRoot`'s colocation is correct only
     * when `scratchRoot` happens to sit beside the database file, which is
     * the default but not a guarantee.
     */
    logsRoot: z.string().min(1),
  })
  .meta({ id: 'ManagerAssignMessage' });

export const SoftStopMessageSchema = z
  .strictObject({
    t: z.literal('soft_stop'),
    reason: z.string(),
  })
  .meta({ id: 'ManagerSoftStopMessage' });

export const LeaseLostMessageSchema = z
  .strictObject({
    t: z.literal('lease_lost'),
    featureId: z.string().min(1),
  })
  .meta({ id: 'ManagerLeaseLostMessage' });

export const ManagerToWorkerMessageSchema = z
  .discriminatedUnion('t', [
    AssignMessageSchema,
    SoftStopMessageSchema,
    LeaseLostMessageSchema,
  ])
  .meta({ id: 'ManagerToWorkerMessage' });

export type AssignMessage = z.infer<typeof AssignMessageSchema>;
export type SoftStopMessage = z.infer<typeof SoftStopMessageSchema>;
export type LeaseLostMessage = z.infer<typeof LeaseLostMessageSchema>;
export type ManagerToWorkerMessage = z.infer<
  typeof ManagerToWorkerMessageSchema
>;

// ---------------------------------------------------------------------------
// The combined discriminator list + compile-time exhaustiveness
// ---------------------------------------------------------------------------

type IpcMessageDiscriminator =
  WorkerToManagerMessage['t'] | ManagerToWorkerMessage['t'];

/**
 * Every discriminator in both unions, in declaration order. The acceptance
 * proof this phase requires — `soft_stop` in both the manager-to-worker
 * union and this list — is literal: it is one of the seven entries below.
 */
export const IPC_MESSAGE_KINDS = Object.freeze([
  'ready',
  'heartbeat',
  'stage_result',
  'fatal',
  'assign',
  'soft_stop',
  'lease_lost',
] as const) satisfies readonly IpcMessageDiscriminator[];

export type IpcMessageKind = (typeof IPC_MESSAGE_KINDS)[number];

/**
 * Compile-time exhaustiveness: a discriminator added to either union but
 * missing from {@link IPC_MESSAGE_KINDS} fails the **build**, mirroring
 * `feature-state.ts`'s `_EveryEventKindListed` pattern exactly.
 */
type _EveryIpcKindListed =
  Exclude<IpcMessageDiscriminator, IpcMessageKind> extends never ? true : never;
const _everyIpcKindListed: _EveryIpcKindListed = true;
void _everyIpcKindListed;

// ---------------------------------------------------------------------------
// Parsing — return, don't throw (mirrors InvalidTransition / compareAndSwapState)
// ---------------------------------------------------------------------------

/** Renders a Zod issue as `path: message`, or bare `message` at the root. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

export interface IpcParseFailure {
  readonly ok: false;
  readonly reason: string;
}

export interface WorkerMessageParseSuccess {
  readonly ok: true;
  readonly message: WorkerToManagerMessage;
}

/** The result of {@link parseWorkerMessage} — never thrown, always returned. */
export type WorkerMessageParseResult =
  WorkerMessageParseSuccess | IpcParseFailure;

export interface ManagerMessageParseSuccess {
  readonly ok: true;
  readonly message: ManagerToWorkerMessage;
}

/** The result of {@link parseManagerMessage} — never thrown, always returned. */
export type ManagerMessageParseResult =
  ManagerMessageParseSuccess | IpcParseFailure;

/**
 * Validate a worker->manager IPC payload.
 *
 * Never throws. An object with an unrecognised `t`, a lease-scoped kind
 * missing `leaseToken`, or a non-object payload all resolve to
 * `{ ok: false, reason }` rather than an exception — the supervisor treats an
 * unparseable message from a crashed or malicious worker as an infrastructure
 * failure, never trusted data (CORE-06's discipline, restated for this
 * boundary).
 */
export function parseWorkerMessage(raw: unknown): WorkerMessageParseResult {
  const result = WorkerToManagerMessageSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, reason: formatIssues(result.error) };
  }
  return { ok: true, message: result.data };
}

/** The manager->worker counterpart of {@link parseWorkerMessage}. */
export function parseManagerMessage(raw: unknown): ManagerMessageParseResult {
  const result = ManagerToWorkerMessageSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, reason: formatIssues(result.error) };
  }
  return { ok: true, message: result.data };
}
