import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Database } from '@adl/db';
import type { ControlState } from '../control/state.js';
import type { WorkerSupervisor } from '../worker-supervisor/supervisor.js';
import { registerControlRoutes } from './routes/control.js';
import { registerFeaturesRoute, type FeatureView } from './routes/features.js';
import { registerHealthRoute } from './routes/health.js';

/**
 * The Hono app: bearer middleware per Task 1's checkpoint decision
 * (option-b — daemon-generated token in the config file, `GET /health`
 * unauthenticated), then `GET /health`, `GET /features`, and — when the
 * caller supplies `db`/`controlState`/`supervisor` — the control surface
 * (`POST /features/:id/pause|resume|kill`, `POST /control/pause|resume|kill`,
 * D-20, D-26, D-27..29, 03-07).
 *
 * Token comparison is `crypto.timingSafeEqual`, never `===` — ASVS V2, and
 * not left to Task 1's decision; it applies to every option that was on the
 * table.
 */

/**
 * Every path this API accepts without the bearer token.
 *
 * Exactly one entry, and a test asserts that count directly: one exception
 * in the auth rule is one thing a future contributor can widen, per Task 1's
 * option-b trade-off.
 */
export const UNAUTHENTICATED_PATHS: readonly string[] = Object.freeze([
  '/health',
]);

const BEARER_PREFIX = 'Bearer ';

/**
 * Constant-time comparison of the presented token against the configured
 * one. Buffers of unequal length are compared against a same-length decoy
 * first, so the branch a mismatched length takes is not itself a timing
 * signal about how close the length was.
 */
function timingSafeTokenEqual(presented: string, expected: string): boolean {
  const presentedBuf = Buffer.from(presented);
  const expectedBuf = Buffer.from(expected);
  if (presentedBuf.length !== expectedBuf.length) {
    timingSafeEqual(presentedBuf, presentedBuf);
    return false;
  }
  return timingSafeEqual(presentedBuf, expectedBuf);
}

export interface ApiDeps {
  readonly apiToken: string;
  readonly schemaVersion: number;
  readonly listFeatureViews: () => Promise<readonly FeatureView[]>;
  /**
   * The control surface (`/features/:id/pause|resume|kill`,
   * `/control/pause|resume|kill`) needs `db` and `controlState` to do
   * anything; both are optional here so every earlier plan's `createApi`
   * call site (the tracer suite, the fencing suite) keeps compiling
   * unchanged — omitting them simply mounts no control routes. `daemon.ts`
   * always supplies both in production.
   */
  readonly db?: Kysely<Database>;
  readonly controlState?: ControlState;
  /** Present only when the caller also wants kill mounted (03-07 Task 3). */
  readonly supervisor?: WorkerSupervisor;
  readonly workerStopGraceMs?: number;
  readonly logger?: Logger;
}

export function createApi(deps: ApiDeps): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    if (UNAUTHENTICATED_PATHS.includes(c.req.path)) {
      await next();
      return;
    }
    const header = c.req.header('Authorization');
    const presented = header?.startsWith(BEARER_PREFIX)
      ? header.slice(BEARER_PREFIX.length)
      : undefined;
    if (
      presented === undefined ||
      !timingSafeTokenEqual(presented, deps.apiToken)
    ) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  registerHealthRoute(app, { schemaVersion: deps.schemaVersion });
  registerFeaturesRoute(app, {
    listFeatureViews: deps.listFeatureViews,
    db: deps.db,
    supervisor: deps.supervisor,
    workerStopGraceMs: deps.workerStopGraceMs,
    logger: deps.logger,
  });
  if (deps.db !== undefined && deps.controlState !== undefined) {
    registerControlRoutes(app, {
      db: deps.db,
      controlState: deps.controlState,
      supervisor: deps.supervisor,
      workerStopGraceMs: deps.workerStopGraceMs,
      logger: deps.logger,
    });
  }

  return app;
}

export type { FeatureView };
