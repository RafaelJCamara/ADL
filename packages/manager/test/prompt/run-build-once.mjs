// A real, separate process — `buildDeveloperPrompt`'s determinism claim is
// "byte-identical across two processes", and that claim is not provable from
// inside the one process running the test. Run under `tsx` (this repo's own
// dev-loop runner, already the project's precedent for a scripted double —
// see `test/helpers/scripted-worker-entry.ts` in this same package) so the
// TypeScript sources need no build step.
import {
  DEFAULT_CONFIG,
  DaemonConfigSchema,
  mergeConfig,
  AdlYmlSchema,
} from '@adl/core/config';
import { loadAdlTemplateSpec } from '@adl/core/spec';
import { buildDeveloperPrompt } from '../../src/prompt/build.js';

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
const spec = loadAdlTemplateSpec(SPEC_MARKDOWN, 'export-widget');

const result = buildDeveloperPrompt({
  spec,
  effectiveConfig: config,
  capabilities: {
    emitsIncrementalEvents: true,
    reportsUsage: true,
    reportsCost: true,
    supportsSessionResume: true,
    enforcesTurnCap: true,
  },
});

process.stdout.write(JSON.stringify(result));
