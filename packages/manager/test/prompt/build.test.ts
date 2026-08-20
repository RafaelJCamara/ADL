// This test proves determinism ACROSS PROCESSES by launching a real second
// Node process running `run-build-once.mjs` — test infrastructure, not ADL
// orchestration code reaching past `Workspace.exec()` (WORK-02's subject).
// eslint-disable-next-line no-restricted-imports -- test-only cross-process determinism proof, see comment above
import { execFileSync } from 'node:child_process';
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
import { buildDeveloperPrompt } from '../../src/prompt/build.js';

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
  };
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
});
