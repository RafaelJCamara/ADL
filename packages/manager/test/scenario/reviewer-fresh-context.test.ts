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
import {
  findAttempt,
  logsRootFor,
  promptArtifactPathFor,
  startDaemon,
  transcriptPathFor,
} from '../../src/index.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * ROLE-03, observed rather than declared (M07 step 7.5).
 *
 * The **structural** guarantee already existed before this file: `GateContext`
 * has no member through which a session, a transcript, a transcript root, a
 * rendered prompt or a send-back brief can be named, `GATE_CONTEXT_MEMBERS`
 * proves that member list complete at compile time, and
 * `eslint.config.js`'s `adl/gate-fresh-context` stops a gate reaching past its
 * parameters by importing `store/transcript-path.js` and building the path
 * itself.
 *
 * What did **not** exist is a run in which a real reviewer had a real
 * developer transcript sitting on disk beside it and demonstrably could not
 * name it. Every guard above is an argument about ADL's own source; none of
 * them can be observed from inside the process ADL actually launches. So this
 * file launches one and looks.
 *
 * ── The shape ─────────────────────────────────────────────────────────────
 *
 * A real `startDaemon`, the real dispatcher, real forked workers, the real
 * `createProductionStageRunner`, a `['develop', 'review']` pipeline, and one
 * `claude` double (`fake-claude-role-switch.mjs`) that decides which role it
 * is playing by reading its own `--append-system-prompt` argument. As the
 * reviewer it hunts: it walks every directory ADL gave it a root for, and
 * writes what it found — plus its complete argv and environment — to a file
 * outside the worktree.
 *
 * ── What is asserted ──────────────────────────────────────────────────────
 *
 * 1. **The developer's transcript really exists**, at its real path, carrying
 *    the developer's real session id and real reasoning. Without this the rest
 *    of the file proves that nothing found nothing.
 * 2. **The hunt worked.** The walk found the developer's committed output and
 *    the feature's spec, and was not truncated. A search that finds nothing
 *    because it is broken proves nothing.
 * 3. **The hunt found no transcript** — no `*.ndjson`, no `*.prompt`, no
 *    `logs/` directory anywhere under the only root the reviewer was given.
 * 4. **Nothing ADL handed the process names one.** The reviewer's full command
 *    line — which carries the entire rendered prompt — and its full
 *    environment contain no transcript path, no logs root, no session id, and
 *    none of the developer's own reasoning.
 * 5. **The negative control**: that same command line DOES carry the spec and
 *    the changed paths. Assertion 4 is about what is absent from a populated
 *    prompt, not about an empty one.
 *
 * ── What this does NOT prove, stated rather than left to be discovered ────
 *
 * It does not prove the reviewer is *sandboxed* from the transcript. It is
 * not: ADL v1 runs one trust domain per daemon (`docs/plan/DEBT.md` D-2-R-1),
 * so a reviewer that walked far enough up the filesystem would eventually
 * reach `logsRootFor(dbFilePath)`, which in a real installation is a sibling
 * of the scratch root its worktree lives under. ROLE-03's claim is narrower
 * and is the one under test here: **ADL does not hand the reviewer the
 * developer's context, and gives it nothing from which to derive it.** A
 * filesystem-level guarantee is M15's, and is not claimed by this file or by
 * the type it exercises.
 */

const API_TOKEN = `test-token-${ulid()}`;
const TRACER_WORKER_ENTRY = fileURLToPath(
  new URL('../helpers/tracer-worker-entry.ts', import.meta.url),
);
const FAKE_CLAUDE_ROLE_SWITCH = fileURLToPath(
  new URL('../helpers/fake-claude-role-switch.mjs', import.meta.url),
);

