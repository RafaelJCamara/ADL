import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { featuresRepository, type Database } from '@adl/db';
import { killFeature, type ControlResult } from './control.js';
import type { WorkerSupervisor } from '../../worker-supervisor/supervisor.js';

/**
 * `GET /features` — the read view `adl status` renders. Field names are
 * camelCase and are the planner's discretion (D-20); the stage *name*
 * rendering (joining `stageIndex` against the pipeline for a label like
 * `gating 2/4 (test)`, D-22) lands with the full status view in a later
 * plan — this tracer exposes the raw fields it needs.
 *
 * `POST /features/:id/kill` (D-27..29, 03-07 Task 3) lives here too,
 * alongside the rest of the single-feature resource surface, sharing
 * `routes/control.ts`'s `killFeature` so the stop-then-transition sequence
 * is one implementation, not two.
 */
export interface FeatureView {
  readonly id: string;
  readonly repoId: string;
  readonly path: string;
  readonly state: string;
  readonly round: number;
  readonly stageIndex: number;
  readonly pipelineLength: number;
  readonly ageMs: number;
  readonly worker: { readonly pid: number } | null;
  /**
   * D-09's stale-rejection counter, surfaced per feature. Zero for a feature
   * that has never had a zombie write rejected — this field always has a
   * value, never `null`/absent, so its presence is not itself a signal.
   */
  readonly staleRejections: number;
}

export interface FeaturesRouteDeps {
  readonly listFeatureViews: () => Promise<readonly FeatureView[]>;
  /** Present only when the caller also wants `POST /features/:id/kill` mounted (03-07 Task 3). */
  readonly db?: Kysely<Database>;
  readonly supervisor?: WorkerSupervisor;
  readonly workerStopGraceMs?: number;
  readonly logger?: Logger;
}

const KILL_ACTOR = 'api';

export function registerFeaturesRoute(
  app: Hono,
  deps: FeaturesRouteDeps,
): void {
  app.get('/features', async (c) => {
    const features = await deps.listFeatureViews();
    return c.json(features);
  });

  const { db, supervisor, workerStopGraceMs, logger } = deps;
  if (
    db !== undefined &&
    supervisor !== undefined &&
    workerStopGraceMs !== undefined &&
    logger !== undefined
  ) {
    app.post('/features/:id/kill', async (c) => {
      const featureId = c.req.param('id');
      const feature = await featuresRepository(db).findById(featureId);
      if (feature === undefined) {
        return c.json({ error: 'not found' }, 404);
      }
      const changed = await killFeature(
        { db, supervisor, workerStopGraceMs, logger },
        feature,
        KILL_ACTOR,
      );
      return c.json({
        affected: changed ? [featureId] : [],
      } satisfies ControlResult);
    });
  }
}
