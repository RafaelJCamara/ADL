// This suite proves success criterion 4 the way it is WORDED — "the same
// feature on the same commit receives the same prompt twice running" — by
// comparing two real attempts' PERSISTED artifacts, never by calling
// `buildDeveloperPrompt` twice in one process. A same-process comparison
// cannot catch the failures that matter here: a value captured at module
// load, a path that differs by working directory, or an environment
// variable that happens to be identical within one process. Launching a
// real second Node process (below) is the same reasoning
// `build.test.ts`'s own cross-process test already applies to the renderer
// alone; this suite applies it to the full dev-run path.
// eslint-disable-next-line no-restricted-imports -- test-only cross-process determinism proof, mirrors build.test.ts's own precedent
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { migrateToLatest } from '@adl/db';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
  type DaemonConfig,
} from '@adl/core/config';
import {
  findAttempt,
  logsRootFor,
  promptArtifactPathFor,
  startDaemon,
  type DaemonHandle,
} from '../../src/index.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * Phase 4 Plan 09, Task 3: two real runs, one commit, byte-identical
 * persisted prompts — with a negative control proving the assertion has
 * teeth.
 */

const RUN_DEV_RUN_ONCE_SCRIPT = fileURLToPath(
  new URL('../helpers/run-dev-run-once.mjs', import.meta.url),
);
const FAKE_CLAUDE_SUCCESS = fileURLToPath(
  new URL('../helpers/fake-claude-success.mjs', import.meta.url),
);
const TRACER_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/tracer-worker-entry.ts', import.meta.url),
);
/** The repository root — four levels up from this file (`packages/manager/test/prompt/`). */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
/**
 * Two genuinely different, real directories to run the two child processes
 * from below — NOT the temp repositories themselves: `--import tsx`
 * resolves the loader package by walking up from the child's own `cwd`,
 * and a temp directory outside this repository's tree never reaches the
 * `node_modules` that loader lives in, so a truly arbitrary external `cwd`
 * cannot run this suite's own scripted double at all. Two distinct sibling
 * package directories are still two genuinely different `process.cwd()`
 * values — sufficient to catch a `process.cwd()`-derived bug — while both
 * remain inside the tree `tsx` resolves from.
 */
const WORKING_DIR_A = join(REPO_ROOT, 'packages', 'agent-claude-code');
const WORKING_DIR_B = join(REPO_ROOT, 'packages', 'workspace');

const SPEC_MARKDOWN = `# Title

Widget export

## Acceptance Criteria

- The export button appears on the widget page.
- Clicking it downloads a \`.widget\` file.
`;

const DIFFERENT_SPEC_MARKDOWN = `# Title

Widget import

## Acceptance Criteria

- The import button appears on the widget page.
`;

