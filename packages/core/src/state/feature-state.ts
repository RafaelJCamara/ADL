/**
 * The feature lifecycle vocabulary: the states, the events, and the shapes the
 * transition function consumes and returns.
 *
 * ===========================================================================
 * WHY THE GATE PIPELINE IS NOT IN THIS FILE
 * ===========================================================================
 *
 * `gating` is **one state, not N states**. The pipeline is an ordered list in
 * the effective configuration, and the position within it is
 * `features.current_stage_index` — data on a row, not a name in this union.
 *
 * That is the whole of EXEC-07. Adding a security harness adds a configuration
 * entry and a `stage_attempts` row. It does not add a state, does not need a
 * migration, does not need a redeploy, and cannot break a feature that is
 * already in flight. A state machine that has to change to accept a plugin
 * cannot accept a plugin from someone who is not able to deploy it, and
 * "harnesses are pluggable" would be a marketing claim rather than a property.
 *
 * The counter-argument — "but then the dashboard cannot show which gate is
 * running" — does not survive contact with the data model. The dashboard reads
 * `current_stage_index` against the pipeline plus the `stage_attempts` table,
 * which carries per-stage timing, cost, and verdict. That is strictly richer
 * than a state name would have been.
 *
 * ===========================================================================
 * THE THREE VERSIONING RULES (ARCHITECTURE.md §2)
 * ===========================================================================
 *
 * These are recorded here, next to the code that would break them, because
 * statechart migration of in-flight instances is a known unsolved problem and
 * ADL ships into databases it does not own.
 *
 * 1. **Never rename or delete a state.** Add new ones instead. A retired state
 *    gets a forward migration that maps it, run once at startup. Every name in
 *    `FEATURE_STATES` is already a literal value in `features.state` rows
 *    inside other people's installations, and in append-only `feature_events`
 *    rows that are evidence and are never rewritten.
 *
 * 2. **`meta.schema_version` gates startup.** The daemon refuses to run against
 *    a schema newer than itself, auto-migrates an older one, and takes a copy
 *    of the database file before migrating. Opening a newer schema
 *    optimistically is how one bad upgrade corrupts a team's history.
 *
 * 3. **The effective configuration — including the pipeline — is snapshotted
 *    into the feature row at lease time.** Editing `adl.yml` mid-flight must
 *    not change the pipeline of a running feature. The same holds for the
 *    spec: an edited spec creates a new feature revision, it does not mutate
 *    the running one.
 */

/**
 * Every state in the architecture's lifecycle diagram, in diagram order.
 *
 * Frozen, and the `FeatureState` type is derived from it, so the runtime list
 * and the compile-time union cannot drift apart. The test asserts the exact
 * contents so that a rename — the one edit this list must never receive — is a
 * visible diff rather than a silent change.
 */
export const FEATURE_STATES = Object.freeze([
  /** Spec parsed, config validated. Nothing has been leased. */
  'discovered',
  /** Waiting for a worker. Also where every recoverable interruption lands. */
  'queued',
  /** A worker holds the lease; workspace create/attach and `adl.yml` build. */
  'leased',
  /** The developer agent is working. */
  'developing',
  /** The pipeline is running. `current_stage_index` walks it. */
  'gating',
  /** Pushing the branch and opening the change request. */
  'publishing',
  /** Human territory. ADL only observes. */
  'pr_open',
  /** Terminal: the change request was merged. */
  'merged',
  /** A human is needed. Not terminal — a human retry returns it to the queue. */
  'escalated',
  /** Terminal: the change request was closed without merging. */
  'abandoned',
  /** A human parked it. Resume returns it to the queue. */
  'paused',
] as const);

export type FeatureState = (typeof FEATURE_STATES)[number];

/**
 * The states with no outgoing edges.
 *
 * `escalated` is deliberately **not** here: the diagram draws a human-retry
 * edge out of it, and a system whose only escape from escalation is a database
 * edit is a system whose users edit the database.
 */
export const TERMINAL_STATES = Object.freeze(['merged', 'abandoned'] as const);

export type TerminalState = (typeof TERMINAL_STATES)[number];

/** Narrowing guard: a terminal state accepts no event at all. */
export function isTerminal(state: FeatureState): state is TerminalState {
  return (TERMINAL_STATES as readonly FeatureState[]).includes(state);
}

