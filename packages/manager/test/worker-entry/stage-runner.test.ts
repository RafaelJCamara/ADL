import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  DaemonConfigSchema,
  mergeConfig,
  AdlYmlSchema,
} from '@adl/core/config';
import type { TranscriptRecord } from '@adl/core/stage';
import { ulid } from 'ulid';
import {
  withTempRepo,
  type TempRepo,
} from '../../../workspace/test/helpers/temp-repo.js';
import { posixOnly } from '../helpers/platform.js';
import { branchNameFor } from '@adl/workspace';
import { composeBranchFeatureId } from '../../src/branch-identity.js';
import type { AssignMessage } from '../../src/ipc/protocol.js';
import {
  createProductionStageRunner,
  type StageRunnerVerdict,
} from '../../src/worker-entry/stage-runner.js';

const FAKE_CLAUDE_SUCCESS = fileURLToPath(
  new URL('../helpers/fake-claude-success.mjs', import.meta.url),
);
const FAKE_CLAUDE_NO_COMMIT = fileURLToPath(
  new URL('../helpers/fake-claude-no-commit.mjs', import.meta.url),
);
const FAKE_CLAUDE_AUTH_FAIL = fileURLToPath(
  new URL('../helpers/fake-claude-auth-fail.mjs', import.meta.url),
);
const FAKE_CLAUDE_NONZERO = fileURLToPath(
  new URL('../helpers/fake-claude-nonzero.mjs', import.meta.url),
);
const FAKE_CLAUDE_UNCLASSIFIABLE = fileURLToPath(
  new URL('../helpers/fake-claude-unclassifiable-result.mjs', import.meta.url),
);
/**
 * A genuinely missing EXECUTABLE — not `[node, missing-script]`, which would
 * spawn `node` successfully (it exists) and only fail later, at runtime,
 * with a non-zero exit indistinguishable from an ordinary command failure.
 * `binary_missing` is specifically the spawn-time ENOENT case: the launcher
 * itself cannot be found on `PATH`.
 */
const MISSING_BINARY_NAME = 'adl-test-nonexistent-claude-binary-9f3c2a';

function effectiveConfigJsonFixture(): string {
  const daemon = DaemonConfigSchema.parse({});
  const repo = AdlYmlSchema.parse({
    version: 1,
    commands: {
      build: { argv: ['npm', 'ci'] },
      start: { argv: ['npm', 'run', 'dev'] },
      test: { argv: ['npm', 'test'] },
      teardown: { argv: ['docker', 'compose', 'down'] },
    },
    pipeline: ['develop', 'review', 'test'],
  });
  const { config } = mergeConfig(DEFAULT_CONFIG, daemon, repo);
  return JSON.stringify(config);
}

const SPEC_MARKDOWN = `# Title

Widget export

## Acceptance Criteria

- The export button appears on the widget page.
`;

async function writeFeatureSpec(
  mainRepo: string,
  featureId: string,
): Promise<void> {
  const dir = join(mainRepo, 'features', featureId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'spec.md'), SPEC_MARKDOWN, 'utf8');
}

async function commitFeatureSpec(
  git: TempRepo['git'],
  featureId: string,
): Promise<void> {
  await git.add(`features/${featureId}/spec.md`);
  await git.raw(['commit', '-m', `add features/${featureId}`]);
}

function buildAssign(overrides: {
  readonly featureId: string;
  readonly mainRepo: string;
  readonly scratchRoot: string;
  readonly baseRef: string;
  readonly pushUrl?: string;
}): AssignMessage {
  return {
    t: 'assign',
    featureId: overrides.featureId,
    leaseToken: ulid(),
    workspaceHandle: `features/${overrides.featureId}`,
    effectiveConfigJson: effectiveConfigJsonFixture(),
    heartbeatIntervalMs: 1000,
    mainRepo: overrides.mainRepo,
    scratchRoot: overrides.scratchRoot,
    baseRef: overrides.baseRef,
    workspaceBackendId: 'worktree',
    roundId: ulid(),
    stageAttemptId: ulid(),
    stageId: 'develop',
    stageIndex: 0,
    logsRoot: join(dirname(overrides.scratchRoot), 'logs'),
    ...(overrides.pushUrl !== undefined ? { pushUrl: overrides.pushUrl } : {}),
  };
}

