/**
 * The tester's tests are committed (ROLE-09, M08 step 8.6), end to end.
 *
 * A real daemon builds and starts a real app, composes the tester's code-blind
 * workspace, dispatches the tester into it, runs the suite ADL itself owns —
 * and then ADL carries the test the tester wrote back into the developer's
 * worktree, commits it under its own identity, and pushes it to the branch the
 * change request is opened from. Three runs, each proving one property of the
 * criterion "the tester's tests land in the repository as permanent regression
 * coverage the team owns, in a demarcated location":
 *
 * 1. **They land on the change request's branch.** Through a real forge (a mock
 *    GitHub server) and a real bare remote, so "on the branch" means pushed, not
 *    merely committed on this machine — 5.10's constraint for ADL's commit as
 *    for the developer's.
 * 2. **They are re-run, which is what makes them regression tests.** A test
 *    that fails the first time ADL runs it sends the feature back; round 2's
 *    developer fixes nothing in the test, the SAME committed test runs again,
 *    passes, and the round goes green with no second tester commit.
 * 3. **The developer cannot touch them.** Round 2's developer appends to the
 *    committed test, and ROLE-11 escalates — with no `protected_paths`
 *    configured, because `owned_dir` is always protected.
 *
 * Evidence comes from outside ADL wherever it can: the tester double's own
 * report, a witness file only the suite's declared env names, a counter file
 * the test itself keeps, and `git` run against the remote directly.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import type { Kysely } from 'kysely';
import { featuresRepository, migrateToLatest, type Database } from '@adl/db';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
  type DaemonConfig,
} from '@adl/core/config';
import { branchNameFor } from '@adl/workspace';
import { githubForgeAdapter } from '@adl/forge-github';
import { startDaemon } from '../../src/index.js';
import { composeBranchFeatureId } from '../../src/branch-identity.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import { startMockGithubServer } from '../../../forge-github/test/helpers/mock-github-server.js';
import { throwawayPrivateKeyPem } from '../../../forge-github/test/helpers/throwaway-key.js';

const API_TOKEN = `test-token-${ulid()}`;
const FORGE_REPO = { owner: 'adl-demo-org', repo: 'demo-repo' };
const TRACER_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/tracer-worker-entry.ts', import.meta.url),
);
const FAKE_CLAUDE_TESTER = fileURLToPath(
  new URL('../helpers/fake-claude-tester.mjs', import.meta.url),
);
const APP_START = fileURLToPath(
  new URL('../helpers/app-under-test-start.mjs', import.meta.url),
);

const OWNED_DIR = 'tests/behaviour';
const TEST_PATH = `${OWNED_DIR}/health.test.mjs`;

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 150_000, intervalMs = 50 } = {},
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

interface Run {
  readonly db: Kysely<Database>;
  readonly featureId: string;
  readonly branch: string;
  readonly state: string;
  readonly rounds: readonly {
    readonly outcome: string | null;
    readonly outcome_json: string | null;
    readonly head_sha: string | null;
    readonly vouched_sha: string | null;
  }[];
  /** `git` against the main repository (which shares the worktree's refs). */
  git(args: readonly string[]): Promise<string>;
  /** `git` against the bare remote, when a forge was configured. */
  remote(args: readonly string[]): Promise<string>;
  readonly witness: string;
  readonly counter: string;
}

/**
 * One feature through a real daemon, the tester writing a real test into its
 * owned directory. `developerEdits` makes round 2's developer append to the
 * committed test; `writes` picks the test the tester writes.
 */
