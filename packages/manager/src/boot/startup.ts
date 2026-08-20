import { readdirSync } from 'node:fs';
import { copyFile as copyFileDefault } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  metaRepository,
  migrateToLatest,
  nowIso,
  reposRepository,
  type Database,
} from '@adl/db';
import type { WatchedRepo } from '@adl/core/config';
import { sql, type Kysely } from 'kysely';
import type { Logger } from 'pino';

/**
 * The startup gate — `feature-state.ts`'s versioning rule 2, in full: refuse
 * a schema newer than the daemon, copy the database file before
 * auto-migrating an older or unseeded one, then reconcile watched
 * repositories (D-35). Order is fixed by D-37: schema gate, then
 * copy-and-migrate, then repo reconciliation — lease expiry and the boot
 * orphan kill (D-13) follow in `daemon.ts`, in `./orphans.ts`.
 *
 * ## Where `DAEMON_SCHEMA_VERSION` comes from (Task 1's checkpoint, option-a)
 *
 * The human maintainer selected option-a: the daemon's expected schema
 * version is **derived from the migrations directory** — the highest
 * applied migration name in `packages/db/migrations/` — never a
 * hand-maintained constant in this package's source. A constant can drift
 * from the migrations directory the moment someone adds a migration and
 * forgets to bump it, which is exactly the failure D-37 exists to prevent.
 *
 * `resolveMigrationsDir()` locates `@adl/db`'s shipped `migrations/`
 * directory via `import.meta.resolve('@adl/db')` — the package's own `"."`
 * export — rather than a monorepo-relative path, so the computation stays
 * correct whether `@adl/manager` is consumed from a sibling workspace
 * package (this repo) or as an ordinary npm dependency (an adopter's
 * install). Verified empirically (both under plain Node and under Vitest)
 * to resolve `packages/db/dist/migrations` — the compiled migrations this
 * package's own dependency graph actually ships.
 */
function resolveMigrationsDir(): string {
  const dbEntry = import.meta.resolve('@adl/db');
  return fileURLToPath(new URL('../migrations', dbEntry));
}

/** A migration file's leading numeric prefix, e.g. `0004` from `0004_feature_state_constraint.ts`. */
const MIGRATION_NAME_PATTERN = /^(\d+)_/;

function deriveSchemaVersion(migrationsDir: string): number {
  const names = readdirSync(migrationsDir)
    .filter((file) => !file.endsWith('.d.ts') && /\.(ts|js|mjs)$/.test(file))
    .filter((file) => !file.endsWith('.map'))
    .map((file) => file.replace(/\.(ts|js|mjs)$/, ''));

  let highest = -1;
  for (const name of names) {
    const match = MIGRATION_NAME_PATTERN.exec(name);
    if (match?.[1] === undefined) continue;
    const n = Number(match[1]);
    if (n > highest) highest = n;
  }

  if (highest < 0) {
    throw new Error(
      `no migrations found under ${migrationsDir} — cannot derive DAEMON_SCHEMA_VERSION`,
    );
  }
  return highest;
}

/**
 * The daemon's own schema version — derived once, at module load, from
 * `@adl/db`'s shipped migrations directory. This is the number every
 * `runStartupGate` call compares a database's stored `schema_version`
 * against; it cannot drift from the code because it is not written by hand.
 */
export const DAEMON_SCHEMA_VERSION: number = deriveSchemaVersion(
  resolveMigrationsDir(),
);

export { resolveMigrationsDir };

// ---------------------------------------------------------------------------
// The refusal shape
// ---------------------------------------------------------------------------

/**
 * Why `runStartupGate` refused to run. Three reasons, all one-way-safe: the
 * daemon writes nothing to the database in any of them.
 */
export type SchemaVersionRefusal =
  | {
      readonly reason: 'newer-schema';
      readonly storedVersion: number;
      readonly daemonVersion: number;
      readonly message: string;
    }
  | {
      readonly reason: 'invalid-schema-version';
      readonly rawValue: string;
      readonly daemonVersion: number;
      readonly message: string;
    }
  | {
      readonly reason: 'copy-failed';
      readonly daemonVersion: number;
      readonly message: string;
    }
  | {
      readonly reason: 'migration-failed';
      readonly daemonVersion: number;
      readonly message: string;
    };

export interface StartupGateProceeded {
  readonly kind: 'proceeded';
  /** Present when this call took a pre-migration copy (an older-or-absent stored version). */
  readonly copyPath?: string;
}

export interface StartupGateRefused {
  readonly kind: 'refused';
  readonly refusal: SchemaVersionRefusal;
}

export type StartupGateResult = StartupGateProceeded | StartupGateRefused;

/** Thrown by a caller (`daemon.ts`) that wants the refusal to be exceptional — the API server must never bind after this. */
export class SchemaVersionRefusalError extends Error {
  readonly refusal: SchemaVersionRefusal;

  constructor(refusal: SchemaVersionRefusal) {
    super(refusal.message);
    this.name = 'SchemaVersionRefusalError';
    this.refusal = refusal;
  }
}

