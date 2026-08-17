export { createDb, migrateToLatest, type MigrateResult } from './migrator.js';

export {
  type Database,
  type MetaTable,
  type ReposTable,
  type FeaturesTable,
  type FeatureEventsTable,
  FEATURES_COLUMNS,
  INITIAL_TABLES,
} from './schema.js';
