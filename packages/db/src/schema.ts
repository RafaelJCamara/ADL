/**
 * The Kysely `Database` interface, **hand-written** to match the migrations
 * under `migrations/` exactly.
 *
 * Hand-writing rather than generating is deliberate. `kysely-codegen` needs a
 * migrated live database, which makes it a build-step-plus-temp-file dance for
 * a schema this small. The known cost of hand-writing is silent drift, and
 * `test/schema-drift.test.ts` pays it off: it migrates a temp database,
 * introspects the catalogue, and compares tables and columns against
 * {@link TABLE_COLUMNS} **in both directions**. A migration that adds a column
 * without updating this file fails there, naming the column — rather than
 * surfacing as `no such column` in an adopter's installation.
 *
 * Timestamps are ISO-8601 strings rather than SQLite's numeric time: they sort
 * correctly as text, they are readable in `sqlite3 .adl/adl.db`, and they carry
 * their timezone.
 *
 * Column types are deliberately widened to `string` rather than narrowed to the
 * union the `check` constraint enforces. The database is the enforcement point
 * for the stored vocabulary; the *contract* vocabulary lives in `@adl/core`'s
 * Zod schemas, and duplicating it as a TypeScript union here would give two
 * definitions that can disagree (D-28 — `@adl/core` never learns a database
 * exists, and `@adl/db` never becomes a second source of truth for the
 * contracts).
 */

import { CHECKSUM_TABLE } from './checksum.js';

/** `meta` — single key/value row set. `schema_version` gates daemon startup. */
export interface MetaTable {
  key: string;
  value: string;
  updated_at: string;
}

/** `repos` — one row per repository ADL watches. */
export interface ReposTable {
  id: string;
  remote_url: string;
  default_branch: string;
  forge: string;
  features_dir: string;
  created_at: string;
  updated_at: string;
}

/**
 * `features` — one row per feature folder ADL has seen.
 *
 * The lease columns (`lease_owner`, `lease_token`, `lease_expires_at`,
 * `heartbeat_at`) are the queue: the manager is the only writer, so a lease
 * table in SQLite does the job Redis would otherwise be dragged in for.
 */
export interface FeaturesTable {
  id: string;
  repo_id: string;
  path: string;
  state: string;
  state_version: number;
  round: number;
  current_stage_index: number;
  spec_hash: string;
  effective_config_json: string | null;
  workspace_handle: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  crash_count: number;
  created_at: string;
  updated_at: string;
}

/** `feature_events` — append-only state-transition log, ordered by `seq`. */
export interface FeatureEventsTable {
  id: string;
  feature_id: string;
  seq: number;
  from_state: string | null;
  to_state: string;
  event_json: string;
  actor: string;
  at: string;
}

/** `rounds` — one row per round of the develop→gate loop. */
export interface RoundsTable {
  id: string;
  feature_id: string;
  /** 1-based ordinal within the feature. */
  number: number;
  /** The `RoundOutcome` kind, or null while the round is still running. */
  outcome: string | null;
  /** The full `RoundOutcome` payload — the brief, the reason, the inconclusives. */
  outcome_json: string | null;
  /**
   * The commit the developer produced in this round (M05 step 5.14,
   * `0005_rounds_head_sha.ts`).
   *
   * Null for three ordinary reasons — the round is still running, its
   * developer reported `blocked` and made no commit, or it predates the
   * migration — which is why it is nullable rather than defaulted. Not part of
   * `outcome_json`: that column holds a `RoundOutcome`, which is a statement
   * about verdicts and has no field for a commit.
   */
  head_sha: string | null;
  started_at: string;
  ended_at: string | null;
}

/**
 * `stage_attempts` — one row per attempt at one pipeline position.
 *
 * `stage_index` is EXEC-07's mechanism as data: adding a harness moves a list
 * index rather than adding a lifecycle state. The `error_*` columns hold a
 * `StageError` (D-12); `error_raw_ref` is an artifact pointer, never the blob.
 */
export interface StageAttemptsTable {
  id: string;
  round_id: string;
  stage_id: string;
  stage_index: number;
  /** D-13's single repair reprompt is a second attempt, visible in history. */
  attempt: number;
  status: string;
  error_kind: string | null;
  /** 0 or 1 — SQLite has no boolean. Null when the attempt did not error. */
  error_retryable: number | null;
  error_raw_ref: string | null;
  started_at: string;
  ended_at: string | null;
}

/**
 * `verdicts` — one row per verdict, at most one per stage attempt.
 *
 * A table rather than a JSON column, because the coverage table and the cited-
 * criteria list are both queries, and a blob makes each of them a scan.
 */
export interface VerdictsTable {
  id: string;
  stage_attempt_id: string;
  outcome: string;
  /** Null for `skip`, which carries only a reason. */
  summary: string | null;
  /** Null for `pass`, `send_back`, and `warn`, which carry only a summary. */
  reason: string | null;
  waiver_id: string | null;
  created_at: string;
}

