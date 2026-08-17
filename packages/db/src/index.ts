export { createDb, migrateToLatest, type MigrateResult } from './migrator.js';

export {
  type Database,
  type MetaTable,
  type ReposTable,
  type FeaturesTable,
  type FeatureEventsTable,
  type RoundsTable,
  type StageAttemptsTable,
  type VerdictsTable,
  type VerdictCheckedCriteriaTable,
  type FindingsTable,
  type WaiversTable,
  type UsageEventsTable,
  type ModelPricesTable,
  FEATURES_COLUMNS,
  INITIAL_TABLES,
  TABLE_COLUMNS,
  PHASE_TABLES,
  DEFERRED_TABLES,
  BOOKKEEPING_TABLES,
} from './schema.js';

export * from './repository/index.js';
