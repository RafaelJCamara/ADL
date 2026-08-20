import { describe, expect, it } from 'vitest';
import { statusCommand } from '../src/commands/status.js';
import type { FeatureRow } from '../src/render/status-table.js';
import type { DaemonClient } from '../src/http-client.js';
import { buildProgram, type CliConfig } from '../src/index.js';

/**
 * Phase 3 Plan 08, Task 1: the status view (D-22..25) — the empty state, the
 * full column set, stable ordering, and the daemon-down path.
 */

class CapturingSink {
  readonly chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  text(): string {
    return this.chunks.join('');
  }
}

function fakeClient(rows: readonly FeatureRow[]): DaemonClient {
  return {
    getFeatures: async () => rows,
    postFeatureControl: async () => ({ affected: [] }),
    postControl: async () => ({ affected: [] }),
    postGc: async () => ({
      worktreesRemoved: [],
      scratchHomesRemoved: [],
      worktreeFailures: [],
      scratchHomeFailures: [],
    }),
    postShutdown: async () => {},
    postDevRun: async (featureId) => ({
      featureId,
      stageAttemptId: 'attempt-1',
    }),

    streamStageLogs: async function* () {},
  };
}

const SAMPLE_ROW: FeatureRow = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  repoId: 'repo-1',
  path: 'features/thing',
  state: 'gating',
  stage: {
    state: 'gating',
    position: 2,
    pipelineLength: 4,
    name: 'test',
    label: 'gating 2/4 (test)',
  },
  round: 1,
  ageMs: 65_000,
  worker: { pid: 4242 },
  staleRejections: 0,
};

describe('statusCommand', () => {
  it('--json against zero features prints exactly [] and exits 0', async () => {
    const stdout = new CapturingSink();
    await statusCommand({ json: true }, { client: fakeClient([]), stdout });
    expect(stdout.text().trim()).toBe('[]');
  });

  it('against zero features prints a line that is not solely column headers', async () => {
    const stdout = new CapturingSink();
    await statusCommand({ json: false }, { client: fakeClient([]), stdout });
    const text = stdout.text();
    expect(text).not.toBe('');
    expect(text.toUpperCase()).not.toContain('FEATURE  REPO  STATE');
    expect(text).toContain('No features in flight.');
  });

  it('two consecutive --json calls with no state change produce identical output', async () => {
    const client = fakeClient([SAMPLE_ROW]);
    const first = new CapturingSink();
    const second = new CapturingSink();
    await statusCommand({ json: true }, { client, stdout: first });
    await statusCommand({ json: true }, { client, stdout: second });
    expect(first.text()).toBe(second.text());
  });

  it('renders two identical-looking features as two separate table rows', async () => {
    const stdout = new CapturingSink();
    const rowB: FeatureRow = {
      ...SAMPLE_ROW,
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    };
    await statusCommand(
      { json: false },
      { client: fakeClient([SAMPLE_ROW, rowB]), stdout },
    );
    const dataLines = stdout.text().trim().split('\n').slice(1); // drop the header row
    expect(dataLines).toHaveLength(2);
  });

  it('the table renders the resolved stage label', async () => {
    const stdout = new CapturingSink();
    await statusCommand(
      { json: false },
      { client: fakeClient([SAMPLE_ROW]), stdout },
    );
    expect(stdout.text()).toContain('gating 2/4 (test)');
  });
});

describe('adl status — daemon down', () => {
  it('exits 1 and prints D-25s message to stderr with the real host and port', async () => {
    const host = '127.0.0.1';
    // Port 1 is a reserved/unbound low port on every platform this test
    // runs on, guaranteeing a connection refusal without binding anything.
    const port = 1;
    const loadConfig = (): CliConfig => ({ host, port, token: 'irrelevant' });

    const stdout = new CapturingSink();
    const stderr = new CapturingSink();
    const program = buildProgram({ loadConfig, stdout, stderr });
    program.exitOverride();

    // `runVerb` sets the real `process.exitCode` — save and restore it so
    // asserting a CLI verb's exit code here does not leak into vitest's own
    // process exit status.
    const originalExitCode = process.exitCode;
    try {
      await program.parseAsync(['node', 'adl', 'status'], { from: 'node' });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }

    expect(stderr.text()).toContain(
      `Cannot reach the ADL daemon at ${host}:${port}`,
    );
    expect(stderr.text()).toContain('Is it running? Try: adl daemon start');
  }, 10_000);
});