async function runFeature(
  options: {
    readonly writes: 'by-title' | 'fail-first';
    readonly developerEdits?: boolean;
    readonly settle: (state: string) => boolean;
  },
  assertions: (run: Run) => Promise<void>,
): Promise<void> {
  const githubServer = await startMockGithubServer();
  try {
    await withTempDb(async ({ db, filePath }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
        const folder = `kept-${ulid()}`;
        const featureDir = `features/${folder}`;
        await mkdir(join(mainRepo, featureDir), { recursive: true });
        await mkdir(join(mainRepo, 'tests'), { recursive: true });
        await writeFile(
          join(mainRepo, featureDir, 'spec.md'),
          '# Health\n\nThe app reports its health.\n\n' +
            '## Acceptance Criteria\n\n- It answers /health with 200.\n',
          'utf8',
        );
        // A test the tester can see and does not own — it must not land in
        // ADL's commit, and must not run.
        await writeFile(
          join(mainRepo, 'tests', 'existing.test.mjs'),
          "import { test } from 'node:test';\ntest('not the tester’s', () => {});\n",
          'utf8',
        );
        await git.add('.');
        await git.raw(['commit', '-m', 'add feature']);
        const defaultBranch = (
          await git.raw(['branch', '--show-current'])
        ).trim();

        const outside = join(scratchRoot, '..');
        const pidPath = join(outside, `pids-${folder}.json`);
        const witness = join(outside, `witness-${folder}`);
        const counter = join(outside, `counter-${folder}`);

        const adlYml: AdlYml = AdlYmlSchema.parse({
          version: 1,
          // Deliberately NO protected_paths: the owned directory is protected
          // regardless, which is the point of making it always-on.
          commands: {
            build: { argv: ['true'] },
            start: {
              argv: [process.execPath, APP_START, pidPath],
              env: { PORT: '${ADL_PORT}' },
              ready: {
                kind: 'http',
                url: 'http://127.0.0.1:${ADL_PORT}/health',
                expect: 200,
              },
              ready_timeout: '60s',
            },
            test: { argv: ['true'] },
            teardown: { argv: ['true'] },
          },
          pipeline: [
            'develop',
            {
              harness: 'behaviour',
              visible_paths: ['tests/**'],
              needs_app: true,
              owned_dir: OWNED_DIR,
              with: {
                suite: {
                  command: {
                    argv: [process.execPath, '--test', '--test-reporter=tap'],
                    env: {
                      APP_URL: 'http://127.0.0.1:${ADL_PORT}',
                      ADL_85_WITNESS: witness,
                      ADL_86_COUNTER: counter,
                    },
                    timeout: '60s',
                  },
                  emits: 'tap',
                },
              },
            },
          ],
        });

        const daemonConfig: DaemonConfig = DaemonConfigSchema.parse({
          limits: { max_rounds: 3 },
          repos: [
            {
              id: 'repo-1',
              remote_url: 'https://github.com/adl-demo-org/demo-repo.git',
              default_branch: defaultBranch,
              forge: 'github',
              features_dir: 'features',
            },
          ],
        });

        const forge = githubForgeAdapter({
          appId: 'adl-tracer-app',
          privateKey: throwawayPrivateKeyPem(),
          installationId: 1,
          baseUrl: githubServer.url,
          disablePacingForTests: true,
        });
        const bareRemote = join(outside, `origin-${folder}.git`);
        await mkdir(bareRemote, { recursive: true });
        await git.raw(['-C', bareRemote, 'init', '--bare']);

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
              FAKE_CLAUDE_TESTER,
              '--adl-tester-writes',
              options.writes,
              ...(options.developerEdits === true
                ? ['--adl-developer-edits', TEST_PATH]
                : []),
            ]),
          },
          dispatchIntervalMs: 20,
          forge: {
            adapter: forge,
            repo: FORGE_REPO,
            pushCredential: async () => bareRemote,
          },
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

          let state = '';
          await waitUntil(async () => {
            state =
              (await featuresRepository(db).findById(featureId))?.state ?? '';
            return options.settle(state);
          });

          const rounds = await db
            .selectFrom('rounds')
            .select(['outcome', 'outcome_json', 'head_sha', 'vouched_sha'])
            .where('feature_id', '=', featureId)
            .orderBy('number')
            .execute();

          await assertions({
            db,
            featureId,
            branch: branchNameFor(composeBranchFeatureId(folder, featureId)),
            state,
            rounds,
            git: async (args) => (await git.raw([...args])).trim(),
            remote: async (args) =>
              (await git.raw(['-C', bareRemote, ...args])).trim(),
            witness,
            counter,
          });
        } finally {
          await handle.stop();
          await delay(250);
        }
      });
    });
  } finally {
    await githubServer.close();
  }
}

/** Every line of a file, or none when it does not exist. */
async function linesOf(path: string): Promise<string[]> {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter((l) => l !== '');
  } catch {
    return [];
  }
}

