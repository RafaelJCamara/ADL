import type { Hono } from 'hono';

/**
 * `GET /features` — the read view `adl status` renders. Field names are
 * camelCase and are the planner's discretion (D-20); the stage *name*
 * rendering (joining `stageIndex` against the pipeline for a label like
 * `gating 2/4 (test)`, D-22) lands with the full status view in a later
 * plan — this tracer exposes the raw fields it needs.
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
}

export function registerFeaturesRoute(
  app: Hono,
  deps: FeaturesRouteDeps,
): void {
  app.get('/features', async (c) => {
    const features = await deps.listFeatureViews();
    return c.json(features);
  });
}
