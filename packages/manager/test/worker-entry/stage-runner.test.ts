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
import type { StageRunnerVerdict } from '../../src/ipc/stage-verdict.js';
import { createProductionStageRunner } from '../../src/worker-entry/stage-runner.js';

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

function effectiveConfigJsonFixture(
  testCommand: Record<string, unknown> = { argv: ['npm', 'test'] },
): string {
  const daemon = DaemonConfigSchema.parse({});
  const repo = AdlYmlSchema.parse({
    version: 1,
    commands: {
      build: { argv: ['npm', 'ci'] },
      start: { argv: ['npm', 'run', 'dev'] },
      test: testCommand,
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
  /** Defaults to the developer's own slot — `develop` at index 0. */
  readonly stageId?: string;
  readonly stageIndex?: number;
  readonly effectiveConfigJson?: string;
  /** Defaults to a fresh round; pass a previous assign's to stay in the same one. */
  readonly roundId?: string;
}): AssignMessage {
  return {
    t: 'assign',
    featureId: overrides.featureId,
    leaseToken: ulid(),
    workspaceHandle: `features/${overrides.featureId}`,
    effectiveConfigJson:
      overrides.effectiveConfigJson ?? effectiveConfigJsonFixture(),
    heartbeatIntervalMs: 1000,
    mainRepo: overrides.mainRepo,
    scratchRoot: overrides.scratchRoot,
    baseRef: overrides.baseRef,
    workspaceBackendId: 'worktree',
    roundId: overrides.roundId ?? ulid(),
    stageAttemptId: ulid(),
    stageId: overrides.stageId ?? 'develop',
    stageIndex: overrides.stageIndex ?? 0,
    logsRoot: join(dirname(overrides.scratchRoot), 'logs'),
    ...(overrides.pushUrl !== undefined ? { pushUrl: overrides.pushUrl } : {}),
  };
}

/**
 * A `commands.test` that exits 0 only when the developer's committed file is
 * present in the working directory the gate runs in.
 *
 * This is the whole of `docs/plan/DEBT.md` D-5-13-1 expressed as an exit code:
 * `agent-output.txt` is what `fake-claude-success.mjs` writes and commits, so a
 * gate that attached to the developer's worktree sees it and a gate that
 * branched from `baseRef` does not. Nothing in the assertion mentions
 * attaching — the command simply cannot pass unless it happened.
 */
const SEES_THE_COMMIT = {
  argv: [
    process.execPath,
    '-e',
    "process.exit(require('node:fs').existsSync('agent-output.txt') ? 0 : 1)",
  ],
};

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

/**
 * The workspace outlives the stage that ran in it (M05 step 5.14).
 *
 * ⚠ **Every call below used to assert the opposite** — `.toBe(false)`, under
 * comments reading "the workspace was destroyed" and "still torn down". That
 * was `createProductionStageRunner` calling `destroy()` in its `finally`, which
 * is `docs/plan/DEBT.md` D-5-13-1: it reclaimed the worktree *and* deleted the
 * `adl/*` branch at the end of every stage, so the gate at the next index would
 * have branched from `baseRef` and judged a tree with none of the developer's
 * work in it. These assertions are what went red on the fix, which is exactly
 * their job — a lifecycle change this significant should not be able to land
 * without a diff that says so.
 *
 * The property they were protecting has not been dropped, only relocated. "The
 * stage leaks nothing" is now "the stage reclaims what the *run* owns" — the
 * scratch `HOME` — and that half is asserted where the resource lives, in
 * `packages/workspace/test/helpers/contract.ts`'s detach cases, over both
 * backends. Reclaiming the workspace itself is a decision made from feature
 * state (D-16), and `worktree/gc.ts`'s sweep is what makes it.
 */
function expectWorkspaceKept(scratchRoot: string, assign: AssignMessage): void {
  expect(
    existsSync(workspaceDirFor(scratchRoot, assign)),
    'the worktree must survive the stage — a gate at the next index has to judge the commit made in it (D-5-13-1)',
  ).toBe(true);
}

/**
 * Run the developer at index 0 through the real runner, and return the sha and
 * the assign it ran under.
 *
 * Every gate case below needs a real committed workspace to attach to, and it
 * has to be produced the way production produces one — a real
 * `createProductionStageRunner` call that creates the worktree, commits, and
 * **detaches** rather than destroying. A fixture that hand-built a worktree
 * would be proving that the gate can attach to something the test made, which
 * is not the property.
 */
async function runDeveloperStage(repo: {
  readonly mainRepo: string;
  readonly scratchRoot: string;
  readonly git: TempRepo['git'];
}): Promise<{ assign: AssignMessage; sha: string }> {
  const featureId = `feat-${ulid()}`;
  await writeFeatureSpec(repo.mainRepo, featureId);
  await commitFeatureSpec(repo.git, featureId);
  const baseRef = (await repo.git.revparse(['HEAD'])).trim();

  const assign = buildAssign({
    featureId,
    mainRepo: repo.mainRepo,
    scratchRoot: repo.scratchRoot,
    baseRef,
  });
  const result = await createProductionStageRunner({
    claudeBinary: [process.execPath, FAKE_CLAUDE_SUCCESS],
    claudeCliPath: process.env['PATH'] ?? '',
  })(assign);

  const verdict = JSON.parse(result.verdictJson) as StageRunnerVerdict;
  if (
    verdict.kind !== 'developer_outcome' ||
    verdict.outcome.kind !== 'committed'
  ) {
    throw new Error(`expected a committed outcome, got ${result.verdictJson}`);
  }
  return { assign, sha: verdict.outcome.sha };
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

      // The workspace SURVIVES the stage (M05 step 5.14) — see expectWorkspaceKept.
      expectWorkspaceKept(scratchRoot, assign);

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

      // Kept on the committed-and-pushed path too: the branch is on the remote
      // AND still checked out locally, which is what the gate attaches to.
      expectWorkspaceKept(scratchRoot, assign);
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

      // Kept even on a failed publish: a retryable stage error is retried into
      // the SAME workspace, which is the other half of what attach buys.
      expectWorkspaceKept(scratchRoot, assign);
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
      expectWorkspaceKept(scratchRoot, assign);
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
      expectWorkspaceKept(scratchRoot, assign);
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
      expectWorkspaceKept(scratchRoot, assign);
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
        // Read the commit object by its reported SHA. Since M05 step 5.14 the
        // stage `detach()`es rather than destroying, so the `adl/<featureId>`
        // branch is still there too — but reading by sha stays correct either
        // way (a worktree shares its main repo's object database), and it is
        // what this case is actually about.
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

/* ────────────────────────────────────────────────────────────────────────────
 * The command gate (M05 step 5.14)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the command gate', () => {
  it('runs against the developer’s commit — a gate that branched from baseRef would fail this', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const { assign: developer } = await runDeveloperStage({
        mainRepo,
        scratchRoot,
        git,
      });

      // Round 1, index 1 — the same round the developer just ran in, which is
      // what a real `dispatchOnce` continuation does.
      const gate = buildAssign({
        featureId: developer.featureId,
        mainRepo,
        scratchRoot,
        baseRef: developer.baseRef,
        stageId: 'test',
        stageIndex: 1,
        roundId: developer.roundId,
        effectiveConfigJson: effectiveConfigJsonFixture(SEES_THE_COMMIT),
      });

      const verdict = JSON.parse(
        (await createProductionStageRunner()(gate)).verdictJson,
      ) as StageRunnerVerdict;

      // `docs/plan/DEBT.md` D-5-13-1, closed. Before `attach`/`detach` existed
      // the developer's own `finally` destroyed the worktree and this gate
      // branched from `baseRef`, so `agent-output.txt` was absent, the command
      // exited 1, and this read `send_back` — a gate reporting on a tree with
      // none of the work in it. Watched failing in exactly that shape before
      // the fix landed.
      expect(verdict.kind).toBe('verdict');
      if (verdict.kind !== 'verdict') return;
      expect(verdict.verdict.outcome).toBe('pass');
    });
  }, 30_000);

  it('cites a global category on a pass, never an acceptance criterion', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const { assign: developer } = await runDeveloperStage({
        mainRepo,
        scratchRoot,
        git,
      });

      const verdict = JSON.parse(
        (
          await createProductionStageRunner()(
            buildAssign({
              featureId: developer.featureId,
              mainRepo,
              scratchRoot,
              baseRef: developer.baseRef,
              stageId: 'test',
              stageIndex: 1,
              roundId: developer.roundId,
              effectiveConfigJson: effectiveConfigJsonFixture({
                argv: [process.execPath, '-e', 'process.exit(0)'],
              }),
            }),
          )
        ).verdictJson,
      ) as StageRunnerVerdict;

      expect(verdict.kind === 'verdict' && verdict.verdict.outcome).toBe(
        'pass',
      );
      if (verdict.kind !== 'verdict' || verdict.verdict.outcome !== 'pass') {
        return;
      }
      // ROLE-04: `checked` is non-empty by schema, and `verdict.ts`'s own
      // docblock names this gate's honest answer. A green command says the
      // build is green; it says nothing whatever about criterion AC-1, and a
      // criterion citation here would be fabricated coverage in the pull
      // request table that exists to answer exactly that question.
      expect(verdict.verdict.checked).toEqual([
        { kind: 'global', category: 'build' },
      ]);
    });
  }, 30_000);

  it('turns a non-zero exit into a send_back carrying one blocker finding', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const { assign: developer } = await runDeveloperStage({
        mainRepo,
        scratchRoot,
        git,
      });

      const gate = buildAssign({
        featureId: developer.featureId,
        mainRepo,
        scratchRoot,
        baseRef: developer.baseRef,
        stageId: 'test',
        stageIndex: 1,
        roundId: developer.roundId,
        effectiveConfigJson: effectiveConfigJsonFixture({
          argv: [
            process.execPath,
            '-e',
            "process.stderr.write('AssertionError: expected 1 to be 2\\n'); process.exit(3)",
          ],
        }),
      });

      const verdict = JSON.parse(
        (await createProductionStageRunner()(gate)).verdictJson,
      ) as StageRunnerVerdict;

      expect(verdict.kind).toBe('verdict');
      if (verdict.kind !== 'verdict') return;
      expect(verdict.verdict.outcome).toBe('send_back');
      if (verdict.verdict.outcome !== 'send_back') return;

      // A send_back with nothing actionable in it is not a send_back
      // (`SendBackVerdictSchema.findings` is `.min(1)`), and the thing that
      // makes it actionable is the command's own output.
      expect(verdict.verdict.findings).toHaveLength(1);
      const [finding] = verdict.verdict.findings;
      expect(finding?.severity).toBe('blocker');
      expect(finding?.title).toContain('exit 3');
      expect(finding?.detail).toContain('AssertionError: expected 1 to be 2');
      expect(finding?.criterionRef).toEqual({
        kind: 'global',
        category: 'build',
      });
      expect(finding?.fingerprint).toHaveLength(64);
    });
  }, 30_000);

  it('fingerprints the same failure identically across rounds, and a different exit code differently', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const { assign: developer } = await runDeveloperStage({
        mainRepo,
        scratchRoot,
        git,
      });

      /** The finding a failing gate produces, for a command exiting `code`. */
      async function fingerprintFor(code: number): Promise<string> {
        const verdict = JSON.parse(
          (
            await createProductionStageRunner()(
              buildAssign({
                featureId: developer.featureId,
                mainRepo,
                scratchRoot,
                baseRef: developer.baseRef,
                stageId: 'test',
                stageIndex: 1,
                roundId: developer.roundId,
                effectiveConfigJson: effectiveConfigJsonFixture({
                  argv: [
                    process.execPath,
                    '-e',
                    // Deliberately prints the clock, so the OUTPUT differs
                    // between the two runs while the failure does not.
                    `process.stdout.write(String(process.hrtime.bigint())); process.exit(${String(code)})`,
                  ],
                }),
              }),
            )
          ).verdictJson,
        ) as StageRunnerVerdict;
        if (
          verdict.kind !== 'verdict' ||
          verdict.verdict.outcome !== 'send_back'
        )
          throw new Error(`expected a send_back, got ${verdict.kind}`);
        return verdict.verdict.findings[0]?.fingerprint ?? '';
      }

      // Stall detection (`limits.repeat_finding_threshold`, M06) reads "the
      // same finding recurred", so the fingerprint has to be stable across
      // rounds for an unchanged failure — which means the title it is computed
      // over must carry nothing that varies per run. It does not carry the
      // duration and it does not carry the output; this is what pins that.
      expect(await fingerprintFor(1)).toBe(await fingerprintFor(1));
      // And a genuinely different failure is a genuinely different finding.
      expect(await fingerprintFor(1)).not.toBe(await fingerprintFor(2));
    });
  }, 60_000);

  it('streams the command’s output into the attempt’s transcript', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const { assign: developer } = await runDeveloperStage({
        mainRepo,
        scratchRoot,
        git,
      });

      const gate = buildAssign({
        featureId: developer.featureId,
        mainRepo,
        scratchRoot,
        baseRef: developer.baseRef,
        stageId: 'test',
        stageIndex: 1,
        roundId: developer.roundId,
        effectiveConfigJson: effectiveConfigJsonFixture({
          argv: [
            process.execPath,
            '-e',
            "process.stdout.write('OUT-MARK\\n'); process.stderr.write('ERR-MARK\\n')",
          ],
        }),
      });

      await createProductionStageRunner()(gate);
      const records = await readTranscript(gate);

      // `adl logs -f` on a gate attempt has to show something, and what it
      // shows is the command's own output — the same NDJSON surface M04 built
      // for the developer, reached through the same writer.
      const text = records
        .map((record) =>
          record.event.kind === 'text' ? record.event.delta : '',
        )
        .join('');
      expect(text).toContain('OUT-MARK');
      expect(text).toContain('ERR-MARK');

      // Tagged by stream, so a reader can still tell them apart, and closed by
      // a terminal record so "the command finished" is distinguishable from
      // "the file stopped growing" (T-4-33's distinction).
      const streams = new Set(
        records.flatMap((record) =>
          record.event.kind === 'text' ? [record.event.messageId] : [],
        ),
      );
      expect(streams).toEqual(new Set(['stdout', 'stderr']));
      expect(records[records.length - 1]?.event.kind).toBe('result');

      // And emphatically NOT a `started` event: there is no agent here whose
      // capabilities it could honestly declare.
      expect(records.map((record) => record.event.kind)).not.toContain(
        'started',
      );
    });
  }, 30_000);

  it('reports a killed command as a stage error, never as a verdict', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const { assign: developer } = await runDeveloperStage({
        mainRepo,
        scratchRoot,
        git,
      });

      const gate = buildAssign({
        featureId: developer.featureId,
        mainRepo,
        scratchRoot,
        baseRef: developer.baseRef,
        stageId: 'test',
        stageIndex: 1,
        roundId: developer.roundId,
        effectiveConfigJson: effectiveConfigJsonFixture({
          argv: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'],
          timeout: '1s',
        }),
      });

      const verdict = JSON.parse(
        (await createProductionStageRunner()(gate)).verdictJson,
      ) as StageRunnerVerdict;

      // CORE-06 / D-12: a command ADL had to kill produced no exit code, so it
      // judged nothing. Reporting a `send_back` here would make an
      // infrastructure failure cost the developer a round.
      //
      // Windows reports a killed child as a non-zero exit code rather than a
      // null one, so the CLASSIFICATION is platform-dependent while the
      // property this case exists for is not: whatever else it is, it is never
      // a `pass`.
      expect(
        verdict.kind === 'verdict' && verdict.verdict.outcome === 'pass',
      ).toBe(false);
      if (verdict.kind === 'stage_error') {
        expect(verdict.error.kind).toBe('timeout');
        expect(verdict.error.retryable).toBe(true);
      }
    });
  }, 30_000);

  it('refuses a stage id this build has no implementation for, before opening a workspace', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      const featureId = `feat-${ulid()}`;
      await writeFeatureSpec(mainRepo, featureId);
      await commitFeatureSpec(git, featureId);
      const baseRef = (await git.revparse(['HEAD'])).trim();

      const assign = buildAssign({
        featureId,
        mainRepo,
        scratchRoot,
        baseRef,
        stageId: 'review',
        stageIndex: 1,
      });

      const verdict = JSON.parse(
        (await createProductionStageRunner()(assign)).verdictJson,
      ) as StageRunnerVerdict;

      expect(verdict.kind).toBe('stage_error');
      if (verdict.kind !== 'stage_error') return;
      // `binary_missing` is non-retryable, so the round loop escalates rather
      // than looping forever on a stage that will never exist in this build.
      expect(verdict.error.kind).toBe('binary_missing');
      expect(verdict.error.retryable).toBe(false);
      expect(verdict.error.detail).toContain('review');

      // Refused BEFORE anything was created: a stage this build cannot run
      // must not leave a worktree behind on its way to being refused. The one
      // assertion in this file that still expects absence, and for the
      // opposite reason to `expectWorkspaceKept` — nothing was ever opened.
      expect(existsSync(workspaceDirFor(scratchRoot, assign))).toBe(false);
    });
  }, 30_000);
});
