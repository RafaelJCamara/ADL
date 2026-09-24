/**
 * ROLE-06 end to end, observed from outside ADL (M08 step 8.1).
 *
 * `packages/workspace/test/visible/compose.test.ts` proves the composer in
 * isolation. This proves the **wiring**: that a real daemon, dispatching a real
 * forked worker, actually hands a gate declaring `visible_paths` the composed
 * workspace rather than the worktree the developer just committed into.
 *
 * The evidence does not come from ADL's own bookkeeping. The gate is a plain
 * program that walks its own working directory with its own process, tries
 * every git spelling M08 step 8.0's spike proved reads the source back out of a
 * sparse checkout, and writes the lot outside the workspace. If ADL believed it
 * had composed a blind workspace and had not, that file says so — which is
 * exactly the property 7.5 and 7.9 were built around.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { migrateToLatest } from '@adl/db';
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

const API_TOKEN = `test-token-${ulid()}`;
const TRACER_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/tracer-worker-entry.ts', import.meta.url),
);
const FAKE_CLAUDE_SUCCESS = fileURLToPath(
  new URL('../helpers/fake-claude-success.mjs', import.meta.url),
);
const BLIND_GATE_PROBE = fileURLToPath(
  new URL('../helpers/blind-gate-probe.mjs', import.meta.url),
);

/** The string the tester must never be able to reach, by any route. */
const MARKER = 'SECRET_IMPLEMENTATION_MARKER';

interface Report {
  readonly cwd: string;
  readonly files: readonly string[];
  readonly contents: string;
  readonly repositoriesAbove: readonly string[];
}

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

describe('scenario: a gate declaring visible_paths cannot read the implementation', () => {
  it(
    'sees the allowlist it declared, and neither the source on disk nor the source in git',
    { timeout: 180_000 },
    async () => {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          const folder = `blind-${ulid()}`;
          const featureDir = `features/${folder}`;
          await mkdir(join(mainRepo, featureDir), { recursive: true });
          await mkdir(join(mainRepo, 'src'), { recursive: true });
          await mkdir(join(mainRepo, 'tests'), { recursive: true });

          await writeFile(
            join(mainRepo, featureDir, 'spec.md'),
            '# Title\n\nA feature.\n\n## Acceptance Criteria\n\n- It greets.\n',
            'utf8',
          );
          // Committed to the repository, so it is in the object store as well
          // as on disk — which is the half a sparse checkout fails to hide.
          await writeFile(
            join(mainRepo, 'src', 'impl.ts'),
            `export const ${MARKER} = 'the implementation';\n`,
            'utf8',
          );
          await writeFile(
            join(mainRepo, 'tests', 'greet.test.mjs'),
            "import { test } from 'node:test';\ntest('AC-01', () => {});\n",
            'utf8',
          );
          await git.add('.');
          await git.raw(['commit', '-m', 'add feature, implementation, tests']);
          const defaultBranch = (
            await git.raw(['branch', '--show-current'])
          ).trim();

          // Outside every workspace, so teardown cannot take the evidence with
          // it — `two-gate-continue.test.ts`'s own pattern.
          const reportPath = join(
            scratchRoot,
            '..',
            `blind-report-${folder}.json`,
          );

          const adlYml: AdlYml = AdlYmlSchema.parse({
            version: 1,
            commands: {
              build: { argv: ['true'] },
              start: { argv: ['true'] },
              test: { argv: ['true'] },
              teardown: { argv: ['true'] },
            },
            pipeline: [
              'develop',
              {
                harness: 'behaviour',
                with: {
                  command: {
                    argv: [process.execPath, BLIND_GATE_PROBE, reportPath],
                  },
                },
                // The whole subject of this test. `tests/**` and nothing else.
                visible_paths: ['tests/**'],
              },
            ],
          });

          const daemonConfig: DaemonConfig = DaemonConfigSchema.parse({
            limits: { max_rounds: 2 },
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
                FAKE_CLAUDE_SUCCESS,
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
              const rounds = await db
                .selectFrom('rounds')
                .selectAll()
                .where('feature_id', '=', featureId)
                .execute();
              return rounds.some((round) => round.ended_at !== null);
            });

            const report = JSON.parse(
              await readFile(reportPath, 'utf8'),
            ) as Report;

            // ── 1. It got what it declared ──────────────────────────────
            expect(report.files).toContain('tests/greet.test.mjs');

            // ── 2. And the implementation is ABSENT, not forbidden ──────
            expect(report.files.some((f) => f.startsWith('src/'))).toBe(false);
            expect(report.contents).not.toContain(MARKER);

            // ── 3. The developer's own output is gone too ───────────────
            // `fake-claude-success` writes into the worktree and the round
            // commits it. A gate reading the worktree would see it; this one
            // is not reading the worktree.
            expect(report.files).not.toContain('adl-tracer.txt');

            // ── 4. No repository anywhere above it ─────────────────────
            // The assertion a sparse checkout would fail while satisfying 1–3
            // completely: its working tree is clean of the source and its
            // `.git` still points at an object store holding every blob. Git
            // resolves a repository by walking UP, so "no `.git` at or above
            // the gate's own cwd" is that whole class of door, measured by the
            // gate's own process rather than asked of ADL.
            //
            // That git itself then refuses is proven one layer down, where it
            // can be asked without a banned import and before teardown removes
            // the directory: `packages/workspace/test/visible/compose.test.ts`
            // runs the real `cat-file`, `show`, `log` and
            // `sparse-checkout disable`.
            expect(report.repositoriesAbove).toEqual([]);

            // ── 5. And it really was somewhere else ─────────────────────
            // The negative control for the whole file: if the gate had been
            // handed the developer's worktree, every assertion above would be
            // about the wrong directory and this one names which.
            expect(report.cwd.replaceAll('\\', '/')).not.toContain(
              scratchRoot.replaceAll('\\', '/'),
            );
          } finally {
            await handle.stop();
          }
        });
      });
    },
  );
});
