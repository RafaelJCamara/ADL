// This test proves determinism ACROSS PROCESSES by launching a real second
// Node process running `run-build-once.mjs` — test infrastructure, not ADL
// orchestration code reaching past `Workspace.exec()` (WORK-02's subject).
// eslint-disable-next-line no-restricted-imports -- test-only cross-process determinism proof, see comment above
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  DaemonConfigSchema,
  mergeConfig,
  type DaemonConfig,
} from '@adl/core/config';
import { AdlYmlSchema, type AdlYml } from '@adl/core/config';
import { loadAdlTemplateSpec } from '@adl/core/spec';
import type { AgentCapabilities } from '@adl/core/stage';
import type { SendBackBrief } from '@adl/core/verdict';
import {
  buildDeveloperPrompt,
  PromptContextOverflowError,
} from '../../src/prompt/build.js';

/**
 * Phase 4 Plan 09, Task 1: the explicit-context surface and the determinism
 * proof (see `build.ts`'s own module docblock).
 */

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'adl-prompt-build-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CAPABILITIES: AgentCapabilities = {
  emitsIncrementalEvents: true,
  reportsUsage: true,
  reportsCost: true,
  supportsSessionResume: true,
  enforcesTurnCap: true,
};

function emptyDaemon(): DaemonConfig {
  const result = DaemonConfigSchema.safeParse({});
  if (!result.success) throw new Error('empty daemon config failed to parse');
  return result.data;
}

function baseRepo(): AdlYml {
  const result = AdlYmlSchema.safeParse({
    version: 1,
    commands: {
      build: { argv: ['npm', 'ci'] },
      start: { argv: ['npm', 'run', 'dev'] },
      test: { argv: ['npm', 'test'] },
      teardown: { argv: ['docker', 'compose', 'down'] },
    },
    pipeline: ['develop', 'review', 'test'],
  });
  if (!result.success) {
    throw new Error(
      `fixture adl.yml failed to parse: ${JSON.stringify(result.error.issues)}`,
    );
  }
  return result.data;
}

const SPEC_MARKDOWN = `# Title

Widget export

## Intent

Let a user export their widget as a file.

## Acceptance Criteria

- The export button appears on the widget page.
- Clicking it downloads a \`.widget\` file with a \`$&\` literal dollar-ampersand marker and a \`$$\` double-dollar marker in the criterion text, exercising the substitution safety this module's own docblock names.

## Non-Goals

- Import is not covered by this feature.
`;

function fixtureSpec() {
  return loadAdlTemplateSpec(SPEC_MARKDOWN, 'export-widget');
}

function fixtureInput() {
  const { config } = mergeConfig(DEFAULT_CONFIG, emptyDaemon(), baseRepo());
  return {
    spec: fixtureSpec(),
    effectiveConfig: config,
    capabilities: CAPABILITIES,
    // `baseRepo()` declares no `context.files`, so this value is never read
    // — a fixed literal, matching `run-build-once.mjs`'s own fixture value,
    // rather than a real directory.
    workspaceRoot: '/adl-fixture-workspace-root',
  };
}

function repoWithContextFiles(files: readonly string[], maxBytes = 200_000) {
  const result = AdlYmlSchema.safeParse({
    version: 1,
    commands: {
      build: { argv: ['npm', 'ci'] },
      start: { argv: ['npm', 'run', 'dev'] },
      test: { argv: ['npm', 'test'] },
      teardown: { argv: ['docker', 'compose', 'down'] },
    },
    pipeline: ['develop', 'review', 'test'],
    context: { files, max_bytes: maxBytes },
  });
  if (!result.success) {
    throw new Error(
      `fixture adl.yml (context.files) failed to parse: ${JSON.stringify(result.error.issues)}`,
    );
  }
  return result.data;
}

