// A real, separate Node PROCESS that starts a real daemon and dispatches one
// `dev-run` against an ALREADY-PREPARED repository (the caller writes the
// feature folder and makes the commit BEFORE spawning this script — see the
// note on git below), then prints the resulting prompt artifact's bytes
// (base64) to stdout. Test infrastructure for `04-09` Task 3's cross-process
// byte-identity proof, in the same spirit as `run-build-once.mjs`'s
// cross-process proof for `buildDeveloperPrompt` alone. This script
// exercises the FULL path (HTTP route -> dispatch -> forked worker -> stage
// runner -> prompt artifact), not just the renderer, so a value that
// differs by PROCESS LIFETIME (not merely by which function is called) — a
// module-level timestamp, a working-directory-derived path — would show up
// here and nowhere in `run-build-once.mjs`.
//
// **Why no git commands live in this file:** `eslint.config.js`'s
// `adl/no-direct-spawn` bans `node:child_process`/`simple-git` everywhere
// outside `packages/workspace/**` and `packages/core/src/**` — the same rule
// `dev-run-end-to-end.test.ts` stays inside by calling `withTempRepo`
// (exempt, `packages/workspace/test/helpers/`) rather than shelling out
// itself. This script plays the same role that test's OWN body does — test
// DRIVER code, not the external agent CLI double (`fake-claude-success.mjs`
// legitimately spawns `git` directly for the opposite reason: it stands in
// for a real vendor CLI ADL does not control). So the caller
// (`determinism.test.ts`) does the repository setup through `withTempRepo`
// and hands this script an already-committed `mainRepo`.
//
// Configuration arrives as a single JSON argument (argv[2]) rather than
// environment variables: this script's own `cwd` is the thing under test
// (invoked with a DELIBERATELY different `cwd` than the repo it operates
// against — see `determinism.test.ts`), and env is a determinism hazard in
// its own right (see `build.ts`'s docblock), so keeping every real input
// off the environment and on an explicit argument is the same "caller
// assembles, nothing implicit" discipline the rest of this phase follows.
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { createDb, migrateToLatest } from '@adl/db';
import { AdlYmlSchema, DaemonConfigSchema } from '@adl/core/config';
import {
  findAttempt,
  logsRootFor,
  promptArtifactPathFor,
  startDaemon,
} from '../../src/index.js';
import { MIGRATIONS_DIR } from '../../../db/test/helpers/temp-db.js';

const TRACER_WORKER_ENTRY = fileURLToPath(
  new URL('./tracer-worker-entry.ts', import.meta.url),
);
const FAKE_CLAUDE_SUCCESS = fileURLToPath(
  new URL('./fake-claude-success.mjs', import.meta.url),
);

async function waitUntil(
  predicate,
  { timeoutMs = 10_000, intervalMs = 15 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result !== undefined && result !== false) return result;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitUntil: condition was not satisfied within ${timeoutMs}ms`,
      );
    }
    await delay(intervalMs);
  }
}

async function main() {
  const config = JSON.parse(process.argv[2]);
  const {
    dbFilePath,
    mainRepo,
    scratchRoot,
    featureId,
    defaultBranch,
    apiToken,
    extraEnv,
  } = config;
  // `mainRepo` already contains the committed `features/<featureId>/`
  // folder — written by the caller through `withTempRepo` before this
  // process was spawned. See the module docblock for why.

  const daemonConfig = DaemonConfigSchema.parse({
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
  const adlYml = AdlYmlSchema.parse({
    version: 1,
    commands: {
      build: { argv: ['true'] },
      start: { argv: ['true'] },
      test: { argv: ['true'] },
      teardown: { argv: ['true'] },
    },
    pipeline: ['develop'],
  });

  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      process.env[key] = value;
    }
  }

  // `startDaemon`'s own `migrationsDir` handles a VERSION MISMATCH against
  // an already-bootstrapped database — it is not the first-bootstrap
  // migration for a database with no `meta` table at all. A truly fresh
  // file needs an explicit `migrateToLatest` first, matching
  // `dev-run-end-to-end.test.ts`'s own precedent (`withTempDb` +
  // `migrateToLatest` before `startDaemon` ever sees the file).
  const db = createDb(dbFilePath);
  await migrateToLatest(db, MIGRATIONS_DIR);

  const handle = await startDaemon({
    dbFilePath,
    port: 0,
    apiToken,
    migrationsDir: MIGRATIONS_DIR,
    leaseTtlMs: 10_000,
    heartbeatIntervalMs: 100,
    // Silenced: pino's default transport writes JSON lines to STDOUT, which
    // would otherwise interleave with the one thing this script's own
    // stdout carries — the base64 artifact bytes the caller decodes. A
    // logger writing anywhere but stdout would be fine too; silent is
    // simplest for a script whose only job is to print one value.
    logger: pino({ level: 'silent' }),
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
      `http://127.0.0.1:${handle.port}/dev-run/${featureId}`,
      { method: 'POST', headers: { Authorization: `Bearer ${apiToken}` } },
    );
    if (response.status !== 200) {
      throw new Error(
        `dev-run POST failed: ${response.status} ${await response.text()}`,
      );
    }
    const body = await response.json();

    const address = await waitUntil(async () => {
      const resolved = await findAttempt(db, body.stageAttemptId);
      return resolved;
    });

    const logsRoot = logsRootFor(dbFilePath);
    const artifactPath = promptArtifactPathFor(logsRoot, address);

    await waitUntil(async () => {
      try {
        await readFile(artifactPath);
        return true;
      } catch {
        return false;
      }
    });

    const bytes = await readFile(artifactPath);
    process.stdout.write(bytes.toString('base64'));
  } finally {
    await handle.stop();
    await db.destroy();
  }
}

await main();
