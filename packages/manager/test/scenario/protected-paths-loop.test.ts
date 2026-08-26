import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
 * ROLE-11 turning the loop off, on purpose (M05 step 5.16).
 *
 * `command-gate-loop.test.ts` is this file's sibling and its precedent: every
 * layer here is production — a real `startDaemon`, the real dispatcher, real
 * forked workers, the **real `createProductionStageRunner`** — with only the
 * `claude` binary replaced (`tracer-worker-entry.ts`'s existing seam). The
 * one difference is what the replaced binary does: `fake-claude-success.mjs`
 * writes a well-behaved commit; `fake-claude-touches-adl-yml.mjs` writes a
 * real commit that ALSO edits `adl.yml` — a developer touching its own gate
 * configuration, the exact shape ROLE-11 exists to catch. Detected by
 * diffing the round's real commit, never by asking the double what it did.
 *
 * `commands.test` here is a command that would prove itself if it ever ran
 * (it appends to a counter file this test owns) and never gets the chance
 * to: the round has to escalate before stage 1 is ever dispatched, which is
 * the structural half of ROLE-11 — unconditional, not a pipeline entry a
 * maintainer has to remember to add.
 */

const API_TOKEN = `test-token-${ulid()}`;
const TRACER_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/tracer-worker-entry.ts', import.meta.url),
);
const FAKE_CLAUDE_TOUCHES_ADL_YML = fileURLToPath(
  new URL('../helpers/fake-claude-touches-adl-yml.mjs', import.meta.url),
);

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 40_000, intervalMs = 25 } = {},
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

describe('scenario: a developer commit that edits adl.yml hard-fails the round (ROLE-11)', () => {
  it(
    'escalates on round 1, never dispatching the gate at all',
    { timeout: 120_000 },
    async () => {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          const folder = `protected-path-${ulid()}`;
          const featureDir = `features/${folder}`;
          await mkdir(join(mainRepo, featureDir), { recursive: true });
          await writeFile(
            join(mainRepo, featureDir, 'spec.md'),
            '# Title\n\nDo not edit adl.yml\n\n## Acceptance Criteria\n\n- The gate runs.\n',
            'utf8',
          );
          await git.add(`${featureDir}/spec.md`);
          await git.raw(['commit', '-m', 'add feature']);
          const defaultBranch = (
            await git.raw(['branch', '--show-current'])
          ).trim();

          // A gate that, if it ever ran, would prove itself by incrementing
          // this counter — the negative assertion below is what proves the
          // round never reached it.
          const gateRanMarker = join(scratchRoot, '..', 'gate-ran');

          const adlYml: AdlYml = AdlYmlSchema.parse({
            version: 1,
            commands: {
              build: { argv: ['true'] },
              start: { argv: ['true'] },
              test: {
                argv: [
                  process.execPath,
                  '-e',
                  `require('node:fs').writeFileSync(${JSON.stringify(gateRanMarker)}, 'ran')`,
                ],
              },
              teardown: { argv: ['true'] },
            },
            pipeline: ['develop', 'test'],
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
                FAKE_CLAUDE_TOUCHES_ADL_YML,
              ]),
            },
            dispatchIntervalMs: 20,
          });

          try {
            const response = await fetch(
              `http://127.0.0.1:${handle.port}/dev-run/${folder}`,
              {
                method: 'POST',
                headers: { Authorization: `Bearer ${API_TOKEN}` },
              },
            );
            expect(response.status).toBe(200);
            const { featureId } = (await response.json()) as {
              featureId: string;
            };

            await waitUntil(async () => {
              const row = await featuresRepository(db).findById(featureId);
              return row?.state === 'escalated';
            });

            const rounds = await db
              .selectFrom('rounds')
              .selectAll()
              .where('feature_id', '=', featureId)
              .orderBy('number')
              .execute();

            // One round, hard-failed — never sent back for a second attempt
            // at fixing what is, by construction, not a fixable failure.
            expect(rounds.map((round) => round.outcome)).toEqual(['escalate']);
            expect(rounds[0]?.ended_at).not.toBeNull();

            const outcome = JSON.parse(rounds[0]!.outcome_json!) as {
              kind: string;
              reason: string;
            };
            expect(outcome.kind).toBe('escalate');
            expect(outcome.reason).toContain('adl.yml');

            // The real commit is still on the record — ROLE-11 hard-fails
            // the round, it does not pretend no commit happened.
            expect(rounds[0]?.head_sha).toMatch(/^[0-9a-f]{40}$/);

            // The gate was never dispatched at all: the protected-path check
            // runs unconditionally, before stage 1 — a pipeline that named
            // `test` never got the chance to run it, let alone pass it.
            await expect(readFile(gateRanMarker, 'utf8')).rejects.toThrow(
              /ENOENT/,
            );

            // No draft change request either — nothing was ever published
            // for a feature this hard-failed on round 1.
            const attempts = await db
              .selectFrom('stage_attempts')
              .selectAll()
              .where('round_id', '=', rounds[0]!.id)
              .execute();
            // Only the developer's own attempt ran (index 0) — no attempt
            // exists for the gate at index 1.
            expect(attempts.map((attempt) => attempt.stage_index)).toEqual([0]);
          } finally {
            await handle.stop();
          }
        });
      });
    },
  );
});
