import { once } from 'node:events';
import type { FeaturesTable } from '@adl/db';
import { describe, expect, it } from 'vitest';
import { createSupervisor } from '../../src/index.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';
import { withHeldWorker } from '../helpers/worker-harness.js';

/**
 * The supervisor's message-task `.catch` says what was LOST, by level.
 *
 * That task also records spend (`usage`), closes the round (`stage_result`) and
 * handles a worker's last words (`fatal`); a rejection from any of them is state
 * the worker will not send again, and logging it at the level of a dropped
 * heartbeat (the next one lands) made a lost spend row look like a shutdown race.
 * The message does not guess a cause: the error is attached.
 *
 * pino levels: 40 = warn, 50 = error.
 */
const LEASE_TOKEN = 'lease-token-message-failure';
const FEATURE_ID = 'feature-message-failure';

const feature = {
  id: FEATURE_ID,
  repo_id: 'repo-message-failure',
  path: `features/${FEATURE_ID}`,
} as unknown as FeaturesTable;

const MESSAGES = {
  heartbeat: {
    t: 'heartbeat',
    leaseToken: LEASE_TOKEN,
    at: '2026-01-01T00:00:00.000Z',
  },
  usage: {
    t: 'usage',
    leaseToken: LEASE_TOKEN,
    modelId: 'claude-sonnet-5',
    speed: 'standard',
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: 0.01,
    costSource: 'reported',
    costCategory: 'feature',
  },
  stage_result: {
    t: 'stage_result',
    leaseToken: LEASE_TOKEN,
    roundId: 0,
    stageIndex: 0,
    verdictJson: '{}',
  },
  fatal: { t: 'fatal', leaseToken: LEASE_TOKEN, reason: 'the worker gave up' },
} as const;

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('a rejected worker-message task is logged at the level of what it lost', () => {
  it.each([
    ['heartbeat', 40],
    ['usage', 50],
    ['stage_result', 50],
    ['fatal', 50],
  ] as const)(
    'logs a failed %s message at level %i, with the kind and the error',
    async (kind, level) => {
      const worker = withHeldWorker();
      const { logger, logs } = createCapturingLogger();
      let ready = false;
      const supervisor = createSupervisor({
        entryPath: worker.entryPath,
        cwd: worker.cwd,
        execArgv: worker.execArgv,
        logger,
        leaseTtlMs: 60_000,
        renewLease: async () => true,
        onReady: () => {
          ready = true;
        },
        // Every lease-scoped message is fenced first; failing the fence is the
        // cheapest way to make the task reject, whatever the kind.
        getCurrentLeaseToken: async () => {
          throw new Error('the database is on fire');
        },
      });
      const entry = supervisor.spawn(feature, LEASE_TOKEN, {
        t: 'assign',
        featureId: FEATURE_ID,
        leaseToken: LEASE_TOKEN,
        workspaceHandle: `features/${FEATURE_ID}`,
        effectiveConfigJson: '{}',
        heartbeatIntervalMs: 3_600_000,
        mainRepo: '/main/repo',
        scratchRoot: '/main/repo/.adl/scratch',
        logsRoot: '/main/repo/.adl/logs',
        baseRef: 'main',
        workspaceBackendId: 'worktree',
        roundId: 'round-1',
        stageAttemptId: 'attempt-1',
        stageId: 'develop',
        stageIndex: 0,
      });
      try {
        await waitUntil(() => ready);

        entry.worker.child.emit('message', MESSAGES[kind]);
        await waitUntil(() =>
          logs.some((line) => String(line.msg).includes('could not process')),
        );

        const line = logs.find((entry) =>
          String(entry.msg).includes('could not process'),
        );
        expect(line).toMatchObject({ level, kind });
        // The error travels with the record, and the message asserts no cause.
        expect(String(line?.msg)).toContain(`'${kind}'`);
        expect(String(line?.msg)).not.toMatch(/closing/);
        expect(JSON.stringify(line)).toContain('the database is on fire');
      } finally {
        const exited = once(entry.worker.child, 'exit');
        entry.worker.child.kill('SIGKILL');
        await exited;
      }
    },
    30_000,
  );
});
