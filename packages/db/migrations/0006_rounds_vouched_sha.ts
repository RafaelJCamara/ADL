import { sql, type Kysely } from 'kysely';

/**
 * Adds `rounds.vouched_sha` — the branch tip ADL vouches for, as of this round
 * (M08 step 8.6, closing `docs/plan/DEBT.md` D-8-A-1).
 *
 * ## Why `head_sha` could not do this job
 *
 * ROLE-11's protected-path check needs a base to diff the developer's new
 * commit against, and it used the previous round's `head_sha`. But `head_sha`
 * is the **developer's** commit, recorded the moment the developer stage
 * reports — before any gate runs. A commit a gate makes afterwards (7.3's
 * plain-command gate is an arbitrary program; 8.6's carry-back of the
 * behaviour tester's tests is ADL itself) therefore fell outside round N's
 * recorded head and inside round N+1's diff, where it was judged as the
 * developer's work.
 *
 * Rewriting `head_sha` to the round's final tip would have fixed the diff and
 * broken its other two readers: `publish/role-rounds.ts` renders it as
 * "Committed `abc1234`" on the **developer's** fold, and that line would then
 * name a commit the developer did not make. So the two meanings get two
 * columns: `head_sha` keeps saying what the developer produced, and this says
 * which tree ADL is prepared to defend.
 *
 * ## What "vouched" means, exactly
 *
 * Written in exactly two places, both in `loop/round-runner.ts`:
 *
 * 1. a developer commit that ROLE-11 found **clean** — its sha; and
 * 2. a gate stage that started on the vouched tip and moved HEAD — its final
 *    sha, by compare-and-set against the tip it started from, so a gate that
 *    started on anything ADL had not vouched for vouches for nothing.
 *
 * Never written for a violating commit. So a feature escalated by ROLE-11 and
 * then resumed is judged against the last clean tip rather than against the
 * violation itself — which the old base (`head_sha`, written before the check)
 * silently laundered.
 *
 * ## Per round, not per feature
 *
 * The base is "the newest non-null `vouched_sha` across the feature's rounds,
 * the open round included". A per-feature column would have been the same
 * value with thirty insert sites to touch instead of nine, and the per-round
 * record is the history M09's pull request can read: which round's tip ADL
 * vouched for, and when a gate moved it.
 *
 * Nullable for `head_sha`'s own reasons: a round that has not reached a clean
 * developer commit yet, a `blocked` round, and every round written before
 * this migration. The reader falls back to `head_sha`'s old rule for those, so
 * a feature in flight across the upgrade keeps today's behaviour exactly.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`alter table rounds add column vouched_sha text`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // `0005_rounds_head_sha.ts`'s reasoning: SQLite ≥ 3.35 drops a column
    // named by no index, view or trigger directly.
    await sql`alter table rounds drop column vouched_sha`.execute(trx);
  });
}
