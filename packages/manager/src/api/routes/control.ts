import { zValidator } from '@hono/zod-validator';
import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import * as z from 'zod';
import {
  featuresRepository,
  nowIso,
  type Database,
  type FeaturesTable,
} from '@adl/db';
import {
  applyControlEvent,
  GlobalPausePersistError,
  type ControlState,
} from '../../control/state.js';
import { stopWorker } from '../../worker-supervisor/lifecycle.js';
import type { WorkerSupervisor } from '../../worker-supervisor/supervisor.js';

/**
 * `src/api/routes/control.ts` — D-20's control surface: pause/resume at
 * feature, repo, and global scope (D-26), and `POST /control/kill`
 * (D-27..29). `POST /features/:id/kill` lives in `routes/features.ts`
 * instead, alongside the other single-feature routes, but shares this
 * module's {@link killFeature} so the stop-then-transition sequence cannot
 * drift between the two call sites.
 *
 * `zValidator` is applied per route, not through `app.use()`, so the
 * validated type is inferred correctly at the handler
 * (03-RESEARCH.md § "Code Examples").
 */

/**
 * The API does not yet distinguish callers beyond the single shared bearer
 * token (D-19) — there is no per-credential identity to record. `'api'` is
 * the actor recorded on every control-driven transition until credential-
 * scoped identity exists; it is non-empty, which is everything D-26's
 * "every pause and resume writes a feature_events row whose actor names the
 * caller" acceptance criterion checks for today.
 */
const CONTROL_ACTOR = 'api';

export const ControlScopeSchema = z
  .enum(['feature', 'repo', 'all'])
  .meta({ id: 'ControlScope' });
export type ControlScope = z.infer<typeof ControlScopeSchema>;

export const PauseRequestSchema = z
  .strictObject({
    scope: ControlScopeSchema,
    repoId: z.string().min(1).optional(),
  })
  .meta({ id: 'PauseRequest' })
  .superRefine((value, ctx) => {
    if (value.scope === 'repo' && value.repoId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['repoId'],
        message: "repoId is required when scope is 'repo'",
      });
    }
  });
export type PauseRequest = z.infer<typeof PauseRequestSchema>;

export const KillRequestSchema = z
  .strictObject({
    scope: ControlScopeSchema,
    repoId: z.string().min(1).optional(),
  })
  .meta({ id: 'KillRequest' })
  .superRefine((value, ctx) => {
    if (value.scope === 'repo' && value.repoId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['repoId'],
        message: "repoId is required when scope is 'repo'",
      });
    }
  });
export type KillRequest = z.infer<typeof KillRequestSchema>;

export const ControlResultSchema = z
  .strictObject({
    /** The feature ids this request actually changed — the blast radius. */
    affected: z.array(z.string()),
  })
  .meta({ id: 'ControlResult' });
export type ControlResult = z.infer<typeof ControlResultSchema>;

export interface ControlRoutesDeps {
  readonly db: Kysely<Database>;
  readonly controlState: ControlState;
  /** Present only when the caller also wants `POST /control/kill` mounted (03-07 Task 3). */
  readonly supervisor?: WorkerSupervisor;
  readonly workerStopGraceMs?: number;
  readonly logger?: Logger;
}

async function pauseScope(
  deps: ControlRoutesDeps,
  scope: 'repo' | 'all',
  repoId: string | undefined,
): Promise<string[]> {
  if (scope === 'repo') {
    deps.controlState.setRepoPause(repoId!, true);
  } else {
    // Persists before it flips the in-memory flag (`setGlobalPause`'s own
    // contract). A `GlobalPausePersistError` here propagates to the route
    // handler before the queued-feature parking loop below runs — a
    // persistence failure means nothing else ran.
    await deps.controlState.setGlobalPause(true);
  }

  // Only currently-*queued* rows are parked synchronously here — an
  // in-flight (leased) feature in scope finishes its current round and
  // parks at that boundary instead (the supervisor's `onRoundBoundary`
  // hook, wired in `daemon.ts`), never mid-round.
  const repo = featuresRepository(deps.db);
  const queued = await repo.listQueued();
  const targets =
    scope === 'repo' ? queued.filter((f) => f.repo_id === repoId) : queued;

  const affected: string[] = [];
  const now = nowIso();
  for (const feature of targets) {
    const changed = await applyControlEvent(
      deps.db,
      feature,
      { t: 'pause', by: CONTROL_ACTOR },
      CONTROL_ACTOR,
      now,
    );
    if (changed) affected.push(feature.id);
  }
  return affected;
}

async function resumeScope(
  deps: ControlRoutesDeps,
  scope: 'repo' | 'all',
  repoId: string | undefined,
): Promise<string[]> {
  if (scope === 'repo') {
    deps.controlState.setRepoPause(repoId!, false);
  } else {
    await deps.controlState.setGlobalPause(false);
  }

  const repo = featuresRepository(deps.db);
  const paused = await repo.listByState('paused');
  const targets =
    scope === 'repo' ? paused.filter((f) => f.repo_id === repoId) : paused;

  const affected: string[] = [];
  const now = nowIso();
  for (const feature of targets) {
    const changed = await applyControlEvent(
      deps.db,
      feature,
      { t: 'resume', by: CONTROL_ACTOR },
      CONTROL_ACTOR,
      now,
    );
    if (changed) affected.push(feature.id);
  }
  return affected;
}

/** The subset of `ControlRoutesDeps` kill actually needs, all present. */
export interface KillDeps {
  readonly db: Kysely<Database>;
  readonly supervisor: WorkerSupervisor;
  readonly workerStopGraceMs: number;
  readonly logger: Logger;
}