export interface StartupGateDeps {
  readonly db: Kysely<Database>;
  /** The database's own file path, so the pre-migration copy can be taken beside it. */
  readonly dbFilePath: string;
  /** The migrations directory `migrateToLatest` applies — required, never defaulted here (a caller states it explicitly, matching `resolveAdlYml`'s own injected-dependency shape). */
  readonly migrationsDir: string;
  readonly logger: Logger;
  readonly now?: () => string;
  /** Injectable so a test can force the copy step to fail deterministically (an unwritable destination) without depending on platform-specific filesystem permissions. Defaults to `node:fs/promises`' `copyFile`. */
  readonly copyFile?: (src: string, dest: string) => Promise<void>;
}

/**
 * Checkpoint the WAL, then copy the database file beside itself as
 * `<path>.pre-<version>-<timestamp>`. Checkpointing first is a correctness
 * requirement, not an optimisation: `03-02` put every connection in WAL
 * journal mode, so a copy taken without checkpointing first could miss
 * committed pages still held in the `-wal` sidecar, making the "recoverable
 * snapshot" claim false. No config key names the destination — it is always
 * beside the database, per Task 1's locked decision.
 *
 * `PASSIVE` mode, not `TRUNCATE`: `TRUNCATE`/`RESTART` checkpoints require
 * (and block on) an exclusive lock across every connection to the file —
 * `better-sqlite3`'s calls are synchronous, so a second connection holding
 * even a passing lock during that wait can stall the checkpoint well past
 * `busy_timeout` on some platforms (verified empirically against a
 * concurrent-connection test scenario). `PASSIVE` checkpoints as many
 * frames as it can without blocking, which is sufficient here: the daemon's
 * own database handle is normally the only writer at startup, so a passive
 * checkpoint flushes everything pending in the common case, and it can
 * never hang the boot sequence.
 */
async function takePreMigrationCopy(
  db: Kysely<Database>,
  dbFilePath: string,
  version: number,
  copyFn: (src: string, dest: string) => Promise<void>,
): Promise<string> {
  await sql`PRAGMA wal_checkpoint(PASSIVE)`.execute(db);
  const copyPath = `${dbFilePath}.pre-${version}-${Date.now()}`;
  await copyFn(dbFilePath, copyPath);
  return copyPath;
}

/**
 * Refuse a schema newer than this daemon, copy-then-migrate an older or
 * unseeded one, and no-op against an already-current database.
 *
 * Reads `meta.schema_version` first, before any other database access
 * (`03-02`'s `metaRepository.getSchemaVersion` — a discriminated
 * `{kind: 'absent'|'valid'|'invalid'}` result, used here rather than coerced
 * to a bare number so a corrupt stored value can never compare as `NaN` and
 * silently let the gate through).
 *
 * **Copies are kept forever** — Task 1's locked decision. This function
 * contains no delete path, and never will: the daemon startup sequence must
 * contain no destructive operations, so every prior upgrade stays
 * recoverable. Disk accumulation from old copies is a real, deliberately
 * unaddressed cost — see `packages/manager/README.md` for the note to
 * operators, and the SUMMARY for this plan's own "future consideration".
 */
export async function runStartupGate(
  deps: StartupGateDeps,
): Promise<StartupGateResult> {
  const meta = metaRepository(deps.db);
  const versionResult = await meta.getSchemaVersion();
  const now = (deps.now ?? nowIso)();

  if (versionResult.kind === 'invalid') {
    const refusal: SchemaVersionRefusal = {
      reason: 'invalid-schema-version',
      rawValue: versionResult.rawValue,
      daemonVersion: DAEMON_SCHEMA_VERSION,
      message:
        `stored schema_version "${versionResult.rawValue}" is not an integer; ` +
        'refusing to run rather than coercing it.',
    };
    deps.logger.error(refusal, 'startup gate: refusing to run');
    return { kind: 'refused', refusal };
  }

  if (
    versionResult.kind === 'valid' &&
    versionResult.version > DAEMON_SCHEMA_VERSION
  ) {
    const refusal: SchemaVersionRefusal = {
      reason: 'newer-schema',
      storedVersion: versionResult.version,
      daemonVersion: DAEMON_SCHEMA_VERSION,
      message:
        `the database's schema_version (${versionResult.version}) is newer than this ` +
        `daemon's (${DAEMON_SCHEMA_VERSION}); refusing to run. Upgrade the daemon before ` +
        'pointing it at this database.',
    };
    deps.logger.error(refusal, 'startup gate: refusing to run');
    return { kind: 'refused', refusal };
  }

  const isCurrent =
    versionResult.kind === 'valid' &&
    versionResult.version === DAEMON_SCHEMA_VERSION;
  if (isCurrent) {
    // Already current: a no-op that writes no new copy (re-running the gate
    // against an already-current database).
    return { kind: 'proceeded' };
  }

  // `absent` (a fresh, migrated-but-unseeded database) or `valid` and older:
  // take the copy before the first migration statement runs.
  let copyPath: string;
  try {
    copyPath = await takePreMigrationCopy(
      deps.db,
      deps.dbFilePath,
      DAEMON_SCHEMA_VERSION,
      deps.copyFile ?? copyFileDefault,
    );
  } catch (error) {
    const refusal: SchemaVersionRefusal = {
      reason: 'copy-failed',
      daemonVersion: DAEMON_SCHEMA_VERSION,
      message: `could not write the pre-migration copy: ${
        error instanceof Error ? error.message : String(error)
      }. Refusing to migrate without a recoverable copy.`,
    };
    deps.logger.error(refusal, 'startup gate: refusing to run');
    return { kind: 'refused', refusal };
  }

  const migrateResult = await migrateToLatest(deps.db, deps.migrationsDir);
  if (migrateResult.error !== undefined) {
    const refusal: SchemaVersionRefusal = {
      reason: 'migration-failed',
      daemonVersion: DAEMON_SCHEMA_VERSION,
      message: `migration failed: ${
        migrateResult.error instanceof Error
          ? migrateResult.error.message
          : String(migrateResult.error)
      }`,
    };
    deps.logger.error(
      { ...refusal, results: migrateResult.results, copyPath },
      'startup gate: migration failed — the pre-migration copy is the recovery path',
    );
    return { kind: 'refused', refusal };
  }

  await meta.setSchemaVersion(DAEMON_SCHEMA_VERSION, now);
  deps.logger.info(
    { copyPath, schemaVersion: DAEMON_SCHEMA_VERSION },
    'startup gate: migrated and seeded schema_version',
  );
  return { kind: 'proceeded', copyPath };
}

