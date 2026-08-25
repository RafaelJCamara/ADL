import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import {
  DEFAULT_CONFIG,
  DaemonConfigSchema,
  mergeConfig,
  AdlYmlSchema,
} from '@adl/core/config';
import type { AgentRunner } from '@adl/core/stage';
import {
  withTempRepo,
  type TempRepo,
} from '../../../workspace/test/helpers/temp-repo.js';
import type { AssignMessage } from '../../src/ipc/protocol.js';
import {
  PROMPT_ARTIFACT_EXTENSION,
  PromptArtifactConflictError,
  promptArtifactPathFor,
  writePromptArtifact,
} from '../../src/prompt/artifact.js';
import type { StageRunnerVerdict } from '../../src/ipc/stage-verdict.js';
import { createProductionStageRunner } from '../../src/worker-entry/stage-runner.js';
import {
  TRANSCRIPT_EXTENSION,
  TranscriptAddressError,
  transcriptPathFor,
  type TranscriptAddress,
} from '../../src/store/transcript-path.js';

/**
 * Phase 4 Plan 09, Task 2: the rendered prompt, persisted beside its
 * transcript, before the agent is launched (see `artifact.ts`'s own module
 * docblock).
 */

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'adl-prompt-artifact-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fixtureAddress(): TranscriptAddress {
  return {
    featureId: `feat-${ulid()}`,
    roundId: `round-${ulid()}`,
    stageId: 'develop',
    stageIndex: 0,
    attempt: 1,
  };
}

describe('promptArtifactPathFor', () => {
  it('shares a directory and a stem with the transcript path, differing only in extension', () => {
    const address = fixtureAddress();
    const root = '/some/logs/root';
    const transcriptPath = transcriptPathFor(root, address);
    const artifactPath = promptArtifactPathFor(root, address);

    expect(dirname(artifactPath)).toBe(dirname(transcriptPath));
    expect(
      transcriptPath.slice(
        0,
        transcriptPath.length - TRANSCRIPT_EXTENSION.length,
      ),
    ).toBe(
      artifactPath.slice(
        0,
        artifactPath.length - PROMPT_ARTIFACT_EXTENSION.length,
      ),
    );
    expect(artifactPath).not.toBe(transcriptPath);
    expect(artifactPath.endsWith(PROMPT_ARTIFACT_EXTENSION)).toBe(true);
  });

  it('refuses a hostile address component with the SAME named error transcriptPathFor produces', () => {
    const hostile: TranscriptAddress = {
      ...fixtureAddress(),
      featureId: '../escape',
    };

    let transcriptError: unknown;
    try {
      transcriptPathFor('/some/logs/root', hostile);
    } catch (error) {
      transcriptError = error;
    }

    expect(transcriptError).toBeInstanceOf(TranscriptAddressError);

    expect(() => promptArtifactPathFor('/some/logs/root', hostile)).toThrow(
      TranscriptAddressError,
    );
  });
});

