import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Database } from '@adl/db';
import { runGcOnce, type GcRunSummary } from '../../scheduler/gc-schedule.js';

/**
 * `POST /control/gc` — runs one GC pass on demand (D-34) and returns the
 * summary, so `adl gc` has something to print beyond "it ran".
 *
 * Mounted behind the same bearer middleware every other route in this
 * package is (`api/app.ts`); no route-local auth of its own.
 */

export interface GcRouteDeps {
  readonly mainRepo: string;
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

export function registerGcRoute(app: Hono, deps: GcRouteDeps): void {
  app.post('/control/gc', async (c) => {
    const summary = await runGcOnce({
      mainRepo: deps.mainRepo,
      db: deps.db,
      logger: deps.logger,
    });
    return c.json(summary satisfies GcRunSummary);
  });
}
