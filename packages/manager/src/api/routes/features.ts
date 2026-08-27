import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { featuresRepository, type Database } from '@adl/db';
import type { StageCell } from '../../stage-name.js';
import { killFeature, type ControlResult } from './control.js';
import type { WorkerSupervisor } from '../../worker-supervisor/supervisor.js';

/**
 * `GET /features` — the read view `adl status` renders. Field names are
 * camelCase and are the planner's discretion (D-20). `stage` is the full
 * `StageCell` (D-22..25, `../../stage-name.js`) — position, pipeline length,
 * and the resolved stage name joined against the feature's own snapshotted
 * `effective_config_json`, e.g. rendering as `gating 2/4 (test)`.
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
  readonly stage: StageCell;
  readonly round: number;
  readonly ageMs: number;
  readonly worker: { readonly pid: number } | null;
  /**
   * D-09's stale-rejection counter, surfaced per feature. Zero for a feature
   * that has never had a zombie write rejected — this field always has a
   * value, never `null`/absent, so its presence is not itself a signal.
   */
  readonly staleRejections: number;
  /**
   * OBS-05 (M06 step 6.3): this feature's spend, broken down by role. Always
   * present with a zeroed default for a feature with no usage rows yet — the
   * same "never absent" discipline `staleRejections` already holds itself
   * to, and the reason a column that always reads zero for an AI-free
   * feature is still better than no column at all now that spend is real.
   */
  readonly spend: FeatureSpendView;
}

/** `FeatureView.spend` — `@adl/db`'s `SpendByRole`, restated at the API boundary. */
export interface FeatureSpendView {
  readonly totalUsd: number;
  readonly unpricedEvents: number;
  readonly byRole: Readonly<Record<string, number>>;
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
