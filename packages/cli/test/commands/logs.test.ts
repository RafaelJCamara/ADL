import { describe, expect, it } from 'vitest';
import {
  InvalidLogsOffsetError,
  logsCommand,
  MAX_CONSECUTIVE_RECONNECT_FAILURES,
} from '../../src/commands/logs.js';
import {
  DaemonUnreachableError,
  daemonDownMessage,
  type DaemonClient,
  type StageLogEvent,
  type StreamStageLogsOptions,
} from '../../src/http-client.js';

/**
 * `adl logs` — `04-08`'s resumable follower. The manager's own follow loop
 * (`04-08`) now does the polling; this command's job is writing records as
 * they arrive and reconnecting — with the offset it actually WROTE, not
 * merely received — when the connection drops.
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

/** One simulated transcript record, matching what a `records` event's payload carries. */
function fakeRecord(seq: number) {
  return {
    seq,
    at: '2026-01-01T00:00:00.000Z',
    event: { kind: 'text', delta: `line ${seq}` },
  };
}

function recordsEvent(
  records: readonly unknown[],
  nextOffset: number,
): StageLogEvent {
  return { event: 'records', data: JSON.stringify({ records, nextOffset }) };
}

const endedEvent: StageLogEvent = { event: 'ended', data: '{}' };
const idleEvent: StageLogEvent = { event: 'idle', data: '{}' };
const pendingEvent: StageLogEvent = { event: 'pending', data: '{}' };

interface ScriptedConnection {
  readonly events: readonly StageLogEvent[];
  /** Thrown from the async generator immediately after yielding `events` — simulating a dropped connection. Omit for a clean end. */
  readonly thenThrow?: Error;
}

/** A fake `DaemonClient` whose `streamStageLogs` replays one scripted connection per call, recording the options each call was made with. */
function scriptedClient(
  connections: readonly ScriptedConnection[],
): DaemonClient & {
  readonly callsSeen: StreamStageLogsOptions[];
} {
  const callsSeen: StreamStageLogsOptions[] = [];
  let call = 0;
  return {
    callsSeen,
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

    streamStageLogs: async function* (_id, options) {
      callsSeen.push(options ?? {});
      const connection = connections[call];
      call += 1;
      if (connection === undefined) {
        throw new Error('scriptedClient: no more connections scripted');
      }
      for (const event of connection.events) yield event;
      if (connection.thenThrow !== undefined) throw connection.thenThrow;
    },
  };
}

