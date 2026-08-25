import { sql, type Kysely } from 'kysely';

/**
 * Adds `rounds.head_sha` — the commit the developer produced in that round.
 *
 * ## Why a column and not a field on `RoundOutcome`
 *
 * `docs/plan/DEBT.md` D-5-11-1 recorded the defect: a round's commit sha
 * arrives on the `stage_result` **event** and lives only while that round is
 * the newest one. `publish/role-rounds.ts` rebuilds the sticky pull-request
 * comment from the database on every round (M05 step 5.11 chose "evaluate
 * state, don't remember events" deliberately, so a human-edited or deleted
 * comment is *repaired* by the next round rather than corrupted), which means
 * republishing during round 2 renders round 1 from tables alone — and round
 * 1's fold silently lost its sha.
 *
 * The item's own proposed fix was to write a real `RoundOutcome` into
 * `rounds.outcome_json`, and M05 step 5.13 found that premise wrong: a
 * `RoundOutcome` has no field for a commit, so it never could have carried
 * one. Adding one would have been worse still — `RoundOutcome` is
 * `aggregate()`'s return value, a statement about *verdicts*, and a commit sha
 * is not a verdict.
 *
 * So it is a column. `outcome_json` keeps saying what the gates decided, and
 * this says what the developer produced.
 *
 * ## Nullable, deliberately
 *
 * Three ordinary rounds have no sha and never will:
 *
 * - a round still running, before its developer stage has reported;
 * - a round whose developer reported `blocked` — a real, honest
 *   {@link DeveloperOutcome} with no commit in it; and
 * - every round written before this migration ran.
 *
 * A `not null default ''` would make all three indistinguishable from a round
 * whose sha was lost, which is the exact confusion this column exists to end.
 *
 * ## The two consumers
 *
 * 1. `publish/role-rounds.ts` — a folded prior round keeps its sha (D-5-11-1).
 * 2. The command gate and, after it, ROLE-11's protected-path diffing (M05
 *    step 5.16): both need the diff between the base ref and *this round's*
 *    commit, and the second consumer is why this landed as a migration rather
 *    than as a rendering workaround.
 *
 * `alter table ... add column` and nothing else — SQLite supports it directly,
 * so none of the 12-step rebuild dance `0004_feature_state_constraint.ts`
 * documents is needed here. Additive, per D-29: `0002_contracts.ts` created
 * `rounds` and is **not** edited, and `checksum.ts`'s guard (D-30) would refuse
 * to run at all if it were.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`alter table rounds add column head_sha text`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // `drop column` has been supported since SQLite 3.35 (2021-03); the
    // `better-sqlite3@13` bundled amalgamation is far past that. It refuses on
    // a column named by an index, a view, or a trigger — this one is named by
    // none, which is why the rebuild dance is unnecessary in this direction
    // too.
    await sql`alter table rounds drop column head_sha`.execute(trx);
  });
}
