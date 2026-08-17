import { sql, type Kysely } from 'kysely';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';

import {
  BOOKKEEPING_TABLES,
  DEFERRED_TABLES,
  PHASE_TABLES,
  TABLE_COLUMNS,
  migrateToLatest,
  type Database,
} from '../src/index.js';
import { MIGRATIONS_DIR, withTempDb } from './helpers/temp-db.js';

/**
 * What the full migration chain produces, and what it deliberately does not.
 *
 * The "deliberately does not" half is the one worth having. D-29 says the
 * outbox, forge-event, and artifact tables arrive with the phases that use
 * them; without an assertion, "we chose not to add those yet" and "we forgot"
 * look identical in a schema six months from now.
 */

async function tableNames(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ name: string }>`
    select name from sqlite_master
    where type = 'table' and name not like 'sqlite_%'
    order by name
  `.execute(db);
  return result.rows.map((r) => r.name);
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

async function columnInfo(db: Kysely<Database>, table: string): Promise<ColumnInfo[]> {
  // `pragma table_info` does not accept a bound parameter, so the table name is
  // interpolated with `sql.raw`. Every call site here passes a literal from
  // this file — no external input reaches it.
  const result = await sql<ColumnInfo>`pragma table_info(${sql.raw(table)})`.execute(db);
  return result.rows;
}

/** A repo + feature + round + stage attempt, so FK-shaped inserts read honestly. */
async function seedSpine(db: Kysely<Database>) {
  const at = '2026-08-17T12:00:00.000Z';
  const repoId = ulid();
  const featureId = ulid();
  const roundId = ulid();
  const attemptId = ulid();

  await db
    .insertInto('repos')
    .values({
      id: repoId,
      remote_url: 'https://github.com/example/target-repo.git',
      default_branch: 'main',
      forge: 'github',
      features_dir: 'features',
      created_at: at,
      updated_at: at,
    })
    .execute();

  await db
    .insertInto('features')
    .values({
      id: featureId,
      repo_id: repoId,
      path: 'features/dark-mode',
      state: 'gating',
      state_version: 1,
      round: 1,
      current_stage_index: 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: null,
      workspace_handle: null,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      heartbeat_at: null,
      crash_count: 0,
      created_at: at,
      updated_at: at,
    })
    .execute();

  await db
    .insertInto('rounds')
    .values({
      id: roundId,
      feature_id: featureId,
      number: 1,
      outcome: null,
      outcome_json: null,
      started_at: at,
      ended_at: null,
    })
    .execute();

  await db
    .insertInto('stage_attempts')
    .values({
      id: attemptId,
      round_id: roundId,
      stage_id: 'review',
      stage_index: 1,
      attempt: 1,
      status: 'running',
      error_kind: null,
      error_retryable: null,
      error_raw_ref: null,
      started_at: at,
      ended_at: null,
    })
    .execute();

  return { at, repoId, featureId, roundId, attemptId };
}

describe('the full migration chain against a real temp SQLite file', () => {
  it('creates exactly the phase tables the interface declares, plus bookkeeping', async () => {
    await withTempDb(async ({ db }) => {
      const result = await migrateToLatest(db, MIGRATIONS_DIR);
      expect(result.error).toBeUndefined();
      expect(result.results.map((r) => r.migrationName)).toEqual([
        '0001_initial',
        '0002_contracts',
        '0003_seed_model_prices',
      ]);
      expect(result.results.every((r) => r.status === 'Success')).toBe(true);

      const names = await tableNames(db);
      const expected = [...Object.keys(TABLE_COLUMNS), ...BOOKKEEPING_TABLES].sort();
      expect([...names].sort()).toEqual(expected);
    });
  });

  it('contains every table Phases 1 through 5 need', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const names = await tableNames(db);
      for (const table of PHASE_TABLES) {
        expect(names).toContain(table);
      }
    });
  });

  it('does not contain the tables deliberately deferred to later phases', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const names = await tableNames(db);
      for (const table of DEFERRED_TABLES) {
        expect(names).not.toContain(table);
      }
    });
  });

  it('applies nothing on a second run', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      // The daemon migrates on every startup. A second application would
      // rebuild an adopter's database underneath them on every restart.
      const second = await migrateToLatest(db, MIGRATIONS_DIR);
      expect(second.error).toBeUndefined();
      expect(second.results).toHaveLength(0);
    });
  });
});