/** `verdict_checked_criteria` — a `pass` verdict's cited coverage, in order. */
export interface VerdictCheckedCriteriaTable {
  id: string;
  verdict_id: string;
  position: number;
  ref_kind: string;
  criterion_id: string | null;
  global_category: string | null;
}

/**
 * `findings` — one thing a gate found wrong.
 *
 * `criterion_ref_kind` plus its payload columns is `CriterionRef` flattened
 * (D-03): required, never absent. `path` is workspace-relative and nothing
 * else — it is persisted and then rendered into a public pull-request comment
 * (T-1-36).
 */
export interface FindingsTable {
  id: string;
  verdict_id: string;
  /** sha256 hex — LOOP-06's stall-detection key. */
  fingerprint: string;
  severity: string;
  title: string;
  detail: string;
  criterion_ref_kind: string;
  criterion_id: string | null;
  global_category: string | null;
  path: string | null;
  line: number | null;
  end_line: number | null;
  suggested_action: string | null;
  created_at: string;
}

/** `waivers` — a human's recorded acceptance that a gate was not satisfied (D-07). */
export interface WaiversTable {
  id: string;
  feature_id: string;
  target_kind: string;
  target_criterion_id: string | null;
  target_global_category: string | null;
  target_stage_id: string | null;
  reason: string;
  actor: string;
  /** ISO-8601 instant the waiver was granted. */
  at: string;
}

/**
 * `usage_events` — the spend ledger.
 *
 * Four separately-priced token counters, each **nullable with no default**: a
 * backend that does not report cache tokens must stay distinguishable from one
 * reporting zero, and that distinction cannot be recovered later if it is
 * destroyed at write time (Pitfall 6).
 *
 * `cost_usd` is nullable because an unpriceable model records no cost, never
 * zero (D-31).
 */
export interface UsageEventsTable {
  id: string;
  feature_id: string;
  round_id: string | null;
  stage_attempt_id: string | null;
  model_id: string;
  speed: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cost_usd: number | null;
  cost_source: string;
  cost_category: string;
  at: string;
}

/**
 * `model_prices` — versioned prices with an effective-from date (C-14, D-31).
 *
 * A correction is a new row with a later `effective_from`, never an edit: an
 * edited price silently rewrites historical spend, and an edit to the seed
 * migration is refused outright by the checksum guard.
 */
export interface ModelPricesTable {
  id: string;
  model_id: string;
  speed: string;
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  cache_write_multiplier: number;
  cache_read_multiplier: number;
  /** ISO-8601 date (`YYYY-MM-DD`). Text-comparable against a timestamp prefix. */
  effective_from: string;
}

export interface Database {
  meta: MetaTable;
  repos: ReposTable;
  features: FeaturesTable;
  feature_events: FeatureEventsTable;
  rounds: RoundsTable;
  stage_attempts: StageAttemptsTable;
  waivers: WaiversTable;
  verdicts: VerdictsTable;
  verdict_checked_criteria: VerdictCheckedCriteriaTable;
  findings: FindingsTable;
  usage_events: UsageEventsTable;
  model_prices: ModelPricesTable;
}

/**
 * The `features` column names, at runtime.
 *
 * This exists so a test can compare the hand-written interface against what
 * `PRAGMA table_info` actually reports — types are erased at runtime, so
 * without a value there is nothing to compare. The `satisfies` clause plus the
 * exhaustiveness assertion below make the pair self-policing in both
 * directions: a column added to `FeaturesTable` but not here fails to compile,
 * and a name here that is not on `FeaturesTable` fails to compile too.
 */
export const FEATURES_COLUMNS = [
  'id',
  'repo_id',
  'path',
  'state',
  'state_version',
  'round',
  'current_stage_index',
  'spec_hash',
  'effective_config_json',
  'workspace_handle',
  'lease_owner',
  'lease_token',
  'lease_expires_at',
  'heartbeat_at',
  'crash_count',
  'created_at',
  'updated_at',
] as const satisfies readonly (keyof FeaturesTable)[];

/** Compile-time proof that {@link FEATURES_COLUMNS} omits no column. */
type MissingFeatureColumns = Exclude<
  keyof FeaturesTable,
  (typeof FEATURES_COLUMNS)[number]
>;
const _featuresColumnsAreExhaustive: MissingFeatureColumns extends never
  ? true
  : never = true;
void _featuresColumnsAreExhaustive;

/** The tables `0001_initial.ts` creates, for the migration smoke test. */
export const INITIAL_TABLES = [
  'meta',
  'repos',
  'features',
  'feature_events',
] as const satisfies readonly (keyof Database)[];

/**
 * Every column of every table, at runtime.
 *
 * Types are erased at runtime, so without a value there is nothing to compare
 * against `pragma table_info`. This map is that value, and it is self-policing
 * in both directions at **compile** time before the drift test even runs:
 *
 * - the `satisfies` clause requires every key to be a real table and every
 *   string to be a real column of that table;
 * - the mapped-type check below fails to compile if any table omits a column.
 *
 * The drift test then closes the third direction — this map against the live
 * database — which is the one TypeScript cannot see.
 */
