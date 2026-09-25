/**
 * ROLE-07 end to end — **M08's tracer slice** (convention 14, step 8.2).
 *
 * The first cross-process path through every layer this milestone touches, and it
 * is deliberately proven *before* any agent, any code-blindness and any commit
 * exists: a real daemon forks a real worker, which builds a real app, starts it
 * on a port ADL allocated, waits for a real HTTP readiness probe to answer 200,
 * runs a gate that fetches the app over the loopback interface, then tears the
 * app down and reaps its process tree.
 *
 * Three mechanisms get their **first production reader** here, all built since
 * M01, all required by the schema, all with zero callers until now (M08's audit
 * finding 4): `commands.build` / `commands.start` / `commands.teardown`;
 * `interpolate()` and `ADL_VARIABLES`, which is where `ADL_PORT` is defined; and
 * the readiness probe contract.
 *
 * ## The evidence does not come from ADL's own bookkeeping
 *
 * 7.5's and 7.9's pattern, and 8.1's. The app writes its own pids and the port it
 * actually bound to a file outside every workspace; the gate writes what it could
 * fetch to another; and `commands.build`/`teardown` append to a third, so their
 * ORDER is observable rather than just their occurrence. Every assertion below
 * reads one of those three files. If ADL believed it had started an app on the
 * port it interpolated and had not, these files say so.
 *
 * ## No platform gate, and two limits on the evidence that are stated rather than assumed
 *
 * The reap assertion runs on every platform and passes on every platform — step
 * 8.2's throwaway probes measured a grandchild server dying on **win32** — so
 * there is nothing here for `test/helpers/platform.ts` to gate. What differs by
 * platform is how much this test can *discriminate*, and that is worth writing
 * down rather than leaving a reader to assume more than was measured.
 *
 * **1. On win32 it cannot measure `killDescendants`.** `exec/run.ts` passes
 * `killDescendants: true` so a killed child's subtree goes with it; execa
 * implements that as `detached: true` plus `kill(-pid)` on Unix and `taskkill /T`
 * on Windows. Setting the flag to `false` and rebuilding was watched, twice —
 * with the grandchild on inherited stdio and on `stdio: 'ignore'` — and the
 * grandchild died anyway, so on this platform something below execa already
 * reaps the subtree. The flag is therefore load-bearing on **Unix**, where this
 * test will measure it, and unmeasurable here. `DEBT.md`'s **D-8-02-3** records
 * that as a deferred check rather than a covered one.
 *
 * What the injection *did* catch on win32 is the assertion that matters more:
 * deleting `controller.abort()` from `lifecycle.ts` turns the witness red.
 *
 * **2. `D-2-07-1` is inherited, not introduced.** Under the Linux privilege drop
 * the direct child is `sudo`, which re-execs as the worker user, so a signal ADL
 * sends reaches a process it does not own. This test runs undropped (no
 * `ADL_WORKER_USER`), so it measures the mechanism and not that limitation, and
 * `lifecycle.ts`'s docblock states the limitation rather than letting it be
 * quietly inherited.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
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
const APP_GATE_PROBE = fileURLToPath(
  new URL('../helpers/app-gate-probe.mjs', import.meta.url),
);
const APP_START = fileURLToPath(
  new URL('../helpers/app-under-test-start.mjs', import.meta.url),
);
const LIFECYCLE_MARKER = fileURLToPath(
  new URL('../helpers/app-lifecycle-marker.mjs', import.meta.url),
);
const TEARDOWN_WITNESS = fileURLToPath(
  new URL('../helpers/app-teardown-witness.mjs', import.meta.url),
);

interface AppPids {
  /** The `node:cluster` primary — the direct child ADL started. */
  readonly primary: number;
  /** Its cluster worker — a real descendant, and the subject of the reaping half. */
  readonly worker: number;
  readonly port: number;
}

/**
 * What `commands.teardown` saw when it ran — the reaping evidence.
 *
 * ADL reaps BEFORE teardown, so a correct run has all three false while the
 * worker is still alive. See `app-teardown-witness.mjs` for why the observation
 * has to be made from there rather than after the round.
 */
interface TeardownWitness {
  readonly readPidFile: boolean;
  readonly primaryAlive: boolean | null;
  readonly workerAlive: boolean | null;
  readonly portAccepting: boolean | null;
  readonly error?: string;
}

interface GateReport {
  readonly portFromEnv: string | null;
  readonly sawPort: boolean;
  readonly status: number | null;
  readonly body: string | null;
  readonly error: string | null;
}

