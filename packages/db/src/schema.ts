/**
 * The Kysely `Database` interface, **hand-written** to match
 * `migrations/0001_initial.ts` exactly.
 *
 * Hand-writing rather than generating is deliberate. `kysely-codegen` needs a
 * migrated live database, which makes it a build-step-plus-temp-file dance for
 * a schema this small and this freshly authored. The known cost of hand-writing
 * is silent drift, and plan 01-10 pays it off with a CI check that runs the
 * generator against a temp database and fails on any diff — so the interface
 * stays honest without the generator being in the runtime path.
 *
 * Timestamps are ISO-8601 strings rather than SQLite's numeric time: they sort
 * correctly as text, they are readable in `sqlite3 .adl/adl.db`, and they carry
 * their timezone.
 */

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

export interface Database {
  meta: MetaTable;
  repos: ReposTable;
  features: FeaturesTable;
  feature_events: FeatureEventsTable;
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
type MissingFeatureColumns = Exclude<keyof FeaturesTable, (typeof FEATURES_COLUMNS)[number]>;
const _featuresColumnsAreExhaustive: MissingFeatureColumns extends never ? true : never = true;
void _featuresColumnsAreExhaustive;

/** The tables `0001_initial.ts` creates, for the migration smoke test. */
export const INITIAL_TABLES = [
  'meta',
  'repos',
  'features',
  'feature_events',
] as const satisfies readonly (keyof Database)[];
