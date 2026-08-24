import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Cron } from 'croner';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { ulid } from 'ulid';
import {
  featuresRepository,
  nowIso,
  reposRepository,
  type Database,
  type FeaturesRepository,
  type ReposTable,
} from '@adl/db';
import type { ForgeAdapter, ForgeRepoRef } from '@adl/core/forge';
import type { UntrustedReason } from '@adl/core/detect';
import {
  detectFormat,
  loadAdlTemplateSpec,
  loadGherkinSpec,
} from '@adl/core/spec';
import {
  hostGitWorkspace,
  managerGitClient,
  resolveWithinRoot,
} from '@adl/workspace';
import { listFeatureFolders } from '../detect/scanner.js';
import { undevelopedFeatures } from '../detect/undeveloped.js';
import {
  evaluateFeatureTrust,
  type FolderTrustResult,
} from '../detect/trust.js';

/**
 * `src/scheduler/poll-schedule.ts` — the polling detection loop (DETECT-03,
 * M05 step 5.5): a croner job that re-runs detection on an interval and
 * enqueues what's new. Reuses `gc-schedule.ts`'s exact shape (`protect:
 * true`, one pass per tick, each step in its own try/catch) — the two
 * schedules share a scheduling mechanism, never a cadence (`poll.interval_ms`
 * is minutes-to-seconds, `gc.interval_ms` is minutes-to-hours).
 *
 * This is the first production caller of 5.2's `undevelopedFeatures` and
 * 5.3's `evaluateFeatureTrust` — everything downstream of them (5.1's
 * scanner, the two predicates) already exists and is tested in isolation;
 * this module is the composition: scan -> undeveloped filter -> trust filter
 * -> enqueue (a `features` row, `state: 'queued'`, the same shape
 * `POST /dev-run/:featureId` already inserts).
 *
 * **v1 scope note, matching 5.4's own:** exactly one physical `mainRepo` is
 * watched, so this reads `reposRepository(db).list()[0]` — the same
 * single-configured-repository assumption `dispatchOnce`,
 * `resolveProductionAdlYml`, and `POST /dev-run/:featureId` already make, not
 * a new one.
 *
 * **The forge dependency is injected, not constructed here.** No live
 * GitHub App credentials exist yet (`docs/plan/DEBT.md` item 1.7) — this
 * module takes a `ForgeAdapter` and a `ForgeRepoRef` as plain dependencies
 * (proven against the mock GitHub server in this module's own tests, the
 * same way 5.2's and 5.3's own tests are), and `daemon.ts` wires it in only
 * when a caller supplies one, matching the backend preflight gate's own
 * "absent means skip" precedent.
 */

/** One feature folder the trust filter rejected, and why. */
export interface PollRejection {
  readonly folder: string;
  readonly reason: UntrustedReason;
}

/** One feature folder that was trusted but failed to enqueue. */
export interface PollFailure {
  readonly folder: string;
  readonly error: unknown;
}

/** What one `runPollOnce` pass found and did. */
export interface PollRunSummary {
  readonly enqueued: readonly string[];
  readonly rejected: readonly PollRejection[];
  readonly failures: readonly PollFailure[];
}

/** Everything one poll pass needs. Carries no clock — `nowIso()` is read per write, matching `dev-run.ts`. */
export interface PollRunDeps {
  /** The repository ADL is running against — `WorkspaceSpec.mainRepo`, matching `dispatchOnce`'s and `daemon.ts`'s own. */
  readonly mainRepo: string;
  readonly scratchRoot: string;
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly forge: ForgeAdapter;
  readonly forgeRepo: ForgeRepoRef;
}

/** {@link PollRunDeps} plus the schedule's own cadence (`daemonConfig.poll.interval_ms`). */
export interface PollScheduleDeps extends PollRunDeps {
  readonly intervalMs: number;
}

/**
 * Run one step of the pass, logging (rather than propagating) a thrown
 * failure and falling back so later steps can still be attempted where that
 * makes sense — mirrors `gc-schedule.ts`'s `runSweep`, generalised to any
 * return type since this pipeline's steps produce different shapes.
 */
async function step<T>(
  name: string,
  fn: () => Promise<T>,
  fallback: T,
  logger: Logger,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logger.warn({ err: error }, `poll: the ${name} step threw and was skipped`);
    return fallback;
  }
}

/**
 * Load a folder's spec and compute its hash, the same way
 * `POST /dev-run/:featureId`'s own `loadSpecOrThrow` does — parameterised by
 * `featuresDir` (that route hardcodes `'features'`; this caller has the
 * watched repo's configured value on hand and should use it).
 *
 * `resolveWithinRoot` containment matches the discipline every other
 * repo-relative-path site in this codebase carries (`ForgeAdapter`'s own
 * docblock), even though `folder` is git-tree-derived rather than raw
 * caller input: a tree entry named `..` is not representable, but defence
 * in depth costs one call here.
 */
async function loadSpecHash(
  mainRepo: string,
  featuresDir: string,
  folder: string,
): Promise<{ readonly specHash: string }> {
  const featureDir = resolveWithinRoot(join(mainRepo, featuresDir), folder);
  const filenames = await readdir(featureDir);
  const detected = detectFormat(filenames);
  const entryPath = join(featureDir, detected.entryFile);
  const raw = await readFile(entryPath, 'utf8');
  const spec =
    detected.sourceFormat === 'adl-template'
      ? loadAdlTemplateSpec(raw, folder)
      : loadGherkinSpec(raw, folder, detected.entryFile);
  return { specHash: spec.specHash };
}