describe('usage_events records enough to reconstruct cost', () => {
  const TOKEN_COLUMNS = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ];

  it('carries four separate token counters', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const names = (await columnInfo(db, 'usage_events')).map((c) => c.name);
      for (const column of TOKEN_COLUMNS) {
        expect(names).toContain(column);
      }
    });
  });

  it('leaves every token counter nullable with no default', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const columns = await columnInfo(db, 'usage_events');

      for (const column of TOKEN_COLUMNS) {
        const info = columns.find((c) => c.name === column);
        expect(info, `usage_events.${column} is missing`).toBeDefined();
        // A default of zero destroys the distinction, at write time and
        // permanently, between "the backend reported zero cache reads" and
        // "the backend does not report cache reads at all" (Pitfall 6).
        expect(info?.notnull, `usage_events.${column} must be nullable`).toBe(0);
        expect(info?.dflt_value, `usage_events.${column} must have no default`).toBeNull();
      }
    });
  });

  it('accepts a row whose counters are genuinely absent', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { at, featureId, roundId, attemptId } = await seedSpine(db);

      await db
        .insertInto('usage_events')
        .values({
          id: ulid(),
          feature_id: featureId,
          round_id: roundId,
          stage_attempt_id: attemptId,
          model_id: 'claude-opus-5',
          speed: 'standard',
          input_tokens: 1_000,
          output_tokens: 200,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          cost_usd: null,
          cost_source: 'unknown',
          cost_category: 'feature',
          at,
        })
        .execute();

      const row = await db.selectFrom('usage_events').selectAll().executeTakeFirstOrThrow();
      expect(row.cache_read_input_tokens).toBeNull();
      expect(row.cost_usd).toBeNull();
    });
  });

  it('rejects a cost source outside the three documented values', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { at, featureId } = await seedSpine(db);

      await expect(
        db
          .insertInto('usage_events')
          .values({
            id: ulid(),
            feature_id: featureId,
            round_id: null,
            stage_attempt_id: null,
            model_id: 'claude-opus-5',
            speed: 'standard',
            input_tokens: null,
            output_tokens: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            cost_usd: 0,
            // Not `reported`, `computed`, or `unknown`. The database is the
            // last place this vocabulary can be enforced before the budget
            // starts reading rows it cannot interpret.
            cost_source: 'free' as 'reported',
            cost_category: 'feature',
            at,
          })
          .execute(),
      ).rejects.toThrow(/CHECK constraint failed/i);
    });
  });

  it('rejects a cost category outside the two documented values', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { at, featureId } = await seedSpine(db);

      await expect(
        db
          .insertInto('usage_events')
          .values({
            id: ulid(),
            feature_id: featureId,
            round_id: null,
            stage_attempt_id: null,
            model_id: 'claude-opus-5',
            speed: 'standard',
            input_tokens: null,
            output_tokens: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            cost_usd: null,
            cost_source: 'unknown',
            cost_category: 'misc' as 'feature',
            at,
          })
          .execute(),
      ).rejects.toThrow(/CHECK constraint failed/i);
    });
  });
});