describe('scenario: the tester’s tests are committed (ROLE-09)', () => {
  it(
    'lands the tester’s test on the change request’s branch, as ADL, on top of the developer’s commit',
    { timeout: 300_000 },
    async () => {
      await runFeature(
        {
          writes: 'by-title',
          settle: (state) => state === 'pr_open' || state === 'escalated',
        },
        async (run) => {
          expect(run.state).toBe('pr_open');
          expect(run.rounds.map((round) => round.outcome)).toEqual(['green']);

          // On the REMOTE branch — pushed from inside the worker, not just
          // committed on this machine.
          const tip = await run.remote([
            'rev-parse',
            `refs/heads/${run.branch}`,
          ]);
          const tree = (
            await run.remote(['ls-tree', '-r', '--name-only', tip])
          ).split('\n');
          expect(tree).toContain(TEST_PATH);
          expect(tree.some((path) => path.startsWith('.adl/'))).toBe(false);

          // ADL's own commit, sitting directly on the developer's.
          const [author, parent] = (
            await run.remote(['log', '-1', '--format=%an <%ae>%n%P', tip])
          ).split('\n');
          expect(author).toBe('ADL <adl@noreply.local>');
          expect(parent).toBe(run.rounds[0]?.head_sha);
          // Exactly the tester's file — not the test it could see but did not
          // own, not the verdict file, not anything else in its workspace.
          expect(
            (
              await run.remote(['show', '--name-status', '--format=', tip])
            ).split('\n'),
          ).toEqual([`A\t${TEST_PATH}`]);
          // The committed bytes are what ran: the test appends to the witness,
          // which only the suite's env names, exactly once — and the decoy
          // outside the owned directory did not run at all (D-8-05-3).
          expect(await linesOf(run.witness)).toHaveLength(1);

          // And ADL vouches for its own commit, so the next developer is never
          // blamed for it (D-8-A-1).
          expect(run.rounds[0]?.vouched_sha).toBe(tip);
        },
      );
    },
  );

  it(
    're-runs a committed failing test in the next round, unchanged, until it passes',
    { timeout: 300_000 },
    async () => {
      await runFeature(
        {
          writes: 'fail-first',
          settle: (state) => state === 'pr_open' || state === 'escalated',
        },
        async (run) => {
          // Round 1's suite failed the test and sent the feature back; round 2
          // ran the SAME committed test again and it passed.
          expect(run.rounds.map((round) => round.outcome)).toEqual([
            'send_back',
            'green',
          ]);
          expect(run.state).toBe('pr_open');
          expect(await linesOf(run.witness)).toHaveLength(2);
          expect((await readFile(run.counter, 'utf8')).trim()).toBe('2');

          // One ADL commit in the whole history: round 1's. Round 2's tester
          // re-wrote the identical file, and identical is not a commit.
          const authors = (
            await run.remote([
              'log',
              '--format=%an',
              `refs/heads/${run.branch}`,
            ])
          ).split('\n');
          expect(authors.filter((name) => name === 'ADL')).toHaveLength(1);
        },
      );
    },
  );

  it(
    'escalates a developer that edits a committed test, with no protected_paths configured',
    { timeout: 300_000 },
    async () => {
      await runFeature(
        {
          writes: 'fail-first',
          developerEdits: true,
          settle: (state) => state === 'escalated' || state === 'pr_open',
        },
        async (run) => {
          expect(run.state).toBe('escalated');
          expect(run.rounds.map((round) => round.outcome)).toEqual([
            'send_back',
            'escalate',
          ]);
          const reason = (
            JSON.parse(run.rounds[1]?.outcome_json ?? '{}') as {
              reason?: string;
            }
          ).reason;
          expect(reason).toContain(TEST_PATH);
          expect(reason).toContain('owned_dir');
          // Round 1's ADL commit IS vouched for — round 1's vouched tip moved
          // from the developer's commit to ADL's, and only ADL's (its author is
          // ADL's identity). That is what keeps it out of what round 2's
          // developer is judged on; the escalation above is the developer's
          // own edit.
          const adlCommit = await run.git([
            'log',
            '-1',
            '--format=%H',
            '--author=adl@noreply.local',
            run.branch,
          ]);
          expect(adlCommit).toMatch(/^[0-9a-f]{40}$/);
          expect(run.rounds[0]?.vouched_sha).toBe(adlCommit);
          expect(run.rounds[0]?.vouched_sha).not.toBe(run.rounds[0]?.head_sha);

          // The tester never ran in round 2: the violation ends the round at
          // the developer's commit.
          expect(await linesOf(run.witness)).toHaveLength(1);
        },
      );
    },
  );
});
