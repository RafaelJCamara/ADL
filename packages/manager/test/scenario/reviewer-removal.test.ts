import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { featuresRepository, migrateToLatest } from '@adl/db';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
  type DaemonConfig,
} from '@adl/core/config';
import { startDaemon } from '../../src/index.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * HARN-04's negative half (M07 step 7.9): **removing the reviewer from
 * configuration removes it from the pipeline, exactly like a third party's
 * gate.**
 *
 * Every other test in this milestone proves the reviewer *works*. A reviewer
 * that had quietly become special-cased — a branch keyed on `stageId ===
 * 'review'`, an unconditional dispatch, a lifecycle state that assumes it —
 * would pass all of them and fail only this one, which is why criterion 2 asks
 * for the removal rather than the addition.
 *
 * ## What makes this a proof rather than a demonstration
 *
 * Two runs, in one file, against **one** `adlYml()` builder and **one**
 * `runFeature()` helper. Everything is identical — the same daemon options, the
 * same `claude` double, the same spec, the same commands — except the argument
 * naming the pipeline. The diff between the two runs is one array element in
 * this file's source and nothing else, which is the literal content of "with no
 * code written".
 *
 * The reviewer's absence is asserted mechanically rather than by inspection.
 * The double (`fake-claude-role-switch.mjs`) writes a report file **only** when
 * it is launched as the reviewer, so the file's existence is a direct
 * observation of whether ADL ever started one: it is there in the control run
 * and absent in the removal run, and no assertion here has to trust ADL's own
 * bookkeeping to know that.
 *
 * ## Why `test` stays in both pipelines
 *
 * A `['develop']` pipeline reaches `aggregate([])`, which escalates — "the
 * pipeline ran zero gates, so nothing was verified" — so a removal run with no
 * gate at all would prove the reviewer's absence by breaking the feature. What
 * a repository actually does is delete one entry from a pipeline that has
 * others, and both runs here reach a pull request.
 */

