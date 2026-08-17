import { sql, type Kysely } from 'kysely';

/**
 * The four tables the Phase 1 spine needs: `meta`, `repos`, `features`, and
 * `feature_events`. Migrations are additive and hand-written, so growth is the
 * normal path (D-29) — plan 01-10 adds the contract tables in `0002`.
 *
 * ---------------------------------------------------------------------------
 * Two SQLite facts this file is built around, both verified against Kysely
 * 0.29.5's source rather than assumed:
 *
 * 1. **Kysely does NOT wrap SQLite migrations in a transaction.**
 *    `SqliteAdapter.supportsTransactionalDdl` returns `false`, so `Migrator`
 *    takes the non-transactional path. A migration that failed on its third
 *    statement would leave a half-built schema with nothing recorded, and the
 *    next run would replay from the top and hit "table already exists" — in an
 *    *adopter's* database, where nobody can see it. Hence the explicit
 *    `db.transaction()` wrapping the whole `up()` body below.
 *
 * 2. **`PRAGMA foreign_keys` cannot be toggled inside a transaction.** SQLite
 *    silently ignores it there. Any future migration needing SQLite's 12-step
 *    table-rebuild dance must therefore toggle the pragma *outside* the
 *    transaction wrapper. That is a deliberate, documented exception — not
 *    something the next maintainer should have to discover.
 * ---------------------------------------------------------------------------
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // `meta` is a single key/value table. `schema_version` gates daemon
    // startup: a database newer than the running binary is refused rather than
    // opened optimistically.
    await sql`
      create table meta (
        key        text primary key,
        value      text not null,
        updated_at text not null
      )
    `.execute(trx);

    await sql`
      create table repos (
        id             text primary key,
        remote_url     text not null,
        default_branch text not null,
        forge          text not null,
        features_dir   text not null,
        created_at     text not null,
        updated_at     text not null
      )
    `.execute(trx);

    // One row per feature ADL has seen. `state` plus `current_stage_index` is
    // EXEC-07's mechanism: adding a gate to the pipeline moves a list index,
    // it does not add a state.
    //
    // `state_version` is the optimistic-concurrency token — every write
    // asserts the version it read and bumps it, so two workers racing on the
    // same feature cannot both win.
    await sql`
      create table features (
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

    // Append-only. Nothing in ADL updates or deletes a row here: the event log
    // is how "the whole loop's reasoning is visible" survives a crash, and a
    // log you can rewrite is not evidence of anything.
    await sql`
      create table feature_events (
        id         text primary key,
        feature_id text not null references features(id),
        seq        integer not null,
        from_state text,
        to_state   text not null,
        event_json text not null,
        actor      text not null,
        at         text not null,
        unique (feature_id, seq)
      )
    `.execute(trx);

    await sql`create index features_state_idx on features (state)`.execute(trx);
    await sql`create index feature_events_feature_idx on feature_events (feature_id, seq)`.execute(
      trx,
    );
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // Reverse creation order so the foreign keys unwind cleanly.
    await sql`drop table if exists feature_events`.execute(trx);
    await sql`drop table if exists features`.execute(trx);
    await sql`drop table if exists repos`.execute(trx);
    await sql`drop table if exists meta`.execute(trx);
  });
}