/**
 * A reference to the change request the publishing step opened.
 *
 * Opaque to the lifecycle — it is recorded in the audit trail and never
 * inspected here. The forge adapter owns the authoritative shape; this is the
 * subset the state engine has to persist.
 */
export interface ChangeRequestRef {
  readonly forge: string;
  readonly number: number;
  readonly url: string;
}

/** Why a limit fired. Recorded on the escalation, so the reason survives. */
export type LimitReason =
  'round_limit' | 'budget_limit' | 'budget_limit_midstage';

/**
 * Every labelled edge in the architecture's diagram, as a discriminated union.
 *
 * Note what the gate-derived events carry: `stageId` is **opaque payload for
 * the audit record**. The transition function never branches on it, never
 * compares it, and never stores it in the lifecycle's own reasoning. That is
 * deliberate — the moment a stage id influences which state comes next, the
 * lifecycle knows what the gates are, and EXEC-07 is gone.
 */
export type FeatureEvent =
  /** `discovered → queued`. The spec parsed and the config is valid. */
  | { readonly t: 'admit' }
  /** `queued → leased`. A worker won the lease. */
  | { readonly t: 'lease_acquired'; readonly workerId: string }
  /** `leased → developing`. Workspace attached and the build succeeded. */
  | { readonly t: 'workspace_ready' }
  /** `developing → gating`. The developer agent committed on the branch. */
  | { readonly t: 'dev_committed'; readonly sha: string }
  /** `gating → gating`. One gate passed; the stage index advances. */
  | { readonly t: 'gate_passed'; readonly stageId: string }
  /** `gating → publishing`. The whole pipeline is satisfied. */
  | { readonly t: 'all_gates_passed' }
  /** `gating → developing`. The only edge that consumes a round. */
  | {
      readonly t: 'send_back';
      readonly stageId: string;
      readonly findingCount: number;
    }
  /** `publishing → pr_open`. */
  | { readonly t: 'cr_opened'; readonly ref: ChangeRequestRef }
  /** `pr_open → merged`. */
  | { readonly t: 'cr_merged' }
  /** `pr_open → abandoned`. */
  | { readonly t: 'cr_closed' }
  /** Back to `queued`. Covers lease expiry and worker crash alike. */
  | { readonly t: 'lease_expired' }
  /** Any non-terminal state → `escalated`. Round or budget ceiling hit. */
  | { readonly t: 'limit_exceeded'; readonly reason: LimitReason }
  /** Any non-terminal state → `paused`. A human parked it. */
  | { readonly t: 'pause'; readonly by: string }
  /** `paused → queued`, and the human-retry edge out of `escalated`. */
  | { readonly t: 'resume'; readonly by: string }
  /** Any non-terminal state → `escalated`. Nothing here can be retried. */
  | { readonly t: 'unrecoverable'; readonly reason: string };

/** The discriminator values of `FeatureEvent`, as runtime data. */
export const FEATURE_EVENT_KINDS = Object.freeze([
  'admit',
  'lease_acquired',
  'workspace_ready',
  'dev_committed',
  'gate_passed',
  'all_gates_passed',
  'send_back',
  'cr_opened',
  'cr_merged',
  'cr_closed',
  'lease_expired',
  'limit_exceeded',
  'pause',
  'resume',
  'unrecoverable',
] as const) satisfies readonly FeatureEvent['t'][];

export type FeatureEventKind = FeatureEvent['t'];

/**
 * Compile-time exhaustiveness: an event kind added to the union but missing
 * from `FEATURE_EVENT_KINDS` fails the **build**, not a test. Without this the
 * cross-product coverage assertion would silently stop covering it — the exact
 * failure mode the coverage count exists to prevent.
 */
type _EveryEventKindListed =
  Exclude<FeatureEventKind, (typeof FEATURE_EVENT_KINDS)[number]> extends never
    ? true
    : never;
const _everyEventKindListed: _EveryEventKindListed = true;
void _everyEventKindListed;

/**
 * Everything the transition function is allowed to know.
 *
 * The pipeline appears here as a **length and an index** and in no other form.
 * There is deliberately no stage id, stage name, or stage kind: a stage
 * identity in the transition context is the first step toward a stage-specific
 * state, and every property EXEC-07 claims rests on the lifecycle not knowing
 * what the stages are.
 *
 * `at` is a caller-supplied timestamp rather than a clock read. The function is
 * pure — it must return the same result for the same inputs whether it runs now
 * or during a replay of a crashed worker's decision.
 */
