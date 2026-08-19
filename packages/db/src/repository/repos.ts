import type { Kysely } from 'kysely';
import type { Database, ReposTable } from '../schema.js';

/**
 * The daemon's watched-repository table.
 *
 * Configuration is the trust anchor (D-35): the daemon config file names
 * which repositories to watch, and `upsert` is what D-35's startup
 * reconciliation calls once per configured repository. The `repos` table is a
 * projection of that config, never the other way around — a future
 * `adl repo add`/`remove` CLI verb should edit the config file, not this
 * table directly, or the two sources of truth diverge.
 */

export type NewRepo = ReposTable;

export interface ReposRepository {
  /**
   * Insert a repo that does not exist yet, or update one that does.
   *
   * `created_at` is preserved on update — a repository's first-seen timestamp
   * is not something a config reload should rewrite. Every other column
   * (`remote_url`, `default_branch`, `forge`, `features_dir`, `updated_at`)
   * is overwritten with the caller's value, because those are exactly the
   * fields a config edit is meant to change.
   */
  upsert(repo: NewRepo): Promise<void>;
  findById(id: string): Promise<ReposTable | undefined>;
  list(): Promise<ReposTable[]>;
}

export function reposRepository(db: Kysely<Database>): ReposRepository {
  return {
    async upsert(repo) {
      await db
        .insertInto('repos')
        .values(repo)
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            remote_url: repo.remote_url,
            default_branch: repo.default_branch,
            forge: repo.forge,
            features_dir: repo.features_dir,
            updated_at: repo.updated_at,
          }),
        )
        .execute();
    },

    findById(id) {
      return db
        .selectFrom('repos')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
    },

    list() {
      return db.selectFrom('repos').selectAll().orderBy('id').execute();
    },
  };
}