/** What the double writes; see its header. Shaped by hand rather than imported — it is the output of an external program, not of ADL. */
interface ReviewerReport {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env: {
    readonly values: Readonly<Record<string, string>>;
    readonly redactedKeys: readonly string[];
  };
  readonly files: readonly string[];
  readonly dirs: readonly string[];
  readonly truncated: boolean;
  readonly transcripts: readonly string[];
  readonly promptArtifacts: readonly string[];
  readonly logDirs: readonly string[];
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

describe('scenario: the reviewer runs on fresh context (ROLE-03)', () => {
  it(
    'cannot find or name the developer transcript that exists beside it',
    { timeout: 180_000 },
    async () => {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
          const folder = `fresh-context-${ulid()}`;
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

          // Outside the worktree, for two reasons. A workspace teardown cannot
          // take the evidence with it (`protected-paths-loop.test.ts`'s own
          // pattern) — and, specific to this file, a report written INSIDE the
          // tree the reviewer walks would be found by that walk, which is
          // circular.
          const reportPath = join(scratchRoot, '..', 'reviewer-report.json');

          const adlYml: AdlYml = AdlYmlSchema.parse({
            version: 1,
            commands: {
              build: { argv: ['true'] },
              start: { argv: ['true'] },
              test: { argv: ['true'] },
              teardown: { argv: ['true'] },
            },
            // The reviewer as an ORDINARY pipeline entry — a built-in stage id
            // and nothing else. 7.9 removes this line and watches the feature
            // reach a PR without it.
            pipeline: ['develop', 'review'],
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
                reportPath,
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

            // The reviewer's own verdict is what says it ran to completion:
            // a `StageError` would leave no verdict row at all.
            await waitUntil(async () => {
              const rows = await db
                .selectFrom('verdicts')
                .innerJoin(
                  'stage_attempts',
                  'stage_attempts.id',
                  'verdicts.stage_attempt_id',
                )
                .innerJoin('rounds', 'rounds.id', 'stage_attempts.round_id')
                .select(['verdicts.outcome'])
                .where('rounds.feature_id', '=', featureId)
                .where('stage_attempts.stage_id', '=', 'review')
                .execute();
              return rows.length > 0;
            });

            const reviewVerdicts = await db
              .selectFrom('verdicts')
              .innerJoin(
                'stage_attempts',
                'stage_attempts.id',
                'verdicts.stage_attempt_id',
              )
              .innerJoin('rounds', 'rounds.id', 'stage_attempts.round_id')
              .select(['verdicts.outcome'])
              .where('rounds.feature_id', '=', featureId)
              .where('stage_attempts.stage_id', '=', 'review')
              .execute();
            expect(reviewVerdicts.map((row) => row.outcome)).toEqual(['pass']);

            // ── 1. The developer's transcript really exists ─────────────
            // Read at its REAL path, built by the same `transcriptPathFor` the
            // worker wrote it through, off an address resolved from the
            // database. This is the thing ROLE-03 claims the reviewer does not
            // inherit; if it did not exist, everything below would be proving
            // that nothing found nothing.
            const developerAttempt = await db
              .selectFrom('stage_attempts')
              .innerJoin('rounds', 'rounds.id', 'stage_attempts.round_id')
              .select(['stage_attempts.id'])
              .where('rounds.feature_id', '=', featureId)
              .where('stage_attempts.stage_id', '=', 'develop')
              .orderBy('stage_attempts.id')
              .executeTakeFirstOrThrow();
            const address = await findAttempt(db, developerAttempt.id);
            expect(address).toBeDefined();

            const logsRoot = logsRootFor(filePath);
            const developerTranscriptPath = transcriptPathFor(
              logsRoot,
              address!,
            );
            const developerTranscript = await readFile(
              developerTranscriptPath,
              'utf8',
            );
            // The developer's session, verbatim: the backend's own opaque
            // session ref and the model's own words.
            expect(developerTranscript).toContain('sess_fake');
            expect(developerTranscript).toContain('Implementing now.');

            const developerPromptPath = promptArtifactPathFor(
              logsRoot,
              address!,
            );
            const developerPrompt = await readFile(developerPromptPath, 'utf8');
            expect(developerPrompt.length).toBeGreaterThan(0);

            const report = JSON.parse(
              await readFile(reportPath, 'utf8'),
            ) as ReviewerReport;

            // ── 2. The hunt worked ──────────────────────────────────────
            // The walk really ran, really read the tree, and really was not
            // cut short — so "found no transcript" below is a finding rather
            // than a failure to look.
            expect(report.truncated).toBe(false);
            expect(report.files).toContain('agent-output.txt');
            expect(report.files).toContain(`${featureDir}/spec.md`);

            // ── 3. It found no transcript anywhere it could reach ───────
            expect(report.transcripts).toEqual([]);
            expect(report.promptArtifacts).toEqual([]);
            expect(report.logDirs).toEqual([]);

            // ── 4. Nothing ADL handed the process names one ─────────────
            // `argv` carries the ENTIRE rendered prompt — the system prompt
            // after `--append-system-prompt`, the instructions as the last
            // positional. This is the strongest available form of the claim:
            // it is what the reviewer process actually received, read back out
            // of that process, not what ADL believes it sent.
            const needles: readonly [string, string][] = [
              ['the logs root', logsRoot],
              ["the developer's transcript path", developerTranscriptPath],
              ["the developer's prompt-artifact path", developerPromptPath],
              ['the transcript extension', '.ndjson'],
              ["the backend's session ref", 'sess_fake'],
              ["the developer's own words", 'Implementing now.'],
              ["the developer's rendered prompt", developerPrompt.trim()],
            ];
            const reachable = [
              ...report.argv,
              ...Object.values(report.env.values),
            ];
            for (const [what, needle] of needles) {
              const carriers = reachable.filter((value) =>
                value.includes(needle),
              );
              expect(
                carriers,
                `the reviewer was handed ${what} (${needle})`,
              ).toEqual([]);
            }

            // The redaction in the double cannot be what made the check above
            // pass: nothing withheld is named like something that would carry
            // a path. Without this, a variable called `ADL_LOG_TOKEN` could
            // hide the whole finding.
            expect(
              report.env.redactedKeys.filter((key) =>
                /ADL|LOG|TRANSCRIPT|SESSION|PROMPT|DIR|PATH|HOME/i.test(key),
              ),
            ).toEqual([]);

            // ── 5. The negative control ─────────────────────────────────
            // The prompt the assertions above searched was not empty. It
            // carried exactly what ROLE-03 permits — spec and diff — which is
            // what makes their silence about everything else meaningful.
            const joinedArgv = report.argv.join('\n');
            expect(joinedArgv).toContain('You are the ADL code reviewer');
            expect(joinedArgv).toContain('The export button appears.');
            expect(joinedArgv).toContain('AC-1');
            expect(joinedArgv).toContain('agent-output.txt');
          } finally {
            await handle.stop();
          }
        });
      });
    },
  );
});