// ---------------------------------------------------------------------------
// Repository reconciliation (D-35)
// ---------------------------------------------------------------------------

export interface ReconcileReposDeps {
  readonly db: Kysely<Database>;
  readonly repos: readonly WatchedRepo[];
  readonly logger: Logger;
  readonly now?: () => string;
}

/**
 * Upsert every configured repository into the `repos` table. A row present
 * in the table but absent from the config is **left in place** and logged
 * at `info` — features may still reference it, and a config edit is not a
 * delete instruction (D-35, T-3-32).
 */
export async function reconcileRepos(deps: ReconcileReposDeps): Promise<void> {
  const repos = reposRepository(deps.db);
  const now = (deps.now ?? nowIso)();
  const configuredIds = new Set(deps.repos.map((repo) => repo.id));

  for (const repo of deps.repos) {
    await repos.upsert({
      id: repo.id,
      remote_url: repo.remote_url,
      default_branch: repo.default_branch,
      forge: repo.forge,
      features_dir: repo.features_dir,
      created_at: now,
      updated_at: now,
    });
  }

  const existing = await repos.list();
  for (const row of existing) {
    if (!configuredIds.has(row.id)) {
      deps.logger.info(
        { repoId: row.id },
        'repository present in the repos table but absent from the daemon config — left in place, not deleted',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Global pause restore (G-03-3)
// ---------------------------------------------------------------------------

export interface RestoreGlobalPauseDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

/**
 * Read the persisted `global_pause` flag and resolve it into the boolean
 * `daemon.ts` seeds `createControlState`'s `initialGlobalPause` with.
 * Placed after {@link reconcileRepos}, matching its deps and export shape —
 * both run after the schema gate, so the `meta` table is guaranteed
 * migrated, and both run before the API binds or the first dispatch tick.
 *
 * Reads only: this function never writes the row back (G-03-3 design
 * decision 4). Writing on every boot would reset `updated_at` and destroy
 * the only evidence of when the pause was actually set.
 *
 * - `absent` — every database written before this change — resolves to
 *   `false` with no operator noise; nothing changes for an install that has
 *   never paused.
 * - `valid` resolves to its stored boolean, logged at `warn` when the
 *   answer is `true`: a daemon that boots into a persisted pause and says
 *   nothing is indistinguishable from a broken one.
 * - `invalid` resolves to `true`, logged at `error` with the raw value
 *   (G-03-3 design decision 2): a daemon does not dispatch against a value
 *   it could not read. Wrongly resuming spends money against an operator's
 *   explicit stop; wrongly staying paused only makes work wait until a
 *   human looks — the two failure directions are not symmetric.
 *
 * Both the `warn` and the `error` line name the remedy (`adl resume`) so
 * the operator reads a next action, not just a fact.
 */
export async function restoreGlobalPause(
  deps: RestoreGlobalPauseDeps,
): Promise<boolean> {
  const meta = metaRepository(deps.db);
  const result = await meta.getGlobalPause();

  if (result.kind === 'absent') {
    return false;
  }

  if (result.kind === 'invalid') {
    deps.logger.error(
      { rawValue: result.rawValue },
      'startup: stored global_pause value is unreadable — booting paused rather than dispatching against a value that could not be read. Run `adl resume` once you have confirmed dispatch should proceed.',
    );
    return true;
  }

  if (result.paused) {
    deps.logger.warn(
      { paused: true },
      'startup: restoring a persisted global pause set before the last restart — dispatch will not run until `adl resume`.',
    );
  }
  return result.paused;
}