describe('writePromptArtifact', () => {
  it('creates the parent directory chain and writes a single, parseable file', async () => {
    await withTempDir(async (dir) => {
      const address = fixtureAddress();
      const path = await writePromptArtifact(dir, address, {
        systemPrompt: 'SYSTEM-PROMPT-CONTENT',
        instructions: 'INSTRUCTIONS-CONTENT',
      });

      expect(existsSync(path)).toBe(true);
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw.trim()) as {
        systemPrompt: string;
        instructions: string;
      };
      expect(parsed.systemPrompt).toBe('SYSTEM-PROMPT-CONTENT');
      expect(parsed.instructions).toBe('INSTRUCTIONS-CONTENT');
    });
  });

  it('writing identical content twice produces a byte-identical file and no error', async () => {
    await withTempDir(async (dir) => {
      const address = fixtureAddress();
      const content = {
        systemPrompt: 'SAME-SYSTEM-PROMPT',
        instructions: 'SAME-INSTRUCTIONS',
      };

      const firstPath = await writePromptArtifact(dir, address, content);
      const firstBytes = await readFile(firstPath);

      const secondPath = await writePromptArtifact(dir, address, content);
      const secondBytes = await readFile(secondPath);

      expect(secondPath).toBe(firstPath);
      expect(secondBytes.equals(firstBytes)).toBe(true);
    });
  });

  it('writing different content for the same attempt is a named refusal, not a silent overwrite', async () => {
    await withTempDir(async (dir) => {
      const address = fixtureAddress();
      await writePromptArtifact(dir, address, {
        systemPrompt: 'ORIGINAL-SYSTEM-PROMPT',
        instructions: 'ORIGINAL-INSTRUCTIONS',
      });

      await expect(
        writePromptArtifact(dir, address, {
          systemPrompt: 'DIFFERENT-SYSTEM-PROMPT',
          instructions: 'DIFFERENT-INSTRUCTIONS',
        }),
      ).rejects.toThrow(PromptArtifactConflictError);

      // The original record is untouched.
      const path = promptArtifactPathFor(dir, address);
      const raw = await readFile(path, 'utf8');
      expect(raw).toContain('ORIGINAL-SYSTEM-PROMPT');
      expect(raw).not.toContain('DIFFERENT-SYSTEM-PROMPT');
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: the stage runner writes the artifact BEFORE the agent runs,
// and a write failure fails the attempt.
// ---------------------------------------------------------------------------

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
  await fsWriteFile(join(dir, 'spec.md'), SPEC_MARKDOWN, 'utf8');
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
  readonly logsRoot: string;
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
    logsRoot: overrides.logsRoot,
  };
}

/** A minimal, in-process `AgentRunner` — never launches a real subprocess. */
function checkingAgentRunner(onRun: () => void): AgentRunner {
  return {
    async probe() {
      return { usable: true, installedVersion: null, expectedVersion: 'test' };
    },
    async run() {
      onRun();
      return {
        outcome: 'completed',
        durationMs: 0,
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        },
      };
    },
  };
}

describe('createProductionStageRunner writes the prompt artifact before launching the agent', () => {
  it('the artifact exists on disk at the moment the agent runner is invoked', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      await withTempDir(async (logsRoot) => {
        const featureId = `feat-${ulid()}`;
        await writeFeatureSpec(mainRepo, featureId);
        await commitFeatureSpec(git, featureId);
        const baseRef = (await git.revparse(['HEAD'])).trim();

        const assign = buildAssign({
          featureId,
          mainRepo,
          scratchRoot,
          baseRef,
          logsRoot,
        });

        let artifactExistedAtRunStart = false;
        const runner = createProductionStageRunner({
          agentBackend: checkingAgentRunner(() => {
            const artifactPath = promptArtifactPathFor(assign.logsRoot, {
              featureId: assign.featureId,
              roundId: assign.roundId,
              stageId: assign.stageId,
              stageIndex: assign.stageIndex,
              attempt: 1,
            });
            artifactExistedAtRunStart = existsSync(artifactPath);
          }),
        });

        await runner(assign);

        expect(artifactExistedAtRunStart).toBe(true);
      });
    });
  }, 20_000);

  it('a failure writing the artifact fails the attempt rather than proceeding to launch the agent', async () => {
    await withTempRepo(async ({ mainRepo, scratchRoot, git }) => {
      await withTempDir(async (logsRoot) => {
        const featureId = `feat-${ulid()}`;
        await writeFeatureSpec(mainRepo, featureId);
        await commitFeatureSpec(git, featureId);
        const baseRef = (await git.revparse(['HEAD'])).trim();

        const assign = buildAssign({
          featureId,
          mainRepo,
          scratchRoot,
          baseRef,
          logsRoot,
        });

        // Force `writePromptArtifact` to fail WITHOUT touching the
        // transcript writer's own directory chain (the two files are
        // siblings under the same parent directory, so blocking the shared
        // parent would break both). Pre-create a DIRECTORY at the exact path
        // the prompt artifact FILE needs to occupy — `writePromptArtifact`'s
        // read-then-write both fail against a path that is a directory,
        // never a file.
        const artifactPath = promptArtifactPathFor(logsRoot, {
          featureId: assign.featureId,
          roundId: assign.roundId,
          stageId: assign.stageId,
          stageIndex: assign.stageIndex,
          attempt: 1,
        });
        await mkdir(artifactPath, { recursive: true });

        let agentWasInvoked = false;
        const runner = createProductionStageRunner({
          agentBackend: checkingAgentRunner(() => {
            agentWasInvoked = true;
          }),
        });

        const result = await runner(assign);
        const verdict = JSON.parse(result.verdictJson) as StageRunnerVerdict;

        expect(agentWasInvoked).toBe(false);
        expect(verdict.kind).toBe('stage_error');
      });
    });
  }, 20_000);
});