export const TABLE_COLUMNS = {
  meta: ['key', 'value', 'updated_at'],
  repos: [
    'id',
    'remote_url',
    'default_branch',
    'forge',
    'features_dir',
    'created_at',
    'updated_at',
  ],
  features: [
    'id',
    'repo_id',
    'path',
    'state',
    'state_version',
    'round',
    'current_stage_index',
    'spec_hash',
    'effective_config_json',
    'workspace_handle',
    'lease_owner',
    'lease_token',
    'lease_expires_at',
    'heartbeat_at',
    'crash_count',
    'created_at',
    'updated_at',
  ],
  feature_events: [
    'id',
    'feature_id',
    'seq',
    'from_state',
    'to_state',
    'event_json',
    'actor',
    'at',
  ],
  rounds: [
    'id',
    'feature_id',
    'number',
    'outcome',
    'outcome_json',
    'head_sha',
    'started_at',
    'ended_at',
  ],
  stage_attempts: [
    'id',
    'round_id',
    'stage_id',
    'stage_index',
    'attempt',
    'status',
    'error_kind',
    'error_retryable',
    'error_raw_ref',
    'started_at',
    'ended_at',
  ],
  waivers: [
    'id',
    'feature_id',
    'target_kind',
    'target_criterion_id',
    'target_global_category',
    'target_stage_id',
    'reason',
    'actor',
    'at',
  ],
  verdicts: [
    'id',
    'stage_attempt_id',
    'outcome',
    'summary',
    'reason',
    'waiver_id',
    'created_at',
  ],
  verdict_checked_criteria: [
    'id',
    'verdict_id',
    'position',
    'ref_kind',
    'criterion_id',
    'global_category',
  ],
  findings: [
    'id',
    'verdict_id',
    'fingerprint',
    'severity',
    'title',
    'detail',
    'criterion_ref_kind',
    'criterion_id',
    'global_category',
    'path',
    'line',
    'end_line',
    'suggested_action',
    'created_at',
  ],
  usage_events: [
    'id',
    'feature_id',
    'round_id',
    'stage_attempt_id',
    'model_id',
    'speed',
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'cost_usd',
    'cost_source',
    'cost_category',
    'at',
  ],
  model_prices: [
    'id',
    'model_id',
    'speed',
    'input_usd_per_mtok',
    'output_usd_per_mtok',
    'cache_write_multiplier',
    'cache_read_multiplier',
    'effective_from',
  ],
} as const satisfies {
  [K in keyof Database]: readonly (keyof Database[K] & string)[];
};

/** Compile-time proof that {@link TABLE_COLUMNS} omits no column of any table. */
type MissingColumns = {
  [K in keyof Database]: Exclude<
    keyof Database[K],
    (typeof TABLE_COLUMNS)[K][number]
  >;
}[keyof Database];
const _tableColumnsAreExhaustive: [MissingColumns] extends [never]
  ? true
  : never = true;
void _tableColumnsAreExhaustive;

/**
 * The domain tables Phases 1 through 5 need.
 *
 * `verdict_checked_criteria` is not listed: it is a child of `verdicts` rather
 * than a subject in its own right. {@link TABLE_COLUMNS} is the complete set.
 */
export const PHASE_TABLES = [
  'meta',
  'repos',
  'features',
  'feature_events',
  'rounds',
  'stage_attempts',
  'verdicts',
  'findings',
  'waivers',
  'usage_events',
  'model_prices',
] as const satisfies readonly (keyof Database)[];

/**
 * Tables that deliberately do **not** exist yet.
 *
 * D-29: the outbox, forge-event dedupe, and artifact tables arrive with the
 * phases that use them. Asserting their absence is what keeps "not built yet"
 * distinguishable from "forgotten" in a schema read six months from now.
 */
export const DEFERRED_TABLES = ['outbox', 'forge_events', 'artifacts'] as const;

/**
 * Migration-mechanics tables, excluded from the drift check and from the
 * "exactly these tables" assertion in `migrate.test.ts`.
 *
 * `kysely_migration` and `kysely_migration_lock` are Kysely's own, created
 * and owned by the library, which could change their shape under a version
 * bump — precisely why D-30's checksum guard builds `adl_migration_checksums`
 * as its own table rather than adding a column to Kysely's.
 *
 * `adl_migration_checksums` is ADL's, but it is migration infrastructure, not
 * domain schema: `checksum.ts` reads and writes it with raw `sql` rather than
 * through the `Database` interface, deliberately, so the checksum guard's
 * shape can evolve without touching the hand-written contract every other
 * table is held to. It belongs in this list for the same reason Kysely's own
 * tables do — none of these three is what the drift check exists to police.
 */
export const BOOKKEEPING_TABLES: readonly string[] = [
  'kysely_migration',
  'kysely_migration_lock',
  CHECKSUM_TABLE,
];
