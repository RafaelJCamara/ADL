/**
 * The repository layer — the only surface `@adl/db` offers to a caller.
 *
 * Everything above this line is Kysely, `better-sqlite3`, and SQL. Everything
 * below it is a named operation. That boundary is D-28's whole purpose: the
 * eventual swap to `node:sqlite` or Postgres is contained to this package, and
 * the manager never holds a query builder it could quietly grow a schema
 * assumption inside.
 */

export {
  featuresRepository,
  type FeaturesRepository,
  type NewFeature,
  type NewFeatureEvent,
  type NewRound,
  type AcquireLeaseInput,
  type RenewLeaseInput,
  type ExpireLeaseInput,
  type ReleaseLeaseInput,
} from './features.js';

export {
  verdictsRepository,
  type VerdictsRepository,
  type CoverageRow,
  type NewStageAttempt,
  type NewVerdict,
  type NewCheckedCriterion,
  type NewFinding,
  type NewWaiver,
} from './verdicts.js';

export {
  usageRepository,
  type UsageRepository,
  type NewUsageEvent,
  type SpendByCategory,
} from './usage.js';

export {
  reposRepository,
  type ReposRepository,
  type NewRepo,
} from './repos.js';

export {
  metaRepository,
  type MetaRepository,
  type SchemaVersionResult,
  type GlobalPauseResult,
  SCHEMA_VERSION_KEY,
  GLOBAL_PAUSE_KEY,
} from './meta.js';
