import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Database } from '@adl/db';
import type { ControlState } from '../control/state.js';
import type { DispatchDecision } from '../scheduler/dispatcher.js';
import type { WorkerSupervisor } from '../worker-supervisor/supervisor.js';
import { registerControlRoutes } from './routes/control.js';
import { registerDevRunRoutes } from './routes/dev-run.js';
import { registerFeaturesRoute, type FeatureView } from './routes/features.js';
import { registerGcRoute } from './routes/gc.js';
import { registerHealthRoute } from './routes/health.js';
import { registerLogsRoute } from './routes/logs.js';

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
  /**
   * The repository `POST /control/gc` sweeps (D-34, 03-08 Task 3). Present
   * only when the caller also wants the GC route mounted — optional so
   * every earlier plan's `createApi` call site keeps compiling unchanged.
   */
  readonly mainRepo?: string;
  /**
   * `adl daemon stop`'s target (03-08 Task 2): present only when the caller
   * also wants `POST /control/shutdown` mounted. Called *after* this
   * request's response has already been written — see the route body —
   * never awaited by the handler itself, so the client sees a real 200
   * before the server starts closing.
   */
  readonly onShutdownRequested?: () => void;
  /**
   * `POST /dev-run/:featureId` (04-06, D-03): present only when the caller
   * also wants dev-run mounted. Runs exactly one dispatch attempt — the same
   * function the background tick calls — so the route never assembles its
   * own copy of `DispatcherDeps`.
   */
  readonly dispatchOnce?: () => Promise<DispatchDecision>;
  /**
   * `GET /stages/:id/logs` (04-06): present only when the caller also wants
   * the transcript route mounted. The directory transcripts live under —
   * `logsRootFor(dbFilePath)`, computed once by `daemon.ts`.
   */
  readonly logsRoot?: string;
}

export function createApi(deps: ApiDeps): Hono {
  // WR-04: fail closed at startup rather than at request time. An empty
  // configured token makes `timingSafeTokenEqual` accept an equally-empty
  // presented token as a match — the auth middleware below would then
  // authenticate *any* request that omits the Authorization header
  // entirely (an empty `presented` string compares equal-length to an
  // empty `expected` one). A bearer token is the only thing standing
  // between a non-loopback bind (`ApiConfigSchema.host` explicitly allows
  // widening it) and an unauthenticated control plane, so a misconfigured
  // empty token must be a startup-time failure, never a live bypass.
  if (deps.apiToken.length === 0) {
    throw new Error(
      'createApi: apiToken must be a non-empty string — an empty token would authenticate every request',
    );
  }

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
  if (
    deps.db !== undefined &&
    deps.logger !== undefined &&
    deps.mainRepo !== undefined
  ) {
    registerGcRoute(app, {
      mainRepo: deps.mainRepo,
      db: deps.db,
      logger: deps.logger,
    });
  }
  if (
    deps.db !== undefined &&
    deps.mainRepo !== undefined &&
    deps.dispatchOnce !== undefined
  ) {
    registerDevRunRoutes(app, {
      db: deps.db,
      mainRepo: deps.mainRepo,
      dispatchOnce: deps.dispatchOnce,
      logger: deps.logger,
    });
  }
  if (deps.db !== undefined && deps.logsRoot !== undefined) {
    registerLogsRoute(app, { db: deps.db, logsRoot: deps.logsRoot });
  }
  if (deps.onShutdownRequested !== undefined) {
    app.post('/control/shutdown', (c) => {
      // Fire after this handler returns — a `setTimeout(0)` macrotask runs
      // once the current response has been handed to the socket, rather
      // than racing it with a same-tick microtask (`queueMicrotask`) that
      // could run before the bytes are on the wire.
      const requestShutdown = deps.onShutdownRequested!;
      setTimeout(() => requestShutdown(), 0);
      return c.json({ ok: true });
    });
  }

  return app;
}

export type { FeatureView };