/** Is this pid still in the process table? */
function alive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check and delivers nothing.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Will anything accept a TCP connection on this port? */
async function accepting(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    let done = false;
    const finish = (answer: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1_000, () => {
      finish(false);
    });
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
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

describe('scenario: ADL owns the app lifecycle around a gate that declares needs_app', () => {
  it(
    'builds, starts on an allocated port, probes, runs the gate against the live app, tears down and reaps',
    { timeout: 180_000 },
    async () => {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          const folder = `app-${ulid()}`;
          const featureDir = `features/${folder}`;
          await mkdir(join(mainRepo, featureDir), { recursive: true });
          await writeFile(
            join(mainRepo, featureDir, 'spec.md'),
            '# Title\n\nA feature.\n\n## Acceptance Criteria\n\n- It answers /health.\n',
            'utf8',
          );
          await git.add('.');
          await git.raw(['commit', '-m', 'add feature']);
          const defaultBranch = (
            await git.raw(['branch', '--show-current'])
          ).trim();

          // Outside every workspace, so neither teardown nor a later GC sweep can
          // take the evidence with it — `gate-visible-paths.test.ts`'s pattern.
          const outside = join(scratchRoot, '..');
          const pidPath = join(outside, `app-pids-${folder}.json`);
          const reportPath = join(outside, `app-report-${folder}.json`);
          const markerPath = join(outside, `app-phases-${folder}.txt`);
          const witnessPath = join(outside, `app-witness-${folder}.json`);

          const adlYml: AdlYml = AdlYmlSchema.parse({
            version: 1,
            commands: {
              // Appends `build` to the marker file, so "build ran before the app
              // was started" is observable rather than assumed.
              build: {
                argv: [process.execPath, LIFECYCLE_MARKER, markerPath, 'build'],
              },
              start: {
                argv: [process.execPath, APP_START, pidPath],
                // `${ADL_PORT}` in a command's `env` — one of the two
                // interpolation sites `adl-yml.ts`'s promise 2 documents, and the
                // only way an app can be told which port to bind.
                env: { PORT: '${ADL_PORT}' },
                ready: {
                  kind: 'http',
                  // The other documented site, and the reason
                  // `InterpolatableUrlSchema` deliberately is not `z.url()`.
                  url: 'http://127.0.0.1:${ADL_PORT}/health',
                  expect: 200,
                },
                ready_timeout: '60s',
              },
              test: { argv: ['true'] },
              // Appends `teardown` to the same marker AND witnesses whether the
              // app's process tree is already gone — see `TeardownWitness`.
              teardown: {
                argv: [
                  process.execPath,
                  TEARDOWN_WITNESS,
                  markerPath,
                  pidPath,
                  witnessPath,
                ],
              },
            },
            pipeline: [
              'develop',
              {
                // A third party's gate in every respect: its own program, its own
                // `needs_app`, no built-in name. The tester (step 8.4) reaches the
                // lifecycle through this identical path — HARN-04 as code.
                harness: 'behaviour',
                with: {
                  command: {
                    argv: [process.execPath, APP_GATE_PROBE, reportPath],
                    // How a command gate learns the port: the SAME substitution
                    // the app got, into its own command's env.
                    env: { APP_PORT: '${ADL_PORT}' },
                  },
                },
                needs_app: true,
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

            const pids = JSON.parse(await readFile(pidPath, 'utf8')) as AppPids;
            const report = JSON.parse(
              await readFile(reportPath, 'utf8'),
            ) as GateReport;
            const phases = (await readFile(markerPath, 'utf8'))
              .split('\n')
              .filter((line) => line !== '');
            const witness = JSON.parse(
              await readFile(witnessPath, 'utf8'),
            ) as TeardownWitness;

            // ── 1. Every phase ran, in order ────────────────────────────
            // `build` first and `teardown` last, read off a file the two commands
            // APPENDED to. A pair of overwritten markers could not tell the
            // difference between this and a teardown that ran before the build.
            expect(phases).toEqual(['build', 'teardown']);

            // ── 2. The port ADL allocated is the port the app bound ─────
            // The whole interpolation chain in one assertion: ADL allocated a
            // port, `interpolate()` put it in `commands.start.env.PORT`, the app
            // read it, and the server bound it. A number that travelled through
            // `${ADL_PORT}` and came back unchanged is `ADL_VARIABLES`' first
            // production use.
            expect(pids.port).toBeGreaterThan(0);
            expect(report.sawPort).toBe(true);
            expect(report.portFromEnv).toBe(String(pids.port));

            // ── 3. The gate judged a LIVE app, over a real socket ───────
            // `expect: 200` was satisfied by the real server, not by any listener:
            // the body names the port the grandchild bound. If the readiness probe
            // had passed while the app was still starting, `status` would be null
            // and `error` would say why.
            expect(report.error).toBeNull();
            expect(report.status).toBe(200);
            expect(report.body).toBe(
              JSON.stringify({ ok: true, port: pids.port }),
            );

            // ── 4. ADL reaped the tree, and the witness is not ADL ─────
            //
            // **The load-bearing assertion of this file, and the one the step's
            // watched-failing pass had to be rewritten for.** Checking liveness
            // *after* the round does not measure ADL at all: the worker exits when
            // a dispatch ends and execa's own `cleanup: true` kills its subprocess
            // then, so the app dies whether or not `lifecycle.ts` ever called
            // `abort()`. Deleting the abort left that version of this test GREEN.
            //
            // So the observation is made by `commands.teardown`, which ADL runs
            // AFTER the reap and BEFORE the worker exits — a repository-supplied
            // program reporting that the app is already gone.
            //
            // Both pids, not just the direct child. The app is a `node:cluster`
            // primary plus one worker, so `workerAlive` is what measures
            // `exec/run.ts`'s `killDescendants: true`; a single-process fixture
            // would pass with that flag deleted. And the worker deliberately does
            // not listen, so `portAccepting` stays an independent observable of the
            // primary rather than a second reading of the same fact.
            expect(witness.error).toBeUndefined();
            expect(witness.readPidFile).toBe(true);
            expect(witness.primaryAlive).toBe(false);
            expect(witness.workerAlive).toBe(false);
            // Not implied by the two above: a socket can outlive the process that
            // opened it if a descendant inherited the handle.
            expect(witness.portAccepting).toBe(false);

            // ── 5. And nothing came back afterwards ────────────────────
            // Weaker than 4 by construction — see above — and kept because it
            // costs nothing and would catch an app that respawned itself.
            expect(alive(pids.primary)).toBe(false);
            expect(alive(pids.worker)).toBe(false);
            expect(await accepting(pids.port)).toBe(false);
          } finally {
            await handle.stop();
          }
        });
      });
    },
  );
});