export interface TransitionCtx {
  /** The feature the audit record belongs to. */
  readonly featureId: string;
  /** `features.state_version` as read. The write must guard on exactly this. */
  readonly stateVersion: number;
  /** The highest `feature_events.seq` recorded; the effect carries `seq + 1`. */
  readonly lastEventSeq: number;
  /** `features.round` as read. */
  readonly round: number;
  /** The configured round ceiling. The admission check compares against it. */
  readonly maxRounds: number;
  /** How many stages the snapshotted pipeline has. Never which ones. */
  readonly pipelineLength: number;
  /** `features.current_stage_index` as read. */
  readonly currentStageIndex: number;
  /** Who or what caused the event. Recorded on the audit row. */
  readonly actor: string;
  /** ISO-8601, supplied by the caller. This module never reads a clock. */
  readonly at: string;
}

/**
 * The field names of `TransitionCtx`, as runtime data, so a test can assert
 * that no stage identity ever appears here.
 *
 * Paired with the compile-time exhaustiveness assertion below: adding
 * `stageId` to `TransitionCtx` fails the build until it is listed here, and
 * listing it turns the "carries no stage identity" test red. The guard is
 * therefore structural rather than a convention someone has to remember.
 */
export const TRANSITION_CTX_FIELDS = Object.freeze([
  'featureId',
  'stateVersion',
  'lastEventSeq',
  'round',
  'maxRounds',
  'pipelineLength',
  'currentStageIndex',
  'actor',
  'at',
] as const) satisfies readonly (keyof TransitionCtx)[];

type _EveryCtxFieldListed =
  Exclude<
    keyof TransitionCtx,
    (typeof TRANSITION_CTX_FIELDS)[number]
  > extends never
    ? true
    : never;
const _everyCtxFieldListed: _EveryCtxFieldListed = true;
void _everyCtxFieldListed;

/**
 * The append-only audit record a transition emits.
 *
 * It is returned rather than written because this module performs no I/O — but
 * returning it is what makes the audit trail free and, more importantly, hard
 * to forget: the caller receives the row it must write **in the same
 * transaction** as the state change. A state change with no audit record is
 * repudiable, and the dashboard timeline, the pull-request rollup, and every
 * post-mortem are a `SELECT` only if this row always exists.
 *
 * `id` is absent on purpose: minting one requires randomness and a clock, and
 * this module has neither. The caller mints it.
 */
export interface FeatureEventEffect {
  readonly kind: 'feature_event';
  readonly featureId: string;
  readonly seq: number;
  readonly fromState: FeatureState;
  readonly toState: FeatureState;
  readonly event: FeatureEvent;
  readonly actor: string;
  readonly at: string;
}

/**
 * What the caller must write alongside the state change.
 *
 * A one-member union today. Later phases add outbox entries here rather than
 * inventing a second return channel.
 */
export type TransitionEffect = FeatureEventEffect;

/**
 * Counter movements, expressed as deltas the caller applies to the row it read.
 *
 * Deltas rather than absolute values because the caller is issuing a
 * version-guarded `UPDATE` against the row it already read; a delta composes
 * with that read, an absolute value silently discards anything that changed.
 */
export interface CounterDeltas {
  readonly round: number;
  readonly currentStageIndex: number;
}

/** An applied transition, and everything the caller must persist with it. */
export interface TransitionResult {
  readonly ok: true;
  readonly from: FeatureState;
  readonly next: FeatureState;
  readonly effects: readonly TransitionEffect[];
  readonly counters: CounterDeltas;
  /**
   * The optimistic-concurrency expectation:
   * `UPDATE features SET ... WHERE id = ? AND state_version = expectedStateVersion`.
   *
   * It is part of the return value so a state write cannot be issued without
   * its guard. Zero rows updated means someone else moved the feature — reload
   * and re-decide, never overwrite.
   */
  readonly expectedStateVersion: number;
}

/**
 * A state-and-event pair with no edge between them.
 *
 * Returned, never thrown. Whether an undrawn pair is a bug or a benign race —
 * a resumed worker reporting an event the manager already applied — is the
 * caller's call to make, and an exception forecloses it.
 */
export interface InvalidTransition {
  readonly ok: false;
  readonly state: FeatureState;
  readonly event: FeatureEvent;
  readonly reason: string;
}

/** The total return type: every pair yields one of these, and never throws. */
export type TransitionOutcome = TransitionResult | InvalidTransition;