describe('logsCommand', () => {
  it('without --follow, prints every event once and exits (resolves) without reconnecting', async () => {
    const stdout = new CapturingSink();
    const client = scriptedClient([
      { events: [recordsEvent([fakeRecord(0), fakeRecord(1)], 42)] },
    ]);

    await logsCommand(
      { stageAttemptId: 'attempt-1', follow: false },
      { client, stdout },
    );

    expect(stdout.text()).toContain(JSON.stringify(fakeRecord(0)));
    expect(stdout.text()).toContain(JSON.stringify(fakeRecord(1)));
    expect(client.callsSeen).toHaveLength(1);
  });

  it('with --follow, prints events as they arrive and exits 0 when the ended event is received', async () => {
    const stdout = new CapturingSink();
    const client = scriptedClient([
      { events: [recordsEvent([fakeRecord(0)], 10), idleEvent, endedEvent] },
    ]);

    await logsCommand(
      { stageAttemptId: 'attempt-1', follow: true },
      { client, stdout, sleep: async () => {} },
    );

    expect(stdout.text()).toContain(JSON.stringify(fakeRecord(0)));
    expect(client.callsSeen).toHaveLength(1);
  });

  it('does not exit on the nothing-new (idle) or not-yet-created (pending) states — only on ended', async () => {
    const stdout = new CapturingSink();
    const client = scriptedClient([
      {
        events: [
          pendingEvent,
          idleEvent,
          recordsEvent([fakeRecord(0)], 5),
          endedEvent,
        ],
      },
    ]);

    await logsCommand(
      { stageAttemptId: 'attempt-1', follow: true },
      { client, stdout, sleep: async () => {} },
    );

    expect(stdout.text()).toContain(JSON.stringify(fakeRecord(0)));
  });

  it('when the stream drops mid-way, reconnects with the offset of the last WRITTEN event', async () => {
    const stdout = new CapturingSink();
    const client = scriptedClient([
      {
        events: [recordsEvent([fakeRecord(0), fakeRecord(1)], 20)],
        thenThrow: new Error('simulated connection drop'),
      },
      { events: [recordsEvent([fakeRecord(2)], 30), endedEvent] },
    ]);

    await logsCommand(
      { stageAttemptId: 'attempt-1', follow: true },
      { client, stdout, sleep: async () => {} },
    );

    // The first call carried the caller's own starting offset (0, the
    // default); the reissued request carried the offset of the last
    // batch this client actually wrote (20), not merely received.
    expect(client.callsSeen[0]).toMatchObject({ offset: 0, follow: true });
    expect(client.callsSeen[1]).toMatchObject({ offset: 20, follow: true });
  });

  it('the concatenated output across a drop and a reconnect equals the source records exactly once each', async () => {
    const stdout = new CapturingSink();
    const source = [fakeRecord(0), fakeRecord(1), fakeRecord(2), fakeRecord(3)];
    const client = scriptedClient([
      {
        events: [recordsEvent([source[0]!, source[1]!], 20)],
        thenThrow: new Error('simulated connection drop'),
      },
      { events: [recordsEvent([source[2]!, source[3]!], 40), endedEvent] },
    ]);

    await logsCommand(
      { stageAttemptId: 'attempt-1', follow: true },
      { client, stdout, sleep: async () => {} },
    );

    const written = stdout
      .text()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    expect(written).toEqual(source);
  });

  it('stops after the stated maximum of consecutive reconnect failures and writes a message naming the count', async () => {
    const stdout = new CapturingSink();
    const failure = new Error('simulated connection drop');
    const connections: ScriptedConnection[] = [
      // One connection that delivers something, so hasConnectedOnce is
      // true and the daemon-down error path is not taken.
      { events: [recordsEvent([fakeRecord(0)], 10)], thenThrow: failure },
    ];
    // Every subsequent reconnect fails immediately with no events at all.
    for (let i = 0; i < MAX_CONSECUTIVE_RECONNECT_FAILURES + 2; i += 1) {
      connections.push({ events: [], thenThrow: failure });
    }
    const client = scriptedClient(connections);

    await logsCommand(
      { stageAttemptId: 'attempt-1', follow: true },
      {
        client,
        stdout,
        sleep: async () => {},
        maxConsecutiveReconnectFailures: MAX_CONSECUTIVE_RECONNECT_FAILURES,
      },
    );

    expect(stdout.text()).toContain(
      String(MAX_CONSECUTIVE_RECONNECT_FAILURES + 1),
    );
    expect(stdout.text()).toContain('giving up');
    // 1 initial connection + (MAX + 1) failed reconnects before giving up.
    expect(client.callsSeen.length).toBe(
      MAX_CONSECUTIVE_RECONNECT_FAILURES + 2,
    );
  });

  it('an unreachable daemon at first attach reports the existing daemon-down message and a non-zero-worthy error, not a second message', async () => {
    const stdout = new CapturingSink();
    const client: DaemonClient = {
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
      postDevRun: async (featureId) => ({ featureId, stageAttemptId: 'x' }),
      streamStageLogs: async function* () {
        throw new DaemonUnreachableError('127.0.0.1', 4173);
      },
    };

    await expect(
      logsCommand(
        { stageAttemptId: 'attempt-1', follow: true },
        { client, stdout, sleep: async () => {} },
      ),
    ).rejects.toThrow(DaemonUnreachableError);
    await expect(
      logsCommand(
        { stageAttemptId: 'attempt-1', follow: true },
        { client, stdout, sleep: async () => {} },
      ),
    ).rejects.toThrow(daemonDownMessage('127.0.0.1', 4173));
  });

  it('rejects a non-numeric --offset before any client call is made', async () => {
    const stdout = new CapturingSink();
    const client = scriptedClient([{ events: [endedEvent] }]);

    await expect(
      logsCommand(
        { stageAttemptId: 'attempt-1', follow: false, offset: 'abc' },
        { client, stdout },
      ),
    ).rejects.toThrow(InvalidLogsOffsetError);
    expect(client.callsSeen).toHaveLength(0);
  });

  it('a negative --offset is also rejected before any client call is made', async () => {
    const stdout = new CapturingSink();
    const client = scriptedClient([{ events: [endedEvent] }]);

    await expect(
      logsCommand(
        { stageAttemptId: 'attempt-1', follow: false, offset: '-1' },
        { client, stdout },
      ),
    ).rejects.toThrow(InvalidLogsOffsetError);
    expect(client.callsSeen).toHaveLength(0);
  });

  it('writes output incrementally — a record is written before the stream ends, observable on the injected sink', async () => {
    const writes: string[] = [];
    const observingSink = {
      write(chunk: string): void {
        writes.push(chunk);
      },
    };
    const client = scriptedClient([
      {
        events: [
          recordsEvent([fakeRecord(0)], 5),
          recordsEvent([fakeRecord(1)], 10),
          endedEvent,
        ],
      },
    ]);

    await logsCommand(
      { stageAttemptId: 'attempt-1', follow: true },
      { client, stdout: observingSink, sleep: async () => {} },
    );

    // Two separate write() calls, one per records batch — not one
    // accumulate-then-flush call at the very end.
    expect(writes.filter((w) => w.includes('"seq"'))).toHaveLength(2);
  });

  it('honours a caller-supplied --offset as the starting point', async () => {
    const stdout = new CapturingSink();
    const client = scriptedClient([{ events: [endedEvent] }]);

    await logsCommand(
      { stageAttemptId: 'attempt-1', follow: false, offset: '123' },
      { client, stdout },
    );

    expect(client.callsSeen[0]).toMatchObject({ offset: 123, follow: false });
  });
});