/**
 * D-27's kill: stop the worker **first** (if this feature is currently
 * in-flight — a queued feature has none), then transition to `paused`.
 * Order matters: a transition written while the worker is still running
 * would be a state the lease holder can still contradict.
 *
 * A killed feature lands in `paused`, never `escalated` — kill stops the
 * process, it does not judge the feature (D-27). Reusing `applyControlEvent`
 * with a `pause` event is exactly how that's expressed: the same edge D-26's
 * maintainer-initiated pause uses, so there is only ever one way a feature
 * reaches `paused`.
 */
export async function killFeature(
  deps: KillDeps,
  feature: FeaturesTable,
  actor: string,
): Promise<boolean> {
  const active = deps.supervisor.get(feature.id);
  if (active !== undefined) {
    await stopWorker(
      deps.supervisor,
      active,
      deps.workerStopGraceMs,
      deps.logger,
    );
  }
  return applyControlEvent(
    deps.db,
    feature,
    { t: 'pause', by: actor },
    actor,
    nowIso(),
  );
}

async function killScope(
  deps: KillDeps,
  scope: 'repo' | 'all',
  repoId: string | undefined,
): Promise<string[]> {
  const repo = featuresRepository(deps.db);
  const leased = await repo.listLeased();
  const queued = await repo.listQueued();
  const leasedTargets =
    scope === 'repo' ? leased.filter((f) => f.repo_id === repoId) : leased;
  // The `all`/`repo` scope stops every in-flight feature and parks every
  // queued one (the OBS-04 flagged assumption in 03-07-PLAN.md — the
  // alternative reading, stopping only what is in flight, is equally
  // consistent with the requirement text).
  const queuedTargets =
    scope === 'repo' ? queued.filter((f) => f.repo_id === repoId) : queued;

  const affected: string[] = [];
  for (const feature of leasedTargets) {
    const changed = await killFeature(deps, feature, CONTROL_ACTOR);
    if (changed) affected.push(feature.id);
  }
  const now = nowIso();
  for (const feature of queuedTargets) {
    const changed = await applyControlEvent(
      deps.db,
      feature,
      { t: 'pause', by: CONTROL_ACTOR },
      CONTROL_ACTOR,
      now,
    );
    if (changed) affected.push(feature.id);
  }
  return affected;
}

export function registerControlRoutes(
  app: Hono,
  deps: ControlRoutesDeps,
): void {
  const { supervisor, workerStopGraceMs, logger } = deps;
  if (
    supervisor !== undefined &&
    workerStopGraceMs !== undefined &&
    logger !== undefined
  ) {
    app.post(
      '/control/kill',
      zValidator('json', KillRequestSchema),
      async (c) => {
        const body = c.req.valid('json');
        if (body.scope === 'feature') {
          return c.json(
            {
              error:
                "scope 'feature' is not valid here — use POST /features/:id/kill",
            },
            400,
          );
        }
        const affected = await killScope(
          { db: deps.db, supervisor, workerStopGraceMs, logger },
          body.scope,
          body.repoId,
        );
        return c.json({ affected } satisfies ControlResult);
      },
    );
  }
  app.post('/features/:id/pause', async (c) => {
    const featureId = c.req.param('id');
    const repo = featuresRepository(deps.db);
    const feature = await repo.findById(featureId);
    if (feature === undefined) {
      return c.json({ error: 'not found' }, 404);
    }
    const changed = await applyControlEvent(
      deps.db,
      feature,
      { t: 'pause', by: CONTROL_ACTOR },
      CONTROL_ACTOR,
      nowIso(),
    );
    return c.json({
      affected: changed ? [featureId] : [],
    } satisfies ControlResult);
  });

  app.post('/features/:id/resume', async (c) => {
    const featureId = c.req.param('id');
    const repo = featuresRepository(deps.db);
    const feature = await repo.findById(featureId);
    if (feature === undefined) {
      return c.json({ error: 'not found' }, 404);
    }
    const changed = await applyControlEvent(
      deps.db,
      feature,
      { t: 'resume', by: CONTROL_ACTOR },
      CONTROL_ACTOR,
      nowIso(),
    );
    return c.json({
      affected: changed ? [featureId] : [],
    } satisfies ControlResult);
  });

  app.post(
    '/control/pause',
    zValidator('json', PauseRequestSchema),
    async (c) => {
      const body = c.req.valid('json');
      if (body.scope === 'feature') {
        return c.json(
          {
            error:
              "scope 'feature' is not valid here — use POST /features/:id/pause",
          },
          400,
        );
      }
      try {
        const affected = await pauseScope(deps, body.scope, body.repoId);
        return c.json({ affected } satisfies ControlResult);
      } catch (error) {
        if (error instanceof GlobalPausePersistError) {
          return c.json(
            {
              error:
                'the pause flag was not persisted — dispatch is unchanged',
            },
            500,
          );
        }
        throw error;
      }
    },
  );

  app.post(
    '/control/resume',
    zValidator('json', PauseRequestSchema),
    async (c) => {
      const body = c.req.valid('json');
      if (body.scope === 'feature') {
        return c.json(
          {
            error:
              "scope 'feature' is not valid here — use POST /features/:id/resume",
          },
          400,
        );
      }
      try {
        const affected = await resumeScope(deps, body.scope, body.repoId);
        return c.json({ affected } satisfies ControlResult);
      } catch (error) {
        if (error instanceof GlobalPausePersistError) {
          return c.json(
            {
              error:
                'the resume flag was not persisted — dispatch is unchanged',
            },
            500,
          );
        }
        throw error;
      }
    },
  );
}