/** The real branch a committed dispatch pushes — mirrors `stage-runner.ts`'s own composition (DETECT-05, 5.6). */
function realBranchFor(assign: AssignMessage): string {
  return branchNameFor(
    composeBranchFeatureId(basename(assign.workspaceHandle), assign.featureId),
  );
}

/**
 * Where a real dispatch's worktree actually lands (DETECT-05, 5.6):
 * `stage-runner.ts` no longer hands `backend.create()` the bare
 * `assign.featureId` — it composes the folder's basename in alongside it
 * (`composeBranchFeatureId`), so `assign.featureId` alone is no longer the
 * worktree's directory name under `scratchRoot`.
 */
function workspaceDirFor(scratchRoot: string, assign: AssignMessage): string {
  return join(
    scratchRoot,
    composeBranchFeatureId(basename(assign.workspaceHandle), assign.featureId),
  );
}

async function readTranscript(
  assign: AssignMessage,
): Promise<TranscriptRecord[]> {
  const path = join(
    assign.logsRoot,
    assign.featureId,
    assign.roundId,
    assign.stageId,
    '1.ndjson',
  );
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TranscriptRecord);
}

describe('createProductionStageRunner', () => {
  it('a run that produces a real commit reports a committed DeveloperOutcome naming the real sha, and the transcript is on disk', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const featureId = `feat-${ulid()}`;
      await writeFeatureSpec(mainRepo, featureId);
      await commitFeatureSpec(git, featureId);
      const baseRef = (await git.revparse(['HEAD'])).trim();

      const assign = buildAssign({ featureId, mainRepo, scratchRoot, baseRef });
      const runner = createProductionStageRunner({
        claudeBinary: [process.execPath, FAKE_CLAUDE_SUCCESS],
        claudeCliPath: process.env['PATH'] ?? '',
        credentialEnvValue: 'test-credential',
      });

      const result = await runner(assign);
      const verdict = JSON.parse(result.verdictJson) as StageRunnerVerdict;

      expect(verdict.kind).toBe('developer_outcome');
      expect(verdict.kind === 'developer_outcome' && verdict.outcome.kind).toBe(
        'committed',
      );
      const sha =
        verdict.kind === 'developer_outcome' &&
        verdict.outcome.kind === 'committed'
          ? verdict.outcome.sha
          : undefined;
      expect(sha).toBeDefined();

      const records = await readTranscript(assign);
      expect(records.length).toBeGreaterThan(0);
      expect(records.some((r) => r.event.kind === 'started')).toBe(true);
      expect(records.some((r) => r.event.kind === 'result')).toBe(true);

      // Every record's `seq` is monotonically increasing.
      const seqs = records.map((r) => r.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

      // The workspace was destroyed: the worktree directory no longer exists.
      expect(existsSync(workspaceDirFor(scratchRoot, assign))).toBe(false);

      // The commit's author names ADL and the backend, not the test's own
      // git identity (`withTempRepo`'s "tracer@adl.invalid" / "ADL Tracer").
      // Read by the reported commit SHA rather than the branch — `destroy()`
      // (correctly) deletes the `adl/<featureId>` branch as part of its own
      // teardown contract, but a worktree shares its object database with
      // the main repository, so the commit OBJECT itself is still reachable
      // by SHA even after the branch ref that pointed at it is gone.
      const authorName = (
        await git.raw(['log', '-1', '--format=%an', sha!])
      ).trim();
      const authorEmail = (
        await git.raw(['log', '-1', '--format=%ae', sha!])
      ).trim();
      expect(authorName).toBe('ADL (claude-code)');
      expect(authorEmail).toBe('adl+claude-code@noreply.local');
    });
  }, 20_000);

  it('a committed run with assign.pushUrl set pushes the branch before the workspace is destroyed (M05 step 5.10)', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const featureId = `feat-${ulid()}`;
      await writeFeatureSpec(mainRepo, featureId);
      await commitFeatureSpec(git, featureId);
      const baseRef = (await git.revparse(['HEAD'])).trim();

      const bareRemote = join(scratchRoot, '..', 'push-target.git');
      await mkdir(bareRemote, { recursive: true });
      await git.raw(['-C', bareRemote, 'init', '--bare']);

      const assign = buildAssign({
        featureId,
        mainRepo,
        scratchRoot,
        baseRef,
        pushUrl: bareRemote,
      });
      const runner = createProductionStageRunner({
        claudeBinary: [process.execPath, FAKE_CLAUDE_SUCCESS],
        claudeCliPath: process.env['PATH'] ?? '',
      });

      const result = await runner(assign);
      const verdict = JSON.parse(result.verdictJson) as StageRunnerVerdict;

      expect(verdict.kind).toBe('developer_outcome');
      if (
        verdict.kind !== 'developer_outcome' ||
        verdict.outcome.kind !== 'committed'
      ) {
        throw new Error(
          `expected a committed outcome, got ${result.verdictJson}`,
        );
      }

      const branch = realBranchFor(assign);
      const pushedSha = (
        await git.raw(['-C', bareRemote, 'rev-parse', `refs/heads/${branch}`])
      ).trim();
      expect(pushedSha).toBe(verdict.outcome.sha);

      // The workspace was still destroyed on the committed-and-pushed path.
      expect(existsSync(workspaceDirFor(scratchRoot, assign))).toBe(false);
    });
  }, 20_000);

  it('a push failure is reported as a retryable stage_error, never a false committed outcome', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const featureId = `feat-${ulid()}`;
      await writeFeatureSpec(mainRepo, featureId);
      await commitFeatureSpec(git, featureId);
      const baseRef = (await git.revparse(['HEAD'])).trim();

      // Not a real remote — `git init --bare` never ran here — so the push
      // itself fails, deterministically, with no network involved.
      const notARemote = join(scratchRoot, '..', 'not-a-remote.git');

      const assign = buildAssign({
        featureId,
        mainRepo,
        scratchRoot,
        baseRef,
        pushUrl: notARemote,
      });
      const runner = createProductionStageRunner({
        claudeBinary: [process.execPath, FAKE_CLAUDE_SUCCESS],
        claudeCliPath: process.env['PATH'] ?? '',
      });

      const result = await runner(assign);
      const verdict = JSON.parse(result.verdictJson) as StageRunnerVerdict;

      expect(verdict.kind).toBe('stage_error');
      if (verdict.kind === 'stage_error') {
        expect(verdict.error.kind).toBe('provider_error');
        expect(verdict.error.retryable).toBe(true);
      }

      // Still torn down — a failed publish does not leak the worktree.
      expect(existsSync(workspaceDirFor(scratchRoot, assign))).toBe(false);
    });
  }, 20_000);

  it('a run producing no commit reports blocked honestly, never a pass, and still tears down', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const featureId = `feat-${ulid()}`;
      await writeFeatureSpec(mainRepo, featureId);
      await commitFeatureSpec(git, featureId);
      const baseRef = (await git.revparse(['HEAD'])).trim();

      const assign = buildAssign({ featureId, mainRepo, scratchRoot, baseRef });
      const runner = createProductionStageRunner({
        claudeBinary: [process.execPath, FAKE_CLAUDE_NO_COMMIT],
        claudeCliPath: process.env['PATH'] ?? '',
      });

      const result = await runner(assign);
      const verdict = JSON.parse(result.verdictJson) as StageRunnerVerdict;

      expect(verdict.kind).toBe('developer_outcome');
      if (verdict.kind === 'developer_outcome') {
        expect(verdict.outcome.kind).toBe('blocked');
      }
      expect(existsSync(workspaceDirFor(scratchRoot, assign))).toBe(false);
    });
  }, 20_000);

  it('a missing binary produces an infrastructure-failure outcome carrying binary_missing, and tears down', async () => {
    // `run.ts`'s own documented limitation: on Windows, `cross-spawn` routes
    // a missing binary through `cmd.exe`, which returns `exitCode: 1` with
    // no `code`/`errno` at all — byte-for-byte what a command that
    // legitimately exited 1 returns. `workspace.exec()` therefore never
    // rejects for a missing binary on this platform, and this backend has no
    // way to distinguish "not found" from "ran and failed" here — that
    // cross-platform distinction is explicitly deferred in `run.ts`'s own
    // docblock, not something this plan re-solves.
    const gate = posixOnly(
      "a missing binary is only distinguishable from an ordinary non-zero exit off Windows (run.ts's own documented limitation)",
      'T-4-08-binary-missing',
    );
    if (gate.kind === 'skip') return;

    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const featureId = `feat-${ulid()}`;
      await writeFeatureSpec(mainRepo, featureId);
      await commitFeatureSpec(git, featureId);
      const baseRef = (await git.revparse(['HEAD'])).trim();

      const assign = buildAssign({ featureId, mainRepo, scratchRoot, baseRef });
      const runner = createProductionStageRunner({
        claudeBinary: [MISSING_BINARY_NAME],
        claudeCliPath: process.env['PATH'] ?? '',
      });

      const result = await runner(assign);
      const verdict = JSON.parse(result.verdictJson) as StageRunnerVerdict;

      expect(verdict.kind).toBe('stage_error');
      if (verdict.kind === 'stage_error') {
        expect(verdict.error.kind).toBe('binary_missing');
      }
      expect(existsSync(workspaceDirFor(scratchRoot, assign))).toBe(false);
    });
  }, 20_000);

  it('a missing binary is never rendered as a passing outcome, on every platform (prohibition P1, cross-platform floor beneath the binary_missing classification above)', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const featureId = `feat-${ulid()}`;
      await writeFeatureSpec(mainRepo, featureId);
      await commitFeatureSpec(git, featureId);
      const baseRef = (await git.revparse(['HEAD'])).trim();

      const assign = buildAssign({ featureId, mainRepo, scratchRoot, baseRef });
      const runner = createProductionStageRunner({
        claudeBinary: [MISSING_BINARY_NAME],
        claudeCliPath: process.env['PATH'] ?? '',
      });

      const result = await runner(assign);
      const verdict = JSON.parse(result.verdictJson) as StageRunnerVerdict;

      // Never a developer_outcome — whether this platform reports
      // binary_missing (POSIX) or the generic provider_error (Windows, see
      // the gated test above), it is always the infrastructure-failure
      // channel, never a pass.
      expect(verdict.kind).toBe('stage_error');
      expect(existsSync(workspaceDirFor(scratchRoot, assign))).toBe(false);
    });
  }, 20_000);

  it('an auth failure (no terminal result event) produces an infrastructure failure carrying auth, never a pass', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const featureId = `feat-${ulid()}`;
      await writeFeatureSpec(mainRepo, featureId);
      await commitFeatureSpec(git, featureId);
      const baseRef = (await git.revparse(['HEAD'])).trim();

      const assign = buildAssign({ featureId, mainRepo, scratchRoot, baseRef });
      const runner = createProductionStageRunner({
        claudeBinary: [process.execPath, FAKE_CLAUDE_AUTH_FAIL],
        claudeCliPath: process.env['PATH'] ?? '',
      });

      const result = await runner(assign);
      const verdict = JSON.parse(result.verdictJson) as StageRunnerVerdict;

      expect(verdict.kind).toBe('stage_error');
      if (verdict.kind === 'stage_error') {
        expect(verdict.error.kind).toBe('auth');
      }
    });
  }, 20_000);

  it('a non-zero exit with no terminal event produces an infrastructure failure, never a pass', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const featureId = `feat-${ulid()}`;
      await writeFeatureSpec(mainRepo, featureId);
      await commitFeatureSpec(git, featureId);
      const baseRef = (await git.revparse(['HEAD'])).trim();

      const assign = buildAssign({ featureId, mainRepo, scratchRoot, baseRef });
      const runner = createProductionStageRunner({
        claudeBinary: [process.execPath, FAKE_CLAUDE_NONZERO],
        claudeCliPath: process.env['PATH'] ?? '',
      });

      const result = await runner(assign);
      const verdict = JSON.parse(result.verdictJson) as StageRunnerVerdict;

      expect(verdict.kind).toBe('stage_error');
      if (verdict.kind === 'stage_error') {
        expect(verdict.error.kind).not.toBe('auth');
        // `provider_error` is transient (D-15) — another attempt may well
        // succeed, unlike `binary_missing`/`auth`, which are not.
        expect(verdict.error.retryable).toBe(true);
      }
    });
  }, 20_000);

  it('an unclassifiable terminal event produces an infrastructure failure, never a pass', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const featureId = `feat-${ulid()}`;
      await writeFeatureSpec(mainRepo, featureId);
      await commitFeatureSpec(git, featureId);
      const baseRef = (await git.revparse(['HEAD'])).trim();

      const assign = buildAssign({ featureId, mainRepo, scratchRoot, baseRef });
      const runner = createProductionStageRunner({
        claudeBinary: [process.execPath, FAKE_CLAUDE_UNCLASSIFIABLE],
        claudeCliPath: process.env['PATH'] ?? '',
      });

      const result = await runner(assign);
      const verdict = JSON.parse(result.verdictJson) as StageRunnerVerdict;

      expect(verdict.kind).toBe('stage_error');
    });
  }, 20_000);

  it('the commit identity is stable across two runs and does not equal the host git identity', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      async function runOnceAndReadAuthor(): Promise<string> {
        const fid = `feat-${ulid()}`;
        await writeFeatureSpec(mainRepo, fid);
        await commitFeatureSpec(git, fid);
        const ref = (await git.revparse(['HEAD'])).trim();
        const assign = buildAssign({
          featureId: fid,
          mainRepo,
          scratchRoot,
          baseRef: ref,
        });
        const runner = createProductionStageRunner({
          claudeBinary: [process.execPath, FAKE_CLAUDE_SUCCESS],
          claudeCliPath: process.env['PATH'] ?? '',
        });
        const result = await runner(assign);
        const verdict = JSON.parse(result.verdictJson) as StageRunnerVerdict;
        if (
          verdict.kind !== 'developer_outcome' ||
          verdict.outcome.kind !== 'committed'
        ) {
          throw new Error(
            `expected a committed outcome, got ${result.verdictJson}`,
          );
        }
        // Read the commit object by its reported SHA — `destroy()` deletes
        // the `adl/<featureId>` branch ref as part of its own teardown
        // contract, but the commit object itself survives in the shared
        // object database (a worktree shares one with its main repo) until
        // an actual `git gc` runs.
        return (
          await git.raw([
            'log',
            '-1',
            '--format=%an <%ae>',
            verdict.outcome.sha,
          ])
        ).trim();
      }

      const first = await runOnceAndReadAuthor();
      const second = await runOnceAndReadAuthor();

      expect(first).toBe(second);
      expect(first).toBe('ADL (claude-code) <adl+claude-code@noreply.local>');
      expect(first).not.toContain('tracer@adl.invalid');
      expect(first).not.toContain('ADL Tracer');
    });
  }, 30_000);
});
