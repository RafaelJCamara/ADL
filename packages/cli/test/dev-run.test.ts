import { describe, expect, it } from 'vitest';
import { devRunCommand } from '../src/commands/dev-run.js';
import type { DaemonClient, DevRunResult } from '../src/http-client.js';

class CapturingSink {
  readonly chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  text(): string {
    return this.chunks.join('');
  }
}

function fakeClient(result: DevRunResult): DaemonClient {
  return {
    getFeatures: async () => [],
    postFeatureControl: async () => ({ affected: [] }),
    postControl: async () => ({ affected: [] }),
    postGc: async () => ({
      worktreesRemoved: [],
      scratchHomesRemoved: [],
      worktreeFailures: [],
      scratchHomeFailures: [],
    }),
    postShutdown: async () => {},
    postDevRun: async () => result,
    streamStageLogs: async function* () {},
  };
}

describe('devRunCommand', () => {
  it('posts the feature id and prints the dispatched ids plus the follow-up adl logs command', async () => {
    const stdout = new CapturingSink();
    const client = fakeClient({
      featureId: 'feat-abc',
      stageAttemptId: 'attempt-xyz',
    });

    await devRunCommand({ featureId: 'feat-abc' }, { client, stdout });

    expect(stdout.text()).toContain('feat-abc');
    expect(stdout.text()).toContain('attempt-xyz');
    expect(stdout.text()).toContain('adl logs -f attempt-xyz');
  });
});