describe('buildDeveloperPrompt', () => {
  it('renders byte-identical output on two calls in the same process', () => {
    const input = fixtureInput();
    const first = buildDeveloperPrompt(input);
    const second = buildDeveloperPrompt(input);
    expect(second).toEqual(first);
  });

  it('renders byte-identical output in a fresh process', () => {
    const input = fixtureInput();
    const inProcess = buildDeveloperPrompt(input);

    const scriptPath = fileURLToPath(
      new URL('./run-build-once.mjs', import.meta.url),
    );
    const raw = execFileSync(
      process.execPath,
      ['--import', 'tsx', scriptPath],
      {
        encoding: 'utf8',
        env: { ...process.env },
      },
    );
    const fresh = JSON.parse(raw) as {
      systemPrompt: string;
      instructions: string;
    };

    expect(fresh).toEqual(inProcess);
  });

  it('includes the raw spec text verbatim, alongside the identified criteria checklist', () => {
    const { instructions } = buildDeveloperPrompt(fixtureInput());
    expect(instructions).toContain(SPEC_MARKDOWN.trim());
  });

  it('interpolates untrusted spec content literally — a "$&"/"$$" sequence in the spec text is not treated as a replace() special sequence', () => {
    const { instructions } = buildDeveloperPrompt(fixtureInput());
    expect(instructions).toContain('`$&` literal dollar-ampersand marker');
    expect(instructions).toContain('`$$` double-dollar marker');
  });

  it('iterates acceptance criteria in their existing (positional) order', () => {
    const { instructions } = buildDeveloperPrompt(fixtureInput());
    const firstIdx = instructions.indexOf('AC-1');
    const secondIdx = instructions.indexOf('AC-2');
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it('never interpolates a timestamp or a random id', () => {
    const a = buildDeveloperPrompt(fixtureInput());
    const b = buildDeveloperPrompt(fixtureInput());
    expect(a).toEqual(b);
    // No ISO-8601-shaped substring anywhere in the rendered instructions.
    expect(a.instructions).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('the rendered prompt contains no value read from the process environment', () => {
    const marker = 'ADL-DISTINCTIVE-ENV-MARKER-7f3c9a';
    const previous = process.env['ADL_TEST_ENV_LEAK_CHECK'];
    process.env['ADL_TEST_ENV_LEAK_CHECK'] = marker;
    try {
      const { instructions, systemPrompt } =
        buildDeveloperPrompt(fixtureInput());
      expect(instructions).not.toContain(marker);
      expect(systemPrompt).not.toContain(marker);
    } finally {
      if (previous === undefined) {
        delete process.env['ADL_TEST_ENV_LEAK_CHECK'];
      } else {
        process.env['ADL_TEST_ENV_LEAK_CHECK'] = previous;
      }
    }
  });

  describe('declared context files (the explicit-context surface)', () => {
    it('rendering with no declared context files still succeeds, including the raw spec and criteria checklist', () => {
      const { instructions } = buildDeveloperPrompt(fixtureInput());
      expect(instructions).toContain('(no repository context files declared)');
      expect(instructions).toContain(SPEC_MARKDOWN.trim());
      expect(instructions).toContain('AC-1');
    });

    it('renders two declared context files — path and content, in declared order', async () => {
      await withTempDir(async (dir) => {
        await writeFile(
          join(dir, 'AGENTS.md'),
          'AGENTS-FILE-CONTENT-MARKER',
          'utf8',
        );
        await writeFile(
          join(dir, 'notes.md'),
          'NOTES-FILE-CONTENT-MARKER',
          'utf8',
        );

        const { config } = mergeConfig(
          DEFAULT_CONFIG,
          emptyDaemon(),
          repoWithContextFiles(['AGENTS.md', 'notes.md']),
        );

        const { instructions } = buildDeveloperPrompt({
          spec: fixtureSpec(),
          effectiveConfig: config,
          capabilities: CAPABILITIES,
          workspaceRoot: dir,
        });

        expect(instructions).toContain('AGENTS.md');
        expect(instructions).toContain('AGENTS-FILE-CONTENT-MARKER');
        expect(instructions).toContain('notes.md');
        expect(instructions).toContain('NOTES-FILE-CONTENT-MARKER');
        // Declared order: AGENTS.md before notes.md.
        expect(instructions.indexOf('AGENTS-FILE-CONTENT-MARKER')).toBeLessThan(
          instructions.indexOf('NOTES-FILE-CONTENT-MARKER'),
        );
      });
    });

    it('a repository instruction file present on disk but NOT declared does not appear in the rendered prompt', async () => {
      await withTempDir(async (dir) => {
        await writeFile(join(dir, 'AGENTS.md'), 'DECLARED-FILE-MARKER', 'utf8');
        // Present on disk, never named in context.files — presence is not consent.
        await writeFile(
          join(dir, 'CLAUDE.md'),
          'UNDECLARED-CLAUDE-MD-MARKER-should-never-appear',
          'utf8',
        );

        const { config } = mergeConfig(
          DEFAULT_CONFIG,
          emptyDaemon(),
          repoWithContextFiles(['AGENTS.md']),
        );

        const { instructions } = buildDeveloperPrompt({
          spec: fixtureSpec(),
          effectiveConfig: config,
          capabilities: CAPABILITIES,
          workspaceRoot: dir,
        });

        expect(instructions).toContain('DECLARED-FILE-MARKER');
        expect(instructions).not.toContain(
          'UNDECLARED-CLAUDE-MD-MARKER-should-never-appear',
        );
        expect(instructions).not.toContain('CLAUDE.md');
      });
    });

    it('a declared context file exceeding the configured cap is truncated head-and-tail with an elision marker, deterministically', async () => {
      await withTempDir(async (dir) => {
        const big = `HEAD-MARKER-${'x'.repeat(5000)}TAIL-MARKER`;
        await writeFile(join(dir, 'BIG.md'), big, 'utf8');

        // 200 bytes leaves enough of the head/tail budget (after the elision
        // marker's own ~88 bytes) for both full markers to survive intact —
        // a tighter cap would legitimately chop into the marker text itself,
        // which is exercised separately below.
        const { config } = mergeConfig(
          DEFAULT_CONFIG,
          emptyDaemon(),
          repoWithContextFiles(['BIG.md'], 200),
        );

        const input = {
          spec: fixtureSpec(),
          effectiveConfig: config,
          capabilities: CAPABILITIES,
          workspaceRoot: dir,
        };

        const first = buildDeveloperPrompt(input);
        const second = buildDeveloperPrompt(input);

        expect(first).toEqual(second);
        expect(first.instructions).toContain('[... elided:');
        expect(first.instructions).toContain('HEAD-MARKER-');
        expect(first.instructions).toContain('TAIL-MARKER');
        // The full unelided middle run of 'x's must not survive truncation.
        expect(first.instructions).not.toContain('x'.repeat(5000));
      });
    });

    it('on_overflow: "error" refuses rather than silently truncating', async () => {
      await withTempDir(async (dir) => {
        await writeFile(join(dir, 'BIG.md'), 'x'.repeat(5000), 'utf8');

        const result = AdlYmlSchema.safeParse({
          version: 1,
          commands: {
            build: { argv: ['npm', 'ci'] },
            start: { argv: ['npm', 'run', 'dev'] },
            test: { argv: ['npm', 'test'] },
            teardown: { argv: ['docker', 'compose', 'down'] },
          },
          pipeline: ['develop'],
          context: { files: ['BIG.md'], max_bytes: 100, on_overflow: 'error' },
        });
        if (!result.success) {
          throw new Error(
            `fixture adl.yml failed to parse: ${JSON.stringify(result.error.issues)}`,
          );
        }
        const { config } = mergeConfig(
          DEFAULT_CONFIG,
          emptyDaemon(),
          result.data,
        );

        expect(() =>
          buildDeveloperPrompt({
            spec: fixtureSpec(),
            effectiveConfig: config,
            capabilities: CAPABILITIES,
            workspaceRoot: dir,
          }),
        ).toThrow(PromptContextOverflowError);
      });
    });
  });

  describe('the send-back brief (LOOP-02, M05 step 5.15)', () => {
    it('round 1 (no brief) renders a fixed, deterministic placeholder', () => {
      const { instructions } = buildDeveloperPrompt(fixtureInput());
      expect(instructions).toContain('(first round — no prior feedback)');
    });

    it("renders a finding's severity, title, criterion, location and detail", () => {
      const brief: SendBackBrief = {
        findings: [
          {
            fingerprint: 'a'.repeat(64),
            severity: 'blocker',
            title: 'the test command failed (exit 1)',
            detail: 'FAIL: 1 test failed',
            criterionRef: { kind: 'global', category: 'build' },
            location: { path: 'src/widget.ts', line: 42 },
            suggestedAction: 'fix the failing assertion',
          },
        ],
      };

      const { instructions } = buildDeveloperPrompt({
        ...fixtureInput(),
        sendBackBrief: brief,
      });

      expect(instructions).toContain('[blocker]');
      expect(instructions).toContain('the test command failed (exit 1)');
      expect(instructions).toContain('global / build');
      expect(instructions).toContain('src/widget.ts:42');
      expect(instructions).toContain('FAIL: 1 test failed');
      expect(instructions).toContain('fix the failing assertion');
      expect(instructions).not.toContain('(first round — no prior feedback)');
    });

    it('renders a finding tied to an acceptance criterion, with no location and no suggested action', () => {
      const brief: SendBackBrief = {
        findings: [
          {
            fingerprint: 'b'.repeat(64),
            severity: 'major',
            title: 'AC-2 is not satisfied',
            detail: 'the export button never appears',
            criterionRef: { kind: 'criterion', id: 'AC-2' },
          },
        ],
      };

      const { instructions } = buildDeveloperPrompt({
        ...fixtureInput(),
        sendBackBrief: brief,
      });

      expect(instructions).toContain('[major] AC-2 is not satisfied');
      expect(instructions).toContain('Criterion: AC-2');
      expect(instructions).not.toContain('Location:');
      expect(instructions).not.toContain('Suggested action:');
    });

    it('renders multiple findings in the brief’s own order — never re-sorted', () => {
      const brief: SendBackBrief = {
        findings: [
          {
            fingerprint: 'c'.repeat(64),
            severity: 'minor',
            title: 'FINDING-FIRST',
            detail: 'first detail',
            criterionRef: { kind: 'global', category: 'other' },
          },
          {
            fingerprint: 'd'.repeat(64),
            severity: 'blocker',
            title: 'FINDING-SECOND',
            detail: 'second detail',
            criterionRef: { kind: 'global', category: 'other' },
          },
        ],
      };

      const { instructions } = buildDeveloperPrompt({
        ...fixtureInput(),
        sendBackBrief: brief,
      });

      expect(instructions.indexOf('FINDING-FIRST')).toBeLessThan(
        instructions.indexOf('FINDING-SECOND'),
      );
    });

    it('is a pure function of the brief — same input, byte-identical output', () => {
      const brief: SendBackBrief = {
        findings: [
          {
            fingerprint: 'e'.repeat(64),
            severity: 'nit',
            title: 'a nit',
            detail: 'a detail',
            criterionRef: { kind: 'global', category: 'code_quality' },
          },
        ],
      };
      const input = { ...fixtureInput(), sendBackBrief: brief };

      const first = buildDeveloperPrompt(input);
      const second = buildDeveloperPrompt(input);
      expect(second).toEqual(first);
    });
  });
});
