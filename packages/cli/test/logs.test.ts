import { describe, expect, it } from 'vitest';
import { logsCommand } from '../src/commands/logs.js';
import type { DaemonClient, StageLogEvent } from '../src/http-client.js';

class CapturingSink {
  readonly chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  text(): string {
    return this.chunks.join('');
  }
}

function fakeClient(
  pollResponses: readonly (readonly StageLogEvent[])[],
): DaemonClient & { readonly offsetsRequested: (number | undefined)[] } {
  const offsetsRequested: (number | undefined)[] = [];
  let call = 0;
  return {
    offsetsRequested,
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
    postDevRun: async (featureId) => ({
      featureId,
      stageAttemptId: 'attempt-1',
    }),

    streamStageLogs: async function* (_id, offset) {
      offsetsRequested.push(offset);
      const events = pollResponses[call] ?? [];
      call += 1;
      for (const event of events) yield event;
    },
  };
}

describe('logsCommand', () => {
  it('without --follow, polls once and writes each record event to stdout', async () => {
    const stdout = new CapturingSink();
    const client = fakeClient([
      [
        { event: 'record', data: '{"seq":0}' },
        { event: 'record', data: '{"seq":1}' },
        { event: 'offset', data: '{"nextOffset":42}' },
      ],
    ]);

    await logsCommand(
      { stageAttemptId: 'attempt-1', follow: false },
      { client, stdout },
    );

    expect(stdout.text()).toContain('{"seq":0}');
    expect(stdout.text()).toContain('{"seq":1}');
    expect(stdout.text()).not.toContain('nextOffset');
    expect(client.offsetsRequested).toEqual([0]);
  });

  it('with --follow, advances the offset across polls and stops when shouldStop returns true', async () => {
    const stdout = new CapturingSink();
    const client = fakeClient([
      [
        { event: 'record', data: '{"seq":0}' },
        { event: 'offset', data: '{"nextOffset":10}' },
      ],
      [
        { event: 'record', data: '{"seq":1}' },
        { event: 'offset', data: '{"nextOffset":20}' },
      ],
    ]);

    let polls = 0;
    await logsCommand(
      { stageAttemptId: 'attempt-1', follow: true },
      {
        client,
        stdout,
        sleep: async () => {
          polls += 1;
        },
        shouldStop: () => polls >= 1,
      },
    );

    expect(stdout.text()).toContain('{"seq":0}');
    expect(stdout.text()).toContain('{"seq":1}');
    expect(client.offsetsRequested).toEqual([0, 10]);
  });
});