const API_TOKEN = `test-token-${ulid()}`;
const TRACER_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/tracer-worker-entry.ts', import.meta.url),
);
const FAKE_CLAUDE_ROLE_SWITCH = fileURLToPath(
  new URL('../helpers/fake-claude-role-switch.mjs', import.meta.url),
);

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 60_000, intervalMs = 25 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitUntil: condition was not satisfied within ${String(timeoutMs)}ms`,
      );
    }
    await delay(intervalMs);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface RunResult {
  readonly featureId: string;
  /** Every stage id that produced an attempt, in order. */
  readonly stageIds: readonly string[];
  /** Whether the double was ever launched as the reviewer. */
  readonly reviewerRan: boolean;
  /** Every `stageId` any lifecycle event named. */
  readonly eventStageIds: readonly string[];
}

/**
 * Run one feature to completion under `pipeline`, and report what happened.
 *
 * The single knob is `pipeline`. Everything else — daemon config, worker entry,
 * the `claude` double, the spec, the four lifecycle commands — is fixed here so
 * the two cases below cannot differ in anything the assertions might be reading.
 */
async function runFeature(pipeline: readonly unknown[]): Promise<RunResult> {
  return withTempDb(async ({ db, filePath }) => {
    await migrateToLatest(db, MIGRATIONS_DIR);

    return withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const folder = `removal-${ulid()}`;
      const featureDir = `features/${folder}`;
      await mkdir(join(mainRepo, featureDir), { recursive: true });
      await writeFile(
        join(mainRepo, featureDir, 'spec.md'),
        '# Exportable report\n\nA feature.\n\n## Acceptance Criteria\n\n- The export button appears.\n',
        'utf8',
      );
      await git.add(`${featureDir}/spec.md`);
      await git.raw(['commit', '-m', 'add feature']);
      const defaultBranch = (
        await git.raw(['branch', '--show-current'])
      ).trim();

      // Written only when the double is launched as the reviewer — see this
      // file's docblock. Outside the worktree so a teardown cannot remove it,
      // which would make "the reviewer never ran" indistinguishable from "the
      // evidence was cleaned up".
      const reviewerReport = join(scratchRoot, '..', 'reviewer-report.json');

      const adlYml: AdlYml = AdlYmlSchema.parse({
        version: 1,
        commands: {
          build: { argv: [process.execPath, '-e', 'process.exit(0)'] },
          start: { argv: [process.execPath, '-e', 'process.exit(0)'] },
          test: { argv: [process.execPath, '-e', 'process.exit(0)'] },
          teardown: { argv: [process.execPath, '-e', 'process.exit(0)'] },
        },
        pipeline,
      });

      const daemonConfig: DaemonConfig = DaemonConfigSchema.parse({
        repos: [
          {
            id: 'repo-1',
            remote_url: 'https://example.invalid/repo.git',
            default_branch: defaultBranch,
            forge: 'github',
            features_dir: 'features',
          },
        ],
      });

      const handle = await startDaemon({
        dbFilePath: filePath,
        port: 0,
        apiToken: API_TOKEN,
        migrationsDir: MIGRATIONS_DIR,
        leaseTtlMs: 60_000,
        heartbeatIntervalMs: 500,
        daemonConfig,
        resolveAdlYml: () => adlYml,
        mainRepo,
        scratchRoot,
        workerEntryPath: TRACER_WORKER_ENTRY,
        workerExecArgv: ['--import', 'tsx'],
        workerEnv: {
          ADL_TRACER_CLAUDE_BINARY_JSON: JSON.stringify([
            process.execPath,
            FAKE_CLAUDE_ROLE_SWITCH,
            '--adl-reviewer-report',
            reviewerReport,
          ]),
        },
        dispatchIntervalMs: 20,
      });

      try {
        const response = await fetch(
          `http://127.0.0.1:${handle.port}/dev-run/${folder}`,
          { method: 'POST', headers: { Authorization: `Bearer ${API_TOKEN}` } },
        );
        expect(response.status).toBe(200);
        const { featureId } = (await response.json()) as { featureId: string };

        // Both pipelines are expected to reach a pull request. That is half the
        // point: removing the reviewer must not break the feature.
        await waitUntil(async () => {
          const row = await featuresRepository(db).findById(featureId);
          return row?.state === 'publishing';
        });

        const attempts = await db
          .selectFrom('stage_attempts')
          .innerJoin('rounds', 'rounds.id', 'stage_attempts.round_id')
          .select(['stage_attempts.stage_id', 'stage_attempts.stage_index'])
          .where('rounds.feature_id', '=', featureId)
          .orderBy('stage_attempts.stage_index')
          .execute();

        const events = await db
          .selectFrom('feature_events')
          .select(['event_json'])
          .where('feature_id', '=', featureId)
          .orderBy('seq')
          .execute();

        return {
          featureId,
          stageIds: attempts.map((row) => row.stage_id),
          reviewerRan: await exists(reviewerReport),
          eventStageIds: events.flatMap((row) => {
            const event = JSON.parse(row.event_json) as { stageId?: unknown };
            return typeof event.stageId === 'string' ? [event.stageId] : [];
          }),
        };
      } finally {
        await handle.stop();
      }
    });
  });
}

describe('scenario: removing the reviewer from configuration removes it from the pipeline (HARN-04)', () => {
  it(
    'runs the reviewer when the pipeline names it',
    { timeout: 180_000 },
    async () => {
      // The control. Without it, the removal case below would pass just as well
      // against a build where the reviewer never runs at all.
      const run = await runFeature(['develop', 'review', 'test']);

      expect(run.stageIds).toEqual(['develop', 'review', 'test']);
      expect(run.reviewerRan).toBe(true);
      // The reviewer is deliberately not last. `completeWith` emits
      // `all_gates_passed`, which carries no stage id, so a green LAST gate
      // leaves no stage-named event behind at all — and the removal case's
      // "no `review` event" assertion would then be true of a build that ran
      // the reviewer perfectly.
      expect(run.eventStageIds).toContain('review');
    },
  );

  it(
    'runs the same feature to a pull request with the reviewer deleted, and no code changed',
    { timeout: 180_000 },
    async () => {
      // The control's pipeline with the `review` entry deleted, and that is
      // the entire difference between the two runs.
      const run = await runFeature(['develop', 'test']);

      // Reached `publishing` — asserted inside `runFeature`'s own `waitUntil`,
      // which is what it waits for.
      expect(run.stageIds).toEqual(['develop', 'test']);

      // The direct observation: ADL never launched a reviewer. This does not
      // depend on ADL's own bookkeeping being right — the file is written by
      // the external process, or it is not written because there was no
      // process.
      expect(run.reviewerRan).toBe(false);

      // And it left no trace in the lifecycle either. A reviewer that had been
      // special-cased into the state machine could plausibly emit an event for
      // a stage it never ran.
      expect(run.eventStageIds).not.toContain('review');
    },
  );
});