/**
 * Enqueue one trusted folder: load its spec (for `spec_hash`) and insert a
 * `queued` `features` row — the same shape `POST /dev-run/:featureId`
 * inserts, `effective_config_json: null` (D-22's snapshot happens at lease
 * time, never here).
 *
 * Re-checks `findByPath` immediately before the write (convention: check a
 * limit immediately before the state-changing action, never rely solely on
 * an earlier read) — `undevelopedFeatures` already filtered this folder out
 * once, but a concurrent `adl dev-run` or a previous tick's own insert can
 * have claimed the same path since that read. Finding one now is not a
 * failure — it is this tick losing a race it does not need to win.
 */
async function enqueueFeature(
  mainRepo: string,
  repo: ReposTable,
  featuresRepo: FeaturesRepository,
  folder: string,
): Promise<'enqueued' | 'already-claimed'> {
  const path = `${repo.features_dir}/${folder}`;

  const existing = await featuresRepo.findByPath(repo.id, path);
  if (existing !== undefined) return 'already-claimed';

  const { specHash } = await loadSpecHash(mainRepo, repo.features_dir, folder);

  const now = nowIso();
  await featuresRepo.insert({
    id: ulid(),
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
  return 'enqueued';
}

const EMPTY_SUMMARY: PollRunSummary = Object.freeze({
  enqueued: [],
  rejected: [],
  failures: [],
});

/**
 * One poll pass: scan the watched repo's default branch, filter to
 * undeveloped folders, filter those to trusted ones, and enqueue each — each
 * pipeline step in its own `try`/`catch` via {@link step}, so a step that
 * throws is logged and treated as "found nothing" rather than crashing the
 * whole tick, and each trusted folder is enqueued in its own `try`/`catch`
 * so one folder's spec-load failure does not stop the rest.
 */
export async function runPollOnce(deps: PollRunDeps): Promise<PollRunSummary> {
  const repos = await reposRepository(deps.db).list();
  // v1 scope note (matching 5.4's): exactly one physical mainRepo.
  const repo = repos[0];
  if (repo === undefined) {
    deps.logger.info({}, 'poll: no repository configured, nothing to scan');
    return EMPTY_SUMMARY;
  }

  const scannedFolders = await step(
    'scan',
    async () => {
      const workspace = await hostGitWorkspace({
        featureId: 'adl-daemon-poll',
        mainRepo: deps.mainRepo,
        scratchRoot: deps.scratchRoot,
        baseRef: repo.default_branch,
      });
      try {
        return await listFeatureFolders(
          managerGitClient(workspace),
          repo.default_branch,
          repo.features_dir,
        );
      } finally {
        await workspace.destroy();
      }
    },
    [] as readonly string[],
    deps.logger,
  );
  if (scannedFolders.length === 0) return EMPTY_SUMMARY;

  const featuresRepo = featuresRepository(deps.db);

  const undeveloped = await step(
    'undeveloped-filter',
    () =>
      undevelopedFeatures({
        scannedFolders,
        featuresDir: repo.features_dir,
        repoId: repo.id,
        featuresRepo,
        forge: deps.forge,
        forgeRepo: deps.forgeRepo,
      }),
    [] as readonly string[],
    deps.logger,
  );
  if (undeveloped.length === 0) return EMPTY_SUMMARY;

  const trustResults = await step(
    'trust-filter',
    () =>
      evaluateFeatureTrust({
        folders: undeveloped,
        featuresDir: repo.features_dir,
        defaultBranch: repo.default_branch,
        forge: deps.forge,
        forgeRepo: deps.forgeRepo,
      }),
    [] as readonly FolderTrustResult[],
    deps.logger,
  );

  const enqueued: string[] = [];
  const rejected: PollRejection[] = [];
  const failures: PollFailure[] = [];

  for (const result of trustResults) {
    if (result.decision.kind === 'untrusted') {
      rejected.push({ folder: result.folder, reason: result.decision.reason });
      deps.logger.warn(
        { folder: result.folder, reason: result.decision.reason },
        'poll: rejected an untrusted feature folder',
      );
      continue;
    }

    try {
      const outcome = await enqueueFeature(
        deps.mainRepo,
        repo,
        featuresRepo,
        result.folder,
      );
      if (outcome === 'enqueued') enqueued.push(result.folder);
    } catch (error) {
      failures.push({ folder: result.folder, error });
      deps.logger.warn(
        { err: error, folder: result.folder },
        'poll: failed to enqueue a trusted feature folder',
      );
    }
  }

  return { enqueued, rejected, failures };
}

export interface PollScheduleHandle {
  stop(): void;
}

/**
 * Start the poll schedule: `runPollOnce` on `deps.intervalMs`'s cadence, via
 * `croner`, matching `gc-schedule.ts`'s `startGcSchedule` exactly — same
 * sub-second-resolution workaround (`pattern: '* * * * * *'` paired with
 * `options.interval`, rounded up from `intervalMs` to the nearest whole
 * second, floored at 1), same `protect: true` re-entrancy guard against a
 * slow pass overlapping the next tick.
 */
export function startPollSchedule(deps: PollScheduleDeps): PollScheduleHandle {
  const intervalSeconds = Math.max(1, Math.round(deps.intervalMs / 1000));

  const job = new Cron(
    '* * * * * *',
    {
      interval: intervalSeconds,
      protect: true,
      catch: (error: unknown) => {
        deps.logger.error({ err: error }, 'poll schedule tick failed');
      },
    },
    async () => {
      await runPollOnce(deps);
    },
  );

  return {
    stop: () => job.stop(),
  };
}