describe('verdicts are rows, not a JSON blob on the attempt', () => {
  it('stores one verdict per stage attempt with its cited criteria as child rows', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { at, attemptId } = await seedSpine(db);

      const verdictId = ulid();
      await db
        .insertInto('verdicts')
        .values({
          id: verdictId,
          stage_attempt_id: attemptId,
          outcome: 'pass',
          summary: 'Every acceptance criterion is implemented and covered.',
          reason: null,
          waiver_id: null,
          created_at: at,
        })
        .execute();

      await db
        .insertInto('verdict_checked_criteria')
        .values([
          {
            id: ulid(),
            verdict_id: verdictId,
            position: 0,
            ref_kind: 'criterion',
            criterion_id: 'AC-1',
            global_category: null,
          },
          {
            id: ulid(),
            verdict_id: verdictId,
            position: 1,
            ref_kind: 'criterion',
            criterion_id: 'AC-2',
            global_category: null,
          },
        ])
        .execute();

      // The coverage table FORGE-08 renders is a join, not a JSON parse over
      // every stored verdict. That is the whole reason `verdicts` is a table.
      const covered = await db
        .selectFrom('verdict_checked_criteria')
        .innerJoin('verdicts', 'verdicts.id', 'verdict_checked_criteria.verdict_id')
        .select(['verdict_checked_criteria.criterion_id'])
        .where('verdicts.outcome', '=', 'pass')
        .orderBy('verdict_checked_criteria.position')
        .execute();

      expect(covered.map((r) => r.criterion_id)).toEqual(['AC-1', 'AC-2']);
    });
  });

  it('rejects a seventh verdict outcome', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { at, attemptId } = await seedSpine(db);

      await expect(
        db
          .insertInto('verdicts')
          .values({
            id: ulid(),
            stage_attempt_id: attemptId,
            outcome: 'approved' as 'pass',
            summary: 'looks fine',
            reason: null,
            waiver_id: null,
            created_at: at,
          })
          .execute(),
      ).rejects.toThrow(/CHECK constraint failed/i);
    });
  });
});

describe('findings and waivers', () => {
  it('stores a finding with its fingerprint, severity, criterion reference, and relative path', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { at, attemptId } = await seedSpine(db);

      const verdictId = ulid();
      await db
        .insertInto('verdicts')
        .values({
          id: verdictId,
          stage_attempt_id: attemptId,
          outcome: 'send_back',
          summary: 'Two blockers.',
          reason: null,
          waiver_id: null,
          created_at: at,
        })
        .execute();

      await db
        .insertInto('findings')
        .values({
          id: ulid(),
          verdict_id: verdictId,
          fingerprint: 'b'.repeat(64),
          severity: 'blocker',
          title: 'Login handler does not validate the redirect target',
          detail: 'An open redirect is reachable from the login callback.',
          criterion_ref_kind: 'criterion',
          criterion_id: 'AC-3',
          global_category: null,
          // Workspace-relative. A host path here would leak the daemon's
          // filesystem layout into a pull-request comment (T-1-36).
          path: 'src/auth/login.ts',
          line: 42,
          end_line: 47,
          suggested_action: 'Compare the redirect against an allowlist.',
          created_at: at,
        })
        .execute();

      const finding = await db.selectFrom('findings').selectAll().executeTakeFirstOrThrow();
      expect(finding.fingerprint).toHaveLength(64);
      expect(finding.criterion_id).toBe('AC-3');
      expect(finding.path).toBe('src/auth/login.ts');
    });
  });

  it('stores a waiver with its target, reason, actor, and timestamp', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { at, featureId } = await seedSpine(db);

      await db
        .insertInto('waivers')
        .values({
          id: ulid(),
          feature_id: featureId,
          target_kind: 'stage',
          target_criterion_id: null,
          target_global_category: null,
          target_stage_id: 'security',
          reason: 'No security harness is configured for this repository yet.',
          actor: 'maintainer@example.com',
          at,
        })
        .execute();

      const waiver = await db.selectFrom('waivers').selectAll().executeTakeFirstOrThrow();
      expect(waiver.target_stage_id).toBe('security');
      expect(waiver.actor).toBe('maintainer@example.com');
      expect(waiver.at).toBe(at);
    });
  });
});