async function waitUntil<T>(
  predicate: () => T | undefined | Promise<T | undefined>,
  { timeoutMs = 10_000, intervalMs = 15 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitUntil: condition was not satisfied within ${timeoutMs}ms`,
      );
    }
    await delay(intervalMs);
  }
}

/**
 * The first differing byte offset between two buffers, or `undefined` when
 * they are identical — used so a failing assertion NAMES what differed
 * rather than reporting only that two hashes (or two buffers) differ, per
 * this task's own acceptance criteria.
 */
function firstDifference(a: Buffer, b: Buffer): string | undefined {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      const start = Math.max(0, i - 30);
      const aSlice = a
        .subarray(start, Math.min(a.length, i + 30))
        .toString('utf8');
      const bSlice = b
        .subarray(start, Math.min(b.length, i + 30))
        .toString('utf8');
      return (
        `first differing byte at offset ${String(i)}\n` +
        `  a: ...${aSlice}...\n` +
        `  b: ...${bSlice}...`
      );
    }
  }
  if (a.length !== b.length) {
    return (
      `byte-identical up to offset ${String(len)}, then length differs: ` +
      `a.length=${String(a.length)}, b.length=${String(b.length)}`
    );
  }
  return undefined;
}

function expectByteIdentical(a: Buffer, b: Buffer): void {
  const region = firstDifference(a, b);
  expect(region, region ?? 'byte-identical').toBeUndefined();
}

/**
 * A bare temp SQLite file PATH — no connection opened in this process. For
 * the cross-process test below, where a CHILD process is the sole owner of
 * the database connection lifecycle for that file; see the call site's own
 * comment for why `withTempDb` (which opens a connection here too) is the
 * wrong tool for that specific test.
 */
async function withTempDbPath<T>(
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'adl-determinism-db-'));
  try {
    return await fn(join(dir, 'adl.db'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeFeature(
  mainRepo: string,
  featureId: string,
  specMarkdown: string,
): Promise<void> {
  const dir = join(mainRepo, 'features', featureId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'spec.md'), specMarkdown, 'utf8');
}

function daemonConfigFixture(defaultBranch: string): DaemonConfig {
  return DaemonConfigSchema.parse({
    // Default `concurrency.global` is 1 — this suite dispatches TWO features
    // against one daemon in quick succession (deliberately, to prove the
    // second run's artifact matches the first without waiting for the
    // first's worker to fully exit and release its lease slot), which the
    // default cap would refuse with a 409 the moment the second POST landed
    // while the first attempt was still in flight.
    concurrency: { global: 2 },
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
}

function adlYmlFixture(): AdlYml {
  return AdlYmlSchema.parse({
    version: 1,
    commands: {
      build: { argv: ['true'] },
      start: { argv: ['true'] },
      test: { argv: ['true'] },
      teardown: { argv: ['true'] },
    },
    pipeline: ['develop'],
  });
}

async function startFixtureDaemon(
  dbFilePath: string,
  mainRepo: string,
  scratchRoot: string,
  defaultBranch: string,
  apiToken: string,
): Promise<DaemonHandle> {
  return startDaemon({
    dbFilePath,
    port: 0,
    apiToken,
    migrationsDir: MIGRATIONS_DIR,
    leaseTtlMs: 10_000,
    heartbeatIntervalMs: 100,
    daemonConfig: daemonConfigFixture(defaultBranch),
    resolveAdlYml: () => adlYmlFixture(),
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
}

async function dispatchAndReadArtifact(
  db: Parameters<typeof findAttempt>[0],
  daemonUrl: string,
  apiToken: string,
  logsRoot: string,
  featureId: string,
): Promise<Buffer> {
  const response = await fetch(`${daemonUrl}/dev-run/${featureId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (response.status !== 200) {
    const text = await response.text();
    throw new Error(
      `dev-run POST for ${featureId} failed: ${String(response.status)} ${text}`,
    );
  }
  const body = (await response.json()) as { stageAttemptId: string };

  const address = await waitUntil(() => findAttempt(db, body.stageAttemptId));
  const artifactPath = promptArtifactPathFor(logsRoot, address);
  await waitUntil(() => (existsSync(artifactPath) ? true : undefined));
  return readFile(artifactPath);
}

describe('determinism: two real runs, one commit, byte-identical prompt artifacts (success criterion 4)', () => {
  it('runs two features carrying BYTE-IDENTICAL spec content against one daemon on one commit, with real wall-clock time elapsing between them, and their prompt artifacts are byte-identical', async () => {
    // Two DIFFERENT feature ids rather than re-dispatching one feature
    // twice: `POST /dev-run/:featureId` refuses a feature whose state is
    // no longer `'queued'` (`dev-run.ts`), and nothing in this phase moves
    // a feature back to `'queued'` after its first attempt — that is
    // Phase 5's loop runner. `NormalizedSpec.id` (the folder name) never
    // reaches `buildDeveloperPrompt`'s rendered output (verified
    // independently in `build.test.ts`), so two features carrying
    // byte-identical spec content are the faithful stand-in for "the same
    // feature, run twice" this phase's own tooling can produce today.
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
        const featureA = `feat-a-${ulid()}`;
        const featureB = `feat-b-${ulid()}`;
        await writeFeature(mainRepo, featureA, SPEC_MARKDOWN);
        await writeFeature(mainRepo, featureB, SPEC_MARKDOWN);
        await git.add('features');
        await git.raw(['commit', '-m', 'add both features, identical content']);
        const defaultBranch = (
          await git.raw(['branch', '--show-current'])
        ).trim();

        const apiToken = `test-token-${ulid()}`;
        const handle = await startFixtureDaemon(
          filePath,
          mainRepo,
          scratchRoot,
          defaultBranch,
          apiToken,
        );
        try {
          const logsRoot = logsRootFor(filePath);
          const daemonUrl = `http://127.0.0.1:${String(handle.port)}`;

          const first = await dispatchAndReadArtifact(
            db,
            daemonUrl,
            apiToken,
            logsRoot,
            featureA,
          );

          // Real wall-clock time elapses between the two runs — not a
          // faked/advanced clock (which would also skew the shared
          // in-process daemon's own SQLite timestamps, lease timing, and
          // reaper schedule). Nothing in the render path reads a clock at
          // all (`build.ts`'s own docblock), so genuinely letting time
          // pass is what this criterion asks for and proves it honestly.
          await delay(120);

          const second = await dispatchAndReadArtifact(
            db,
            daemonUrl,
            apiToken,
            logsRoot,
            featureB,
          );

          expectByteIdentical(first, second);
        } finally {
          await handle.stop();
        }
      });
    });
  }, 30_000);

  it('a distinctive environment variable set only for the second run does not change the artifact', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
        const featureA = `feat-a-${ulid()}`;
        const featureB = `feat-b-${ulid()}`;
        await writeFeature(mainRepo, featureA, SPEC_MARKDOWN);
        await writeFeature(mainRepo, featureB, SPEC_MARKDOWN);
        await git.add('features');
        await git.raw(['commit', '-m', 'add both features, identical content']);
        const defaultBranch = (
          await git.raw(['branch', '--show-current'])
        ).trim();

        const apiToken = `test-token-${ulid()}`;
        const handle = await startFixtureDaemon(
          filePath,
          mainRepo,
          scratchRoot,
          defaultBranch,
          apiToken,
        );
        const envVarName = 'ADL_TEST_DETERMINISM_ENV_MARKER';
        const previous = process.env[envVarName];
        try {
          const logsRoot = logsRootFor(filePath);
          const daemonUrl = `http://127.0.0.1:${String(handle.port)}`;

          const first = await dispatchAndReadArtifact(
            db,
            daemonUrl,
            apiToken,
            logsRoot,
            featureA,
          );

          process.env[envVarName] = 'ADL-DISTINCTIVE-VALUE-7f3c9a';
          const second = await dispatchAndReadArtifact(
            db,
            daemonUrl,
            apiToken,
            logsRoot,
            featureB,
          );

          expectByteIdentical(first, second);
          expect(second.toString('utf8')).not.toContain(
            'ADL-DISTINCTIVE-VALUE-7f3c9a',
          );
        } finally {
          if (previous === undefined) delete process.env[envVarName];
          else process.env[envVarName] = previous;
          await handle.stop();
        }
      });
    });
  }, 30_000);

  it('the NEGATIVE CONTROL: a changed spec changes the artifact, so a constant-returning renderer could not pass the assertions above', async () => {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
        const featureA = `feat-a-${ulid()}`;
        const featureB = `feat-b-${ulid()}`;
        await writeFeature(mainRepo, featureA, SPEC_MARKDOWN);
        await writeFeature(mainRepo, featureB, DIFFERENT_SPEC_MARKDOWN);
        await git.add('features');
        await git.raw([
          'commit',
          '-m',
          'add two features with DIFFERENT content',
        ]);
        const defaultBranch = (
          await git.raw(['branch', '--show-current'])
        ).trim();

        const apiToken = `test-token-${ulid()}`;
        const handle = await startFixtureDaemon(
          filePath,
          mainRepo,
          scratchRoot,
          defaultBranch,
          apiToken,
        );
        try {
          const logsRoot = logsRootFor(filePath);
          const daemonUrl = `http://127.0.0.1:${String(handle.port)}`;

          const first = await dispatchAndReadArtifact(
            db,
            daemonUrl,
            apiToken,
            logsRoot,
            featureA,
          );
          const second = await dispatchAndReadArtifact(
            db,
            daemonUrl,
            apiToken,
            logsRoot,
            featureB,
          );

          expect(firstDifference(first, second)).toBeDefined();
          expect(first.equals(second)).toBe(false);
        } finally {
          await handle.stop();
        }
      });
    });
  }, 30_000);

  it('the same feature content run under TWO SEPARATE daemon PROCESSES, started from different working directories, produces byte-identical artifacts', async () => {
    // Two independent repositories (rather than one shared one) so the
    // two processes share NO state at all beyond the feature content
    // itself — the strongest form of "the same feature on the same
    // commit", since there is no possibility of the second process
    // observing anything the first process's run left behind.
    await withTempRepo(
      async ({ mainRepo: mainRepoA, scratchRoot: scratchRootA, git: gitA }) => {
        await writeFeature(mainRepoA, 'export-widget', SPEC_MARKDOWN);
        await gitA.add('features');
        await gitA.raw(['commit', '-m', 'add export-widget']);
        const defaultBranchA = (
          await gitA.raw(['branch', '--show-current'])
        ).trim();

        await withTempRepo(
          async ({
            mainRepo: mainRepoB,
            scratchRoot: scratchRootB,
            git: gitB,
          }) => {
            await writeFeature(mainRepoB, 'export-widget', SPEC_MARKDOWN);
            await gitB.add('features');
            await gitB.raw(['commit', '-m', 'add export-widget']);
            const defaultBranchB = (
              await gitB.raw(['branch', '--show-current'])
            ).trim();

            // A bare temp FILE PATH — deliberately not `withTempDb`, which
            // opens its own live connection in THIS (parent) process. Each
            // child process below is the sole owner of its own database
            // connection lifecycle; a redundant parent-side connection to the
            // same file left open for the child's whole lifetime is what
            // produced an EBUSY on Windows teardown when this test first ran.
            await withTempDbPath(async (dbA) => {
              await withTempDbPath(async (dbB) => {
                const configA = {
                  dbFilePath: dbA,
                  mainRepo: mainRepoA,
                  scratchRoot: scratchRootA,
                  featureId: 'export-widget',
                  defaultBranch: defaultBranchA,
                  apiToken: `test-token-${ulid()}`,
                };
                const configB = {
                  dbFilePath: dbB,
                  mainRepo: mainRepoB,
                  scratchRoot: scratchRootB,
                  featureId: 'export-widget',
                  defaultBranch: defaultBranchB,
                  apiToken: `test-token-${ulid()}`,
                };

                // Two genuinely different working directories: the repos
                // themselves, on opposite sides of the comparison — proving a
                // working-directory-derived path cannot hide as "the same
                // value in both runs" (see `build.ts`'s own note on why
                // `process.cwd()` is never used for the template path).
                const rawA = execFileSync(
                  process.execPath,
                  [
                    '--import',
                    'tsx',
                    RUN_DEV_RUN_ONCE_SCRIPT,
                    JSON.stringify(configA),
                  ],
                  {
                    encoding: 'utf8',
                    cwd: WORKING_DIR_A,
                    env: { ...process.env },
                  },
                );
                const rawB = execFileSync(
                  process.execPath,
                  [
                    '--import',
                    'tsx',
                    RUN_DEV_RUN_ONCE_SCRIPT,
                    JSON.stringify(configB),
                  ],
                  {
                    encoding: 'utf8',
                    cwd: WORKING_DIR_B,
                    env: { ...process.env },
                  },
                );

                const bytesA = Buffer.from(rawA.trim(), 'base64');
                const bytesB = Buffer.from(rawB.trim(), 'base64');

                expectByteIdentical(bytesA, bytesB);
              });
            });
          },
        );
      },
    );
  }, 60_000);
});
