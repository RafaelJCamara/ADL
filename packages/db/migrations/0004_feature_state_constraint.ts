import { sql, type Kysely } from 'kysely';

/**
 * Adds a `CHECK` constraint enumerating every valid `features.state` value —
 * closing the one unguarded seam plan 01-08's `exec-07.test.ts` exists to
 * check: `@adl/core/state`'s `FEATURE_STATES` (plan 01-09) and the
 * `features` table's own enforcement of that vocabulary (plans 01-02 and
 * 01-10) were written by different plans in different waves, and until this
 * migration, nothing at the database level enforced them agreeing at all —
 * `0001_initial.ts` declared `state text not null` with no constraint on
 * its values.
 *
 * `0001_initial.ts` and `0002_contracts.ts` are **not edited** to add this.
 * Migrations are additive (D-29), and the checksum guard (`src/checksum.ts`,
 * D-30) refuses to run at all if either file's bytes change after being
 * applied — the corruption that guard exists to prevent lands in an
 * adopter's database while CI stays green, since CI always migrates from
 * empty.
 *
 * ---------------------------------------------------------------------------
 * The 12-step SQLite table-rebuild dance, simplified
 *
 * SQLite has no `ALTER TABLE ... ADD CONSTRAINT`. Adding a `CHECK` to an
 * existing column means: create a replacement table with the constraint,
 * copy every row across, drop the original, and rename the replacement into
 * its place. `0001_initial.ts`'s header names this exact dance and records
 * that a migration needing it "must therefore toggle `PRAGMA foreign_keys`
 * outside the transaction wrapper" — SQLite silently ignores that pragma
 * inside one.
 *
 * That toggle is **not needed here**: `PRAGMA foreign_keys` is never turned
 * on anywhere in this codebase (verified: no `foreign_keys` pragma exists
 * outside this comment and the two migrations that mention the exception).
 * With FK enforcement off, SQLite raises no referential-integrity concern
 * over dropping and recreating a table other tables declare (unenforced)
 * `references` clauses toward, so the entire rebuild runs inside one
 * ordinary `db.transaction()`, exactly like every other migration in this
 * package — and rolls back atomically with everything else if any step
 * fails.
 * ---------------------------------------------------------------------------
 *
 * The eleven literals in the `check` clause below **must** match
 * `FEATURE_STATES` in `packages/core/src/state/feature-state.ts` exactly, in
 * both directions — `test/state/exec-07.test.ts` (01-08) checks that
 * agreement by reading both sources as text, every time the whole workspace
 * test suite runs. The clause is written as a literal SQL string, matching
 * `0002_contracts.ts`'s style for every other enumerated column (`outcome`,
 * `severity`, `cost_source`, …), rather than generated from a TypeScript
 * array — a textual guard can only check what is actually text.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`
      create table features_new (
        id                    text primary key,
        repo_id               text not null references repos(id),
        path                  text not null,
        state                 text not null check (state in ('discovered', 'queued', 'leased', 'developing', 'gating', 'publishing', 'pr_open', 'merged', 'escalated', 'abandoned', 'paused')),
        state_version         integer not null,
        round                 integer not null,
        current_stage_index   integer not null,
        spec_hash             text not null,
        effective_config_json text,
        workspace_handle      text,
        lease_owner           text,
        lease_token           text,
        lease_expires_at      text,
        heartbeat_at          text,
        crash_count           integer not null,
        created_at            text not null,
        updated_at            text not null,
        unique (repo_id, path)
      )
    `.execute(trx);

    await sql`
      insert into features_new (
        id, repo_id, path, state, state_version, round, current_stage_index,
        spec_hash, effective_config_json, workspace_handle, lease_owner,
        lease_token, lease_expires_at, heartbeat_at, crash_count, created_at, updated_at
      )
      select
        id, repo_id, path, state, state_version, round, current_stage_index,
        spec_hash, effective_config_json, workspace_handle, lease_owner,
        lease_token, lease_expires_at, heartbeat_at, crash_count, created_at, updated_at
      from features
    `.execute(trx);

    await sql`drop table features`.execute(trx);
    await sql`alter table features_new rename to features`.execute(trx);

    // Recreate the index `0001_initial.ts` created — dropping the table
    // dropped it too.
    await sql`create index features_state_idx on features (state)`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`
      create table features_unconstrained (
        id                    text primary key,
        repo_id               text not null references repos(id),
        path                  text not null,
        state                 text not null,
        state_version         integer not null,
        round                 integer not null,
        current_stage_index   integer not null,
        spec_hash             text not null,
        effective_config_json text,
        workspace_handle      text,
        lease_owner           text,
        lease_token           text,
        lease_expires_at      text,
        heartbeat_at          text,
        crash_count           integer not null,
        created_at            text not null,
        updated_at            text not null,
        unique (repo_id, path)
      )
    `.execute(trx);

    await sql`
      insert into features_unconstrained (
        id, repo_id, path, state, state_version, round, current_stage_index,
        spec_hash, effective_config_json, workspace_handle, lease_owner,
        lease_token, lease_expires_at, heartbeat_at, crash_count, created_at, updated_at
      )
      select
        id, repo_id, path, state, state_version, round, current_stage_index,
        spec_hash, effective_config_json, workspace_handle, lease_owner,
        lease_token, lease_expires_at, heartbeat_at, crash_count, created_at, updated_at
      from features
    `.execute(trx);

    await sql`drop table features`.execute(trx);
    await sql`alter table features_unconstrained rename to features`.execute(trx);
    await sql`create index features_state_idx on features (state)`.execute(trx);
  });
}
