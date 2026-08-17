import { sql, type Kysely } from 'kysely';

/**
 * The contract tables Phases 1 through 5 need: `rounds`, `stage_attempts`,
 * `verdicts`, `verdict_checked_criteria`, `findings`, `waivers`,
 * `usage_events`, and `model_prices`.
 *
 * `0001_initial.ts` is **not** edited to add them, and never will be. Migrations
 * are additive (D-29), and `src/checksum.ts` refuses to run at all if an applied
 * migration's bytes change — because that corruption lands in an adopter's
 * database while ADL's CI stays green, since CI migrates from empty every time.
 *
 * The two SQLite facts `0001_initial.ts` documents still hold and still shape
 * this file:
 *
 * 1. Kysely takes the **non-transactional** path on SQLite
 *    (`SqliteAdapter.supportsTransactionalDdl === false`), so `up()` wraps its
 *    own statements in an explicit `db.transaction()`. The runner supplies a
 *    re-entrant transaction (see `src/migrator.ts`) so that this migration's
 *    statements and its checksum record commit or roll back together.
 * 2. `PRAGMA foreign_keys` cannot be toggled inside a transaction. Nothing here
 *    needs SQLite's 12-step table rebuild, so the exception does not bite yet.
 *
 * What is deliberately **absent**: `outbox`, `forge_events`, and `artifacts`.
 * Those arrive with the phases that use them. `migrate.test.ts` asserts their
 * absence, so "we have not built that yet" and "we forgot" do not look
 * identical to whoever reads this schema next.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // One row per round of the loop. `outcome` is the `RoundOutcome` kind and
    // stays null while the round is running — a round in flight has not
    // concluded anything, and a default would claim otherwise.
    await sql`
      create table rounds (
        id           text primary key,
        feature_id   text not null references features(id),
        number       integer not null,
        outcome      text check (outcome is null or outcome in ('green', 'send_back', 'escalate', 'unverified')),
        outcome_json text,
        started_at   text not null,
        ended_at     text,
        unique (feature_id, number)
      )
    `.execute(trx);

    // One row per attempt at one pipeline position within a round.
    //
    // `stage_index` is EXEC-07's mechanism recorded as data: adding a harness
    // moves a list index, it does not add a lifecycle state. `attempt` counts
    // D-13's single repair reprompt, so the retry is visible in history rather
    // than folded into the first attempt.
    //
    // The `error_*` columns hold a `StageError` (D-12) — "the gate broke",
    // which is a different kind of thing from "the gate judged". A row is
    // therefore `status = 'error'` with no verdict, or `status = 'verdict'`
    // with exactly one. `error_raw_ref` is an **artifact pointer**, never the
    // blob: transcripts do not live in database rows.
    await sql`
      create table stage_attempts (
        id            text primary key,
        round_id      text not null references rounds(id),
        stage_id      text not null,
        stage_index   integer not null,
        attempt       integer not null,
        status        text not null check (status in ('running', 'verdict', 'error')),
        error_kind    text check (error_kind is null or error_kind in ('unparseable', 'provider_error', 'timeout', 'binary_missing', 'auth')),
        error_retryable integer check (error_retryable is null or error_retryable in (0, 1)),
        error_raw_ref text,
        started_at    text not null,
        ended_at      text,
        unique (round_id, stage_index, attempt)
      )
    `.execute(trx);

    // A human's recorded acceptance that a gate was not satisfied (D-07).
    // Created before `verdicts` because a `skip` verdict references one.
    await sql`
      create table waivers (
        id                     text primary key,
        feature_id             text not null references features(id),
        target_kind            text not null check (target_kind in ('criterion', 'global', 'stage')),
        target_criterion_id    text,
        target_global_category text,
        target_stage_id        text,
        reason                 text not null,
        actor                  text not null,
        at                     text not null
      )
    `.execute(trx);

    // A **table**, not a JSON column on `stage_attempts`.
    //
    // FORGE-08's coverage table and D-11's cited-criteria list both want to be
    // queried; a JSON blob turns each of those into a scan over every stored
    // verdict. The six-outcome vocabulary is enforced here too — the database
    // is the last place it can be checked before Phase 6's budget and the PR
    // renderer start reading rows they cannot interpret.
    //
    // `summary` is nullable because `skip` carries only a `reason`; `reason` is
    // nullable because `pass`, `send_back`, and `warn` carry only a `summary`.
    await sql`
      create table verdicts (
        id               text primary key,
        stage_attempt_id text not null references stage_attempts(id),
        outcome          text not null check (outcome in ('pass', 'send_back', 'fail', 'inconclusive', 'warn', 'skip')),
        summary          text,
        reason           text,
        waiver_id        text references waivers(id),
        created_at       text not null,
        unique (stage_attempt_id)
      )
    `.execute(trx);

    // The cited coverage of a `pass` verdict, one row per citation, in the
    // order the gate cited them. This is what makes a coverage row a join.
    await sql`
      create table verdict_checked_criteria (
        id              text primary key,
        verdict_id      text not null references verdicts(id),
        position        integer not null,
        ref_kind        text not null check (ref_kind in ('criterion', 'global')),
        criterion_id    text,
        global_category text,
        unique (verdict_id, position)
      )
    `.execute(trx);

    // `criterion_ref_kind` plus its two payload columns is `CriterionRef`
    // flattened (D-03) — required, never absent, so the coverage table can show
    // an honest untied-findings bucket rather than hiding one.
    //
    // `path` is **workspace-relative and nothing else** (T-1-36). A host path
    // here is persisted, then rendered into a public pull-request comment. The
    // validating guard is plan 01-07's, upstream of every writer.
    await sql`
      create table findings (
        id                 text primary key,
        verdict_id         text not null references verdicts(id),
        fingerprint        text not null,
        severity           text not null check (severity in ('blocker', 'major', 'minor', 'nit')),
        title              text not null,
        detail             text not null,
        criterion_ref_kind text not null check (criterion_ref_kind in ('criterion', 'global')),
        criterion_id       text,
        global_category    text,
        path               text,
        line               integer,
        end_line           integer,
        suggested_action   text,
        created_at         text not null
      )
    `.execute(trx);

    // The one table where getting the columns wrong is unrecoverable.
    //
    // The Messages API reports four separately-priced input-side counters, and
    // a schema that collapses them is lossy **at write time**: cache reads bill
    // at roughly a tenth of plain input and cache writes at a premium, so a
    // single `input_tokens` column cannot reconstruct spend afterwards. Phase 6
    // reconstructs cost from history it did not collect, or it does not
    // reconstruct it at all (D-29, Pitfall 6).
    //
    // Every token column is **nullable with no default**. `default 0` would be
    // the quiet version of the same loss: a backend that does not report cache
    // tokens becomes indistinguishable from one reporting zero, permanently,
    // and no later migration can recover which was which.
    //
    // No token estimator ever populates these columns. A general-purpose
    // tokenizer undercounts Claude tokens by a wide margin on code, which would
    // make the budget gate systematically wrong in the direction of overspend.
    // Only backend-reported usage goes in here; anything else stays null and
    // the row records `cost_source = 'unknown'`.
    //
    // `cost_usd` is nullable because an unpriceable model records **no cost**,
    // never zero (D-31). Zero is the budget quietly ceasing to enforce.
    //
    // `cost_category` separates the feature's spend from what ADL wasted on
    // repair retries and failed parses (D-14). Both count against the budget;
    // the maintainer is entitled to see them apart.
    await sql`
      create table usage_events (
        id                          text primary key,
        feature_id                  text not null references features(id),
        round_id                    text references rounds(id),
        stage_attempt_id            text references stage_attempts(id),
        model_id                    text not null,
        speed                       text not null check (speed in ('standard', 'fast')),
        input_tokens                integer,
        output_tokens               integer,
        cache_creation_input_tokens integer,
        cache_read_input_tokens     integer,
        cost_usd                    real,
        cost_source                 text not null check (cost_source in ('reported', 'computed', 'unknown')),
        cost_category               text not null check (cost_category in ('feature', 'overhead')),
        at                          text not null
      )
    `.execute(trx);

    // Prices live here and only here (C-14, D-31). A price written into source
    // silently rewrites historical spend the moment it changes, and breaks
    // every budget audit that predates the edit.
    //
    // The cache multipliers are columns for exactly the same reason the base
    // rates are: a multiplier changed in code is a price changed in code.
    //
    // `effective_from` makes a correction a *new row*, not an edit — which is
    // also the only correction the checksum guard will accept, since editing
    // the applied seed migration makes the runner refuse to start.
    await sql`
      create table model_prices (
        id                     text primary key,
        model_id               text not null,
        speed                  text not null check (speed in ('standard', 'fast')),
        input_usd_per_mtok     real not null,
        output_usd_per_mtok    real not null,
        cache_write_multiplier real not null,
        cache_read_multiplier  real not null,
        effective_from         text not null,
        unique (model_id, speed, effective_from)
      )
    `.execute(trx);

    await sql`create index rounds_feature_idx on rounds (feature_id, number)`.execute(trx);
    await sql`create index stage_attempts_round_idx on stage_attempts (round_id, stage_index)`.execute(
      trx,
    );
    await sql`create index verdicts_attempt_idx on verdicts (stage_attempt_id)`.execute(trx);
    // The coverage query joins on the criterion id, so it gets its own index.
    await sql`create index verdict_checked_criteria_criterion_idx on verdict_checked_criteria (criterion_id)`.execute(
      trx,
    );
    // Stall detection (LOOP-06) asks "did this fingerprint appear last round?".
    await sql`create index findings_fingerprint_idx on findings (fingerprint)`.execute(trx);
    await sql`create index findings_verdict_idx on findings (verdict_id)`.execute(trx);
    await sql`create index waivers_feature_idx on waivers (feature_id)`.execute(trx);
    await sql`create index usage_events_feature_idx on usage_events (feature_id, at)`.execute(trx);
    // The temporal price lookup: model + tier, latest row at or before a date.
    await sql`create index model_prices_lookup_idx on model_prices (model_id, speed, effective_from)`.execute(
      trx,
    );
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // Reverse creation order so the foreign keys unwind cleanly.
    await sql`drop table if exists model_prices`.execute(trx);
    await sql`drop table if exists usage_events`.execute(trx);
    await sql`drop table if exists findings`.execute(trx);
    await sql`drop table if exists verdict_checked_criteria`.execute(trx);
    await sql`drop table if exists verdicts`.execute(trx);
    await sql`drop table if exists waivers`.execute(trx);
    await sql`drop table if exists stage_attempts`.execute(trx);
    await sql`drop table if exists rounds`.execute(trx);
  });
}
