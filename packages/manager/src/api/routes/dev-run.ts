import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import * as z from 'zod';
import { ulid } from 'ulid';
import {
  featuresRepository,
  nowIso,
  reposRepository,
  type Database,
} from '@adl/db';
import {
  detectFormat,
  loadAdlTemplateSpec,
  loadGherkinSpec,
  LoadError,
} from '@adl/core/spec';
import { ContainmentError, resolveWithinRoot } from '@adl/workspace';
import type { DispatchDecision } from '../../scheduler/dispatcher.js';

/**
 * `POST /dev-run/:featureId` — D-03's `adl dev-run`: exercise a real
 * developer-agent commit while no loop exists yet. The pipeline this runs is
 * the synthetic single-stage one D-04 specifies (`develop` alone), not the
 * full stage list — this route is a bridge Phase 5 later wires its first
 * loop-stage call into, not throwaway scaffolding.
 *
 * The input is a real feature id resolving to a real `features/<id>/` folder,
 * loaded through the spec loader (D-05) — never an ad-hoc prompt string,
 * because exercising the real intake path is part of what success criterion 1
 * proves. This route loads and upserts the feature, then calls the SAME
 * `dispatchOnce` the background dispatch tick calls (never the stage
 * directly, per D-04) — so a real lease is acquired, a real workspace spec
 * assembled, and a real worker forked through the existing supervisor.
 *
 * `dispatchOnce` is called SYNCHRONOUSLY within this handler rather than
 * relying on the next background tick, because the response has to carry the
 * stage attempt id the caller needs to attach `adl logs -f` to — and that id
 * is minted inside `dispatchOnce` itself (`openAttempt`). A known, accepted
 * simplification for a `dev-run` bridge command: `dispatchOnce` dispatches
 * the OLDEST admissible queued feature, not necessarily this one, so on a
 * daemon with other queued work this call can (rarely) dispatch a different
 * feature first — reported as 409 rather than silently returning the wrong
 * attempt id.
 */

export const DevRunResultSchema = z
  .strictObject({
    featureId: z.string().min(1),
    stageAttemptId: z.string().min(1),
  })
  .meta({ id: 'DevRunResult' });
export type DevRunResult = z.infer<typeof DevRunResultSchema>;

export interface DevRunRoutesDeps {
  readonly db: Kysely<Database>;
  /** Absolute path to the repository ADL is running against — `features/<id>/` is resolved under it. */
  readonly mainRepo: string;
  /**
   * Runs exactly one dispatch attempt — the identical function
   * `daemon.ts`'s background tick calls, injected so this route never
   * assembles its own copy of `DispatcherDeps` (a second assembly is a
   * second place the two could drift apart).
   */
  readonly dispatchOnce: () => Promise<DispatchDecision>;
  readonly logger?: Logger;
}

/**
 * Load and validate the spec at `features/<featureId>/` directly off disk —
 * the same loader the worker later re-runs from inside the worktree.
 *
 * `featureId` arrives as a raw URL path segment and is untrusted: resolved
 * naively via `join(mainRepo, 'features', featureId)`, a value like
 * `../../../etc` would let a caller read arbitrary files off the host
 * outside `features/`. `resolveWithinRoot` refuses any component containing
 * `..`, a path separator, a drive-letter/UNC prefix, or a NUL byte before
 * this ever touches the filesystem — the same containment primitive
 * `transcript-path.ts` uses for the identical class of caller-supplied id.
 */
async function loadSpecOrThrow(
  mainRepo: string,
  featureId: string,
): Promise<{ readonly specHash: string }> {
  const featureDir = resolveWithinRoot(join(mainRepo, 'features'), featureId);
  const filenames = await readdir(featureDir);
  const detected = detectFormat(filenames);
  const entryPath = join(featureDir, detected.entryFile);
  const raw = await readFile(entryPath, 'utf8');
  const spec =
    detected.sourceFormat === 'adl-template'
      ? loadAdlTemplateSpec(raw, featureId)
      : loadGherkinSpec(raw, featureId, detected.entryFile);
  return { specHash: spec.specHash };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export function registerDevRunRoutes(app: Hono, deps: DevRunRoutesDeps): void {
  app.post('/dev-run/:featureId', async (c) => {
    const featureId = c.req.param('featureId');
    const featuresRepo = featuresRepository(deps.db);
    const reposRepo = reposRepository(deps.db);

    let specHash: string;
    try {
      const loaded = await loadSpecOrThrow(deps.mainRepo, featureId);
      specHash = loaded.specHash;
    } catch (error) {
      if (error instanceof ContainmentError) {
        return c.json({ error: 'invalid featureId' }, 400);
      }
      if (isEnoent(error)) {
        return c.json(
          { error: `no feature folder at features/${featureId}` },
          404,
        );
      }
      if (error instanceof LoadError) {
        return c.json(
          {
            error: `spec at features/${featureId} failed to load: ${error.message}`,
          },
          400,
        );
      }
      deps.logger?.error(
        { err: error, featureId },
        'POST /dev-run/:featureId: unexpected error loading the spec',
      );
      return c.json({ error: 'unexpected error loading the spec' }, 400);
    }

    const repos = await reposRepo.list();
    const repo = repos[0];
    if (repo === undefined) {
      deps.logger?.error(
        {},
        'POST /dev-run/:featureId: no repository is configured — cannot associate a feature row',
      );
      return c.json({ error: 'no repository is configured' }, 409);
    }

    const path = `features/${featureId}`;
    const now = nowIso();
    const existing = await featuresRepo.findByPath(repo.id, path);
    // The id this dispatch must resolve to — either the existing row's, or
    // the fresh one this handler is about to insert. Captured once so the
    // post-dispatch check below can always verify identity, not only when a
    // row already existed.
    const targetId = existing?.id ?? ulid();

    if (existing === undefined) {
      await featuresRepo.insert({
        id: targetId,
        repo_id: repo.id,
        path,
        state: 'queued',
        state_version: 1,
        round: 0,
        current_stage_index: 0,
        spec_hash: specHash,
        effective_config_json: null,
        workspace_handle: null,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        heartbeat_at: null,
        crash_count: 0,
        created_at: now,
        updated_at: now,
      });
    } else if (existing.state !== 'queued') {
      return c.json(
        {
          error: `feature ${featureId} is not available to dispatch (state: ${existing.state})`,
        },
        409,
      );
    }

    const decision = await deps.dispatchOnce();

    if (!decision.dispatched) {
      return c.json({ error: 'dispatch could not proceed' }, 409);
    }
    if (
      decision.featureId !== targetId ||
      decision.stageAttemptId === undefined
    ) {
      return c.json(
        {
          error:
            'a different queued feature was dispatched by this call (concurrent request) — retry',
        },
        409,
      );
    }

    return c.json({
      featureId: decision.featureId,
      stageAttemptId: decision.stageAttemptId,
    } satisfies DevRunResult);
  });
}
