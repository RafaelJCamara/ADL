import { runWorker, type StageRunner } from '../../src/worker-entry/index.js';
import type { WorkerToManagerMessage } from '../../src/ipc/protocol.js';

/**
 * A scripted worker entry for `test/usage/recording.test.ts` (04-10 Task 2)
 * — sends zero or more `usage` IPC messages of the test's own choosing
 * BEFORE completing its (trivially scripted) stage, so the supervisor's
 * fence and insert logic can be exercised directly against `createSupervisor`,
 * without a real Claude Code invocation.
 *
 * Configuration crosses the `fork()` boundary the only way data can — the
 * child's environment — mirroring `scripted-worker-entry.ts`'s own
 * `ADL_TEST_STAGE_DELAY_MS` precedent:
 *
 * - `ADL_TEST_USAGE_MESSAGES_JSON`: a JSON array of partial `usage` message
 *   payloads (every field except `t` and `leaseToken`; `leaseToken` defaults
 *   to the worker's own assigned lease token — set it explicitly to send a
 *   deliberately STALE token). Absent or `[]` sends none.
 * - `ADL_TEST_STAGE_DELAY_MS`: delay before completing the stage, so a test
 *   has time to observe the usage message(s) land before `stage_result`
 *   arrives. Defaults to 50ms.
 */

interface ScriptedUsagePayload {
  readonly leaseToken?: string;
  readonly modelId: string;
  readonly speed: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly costUsd: number | null;
  readonly costSource: string;
  readonly costCategory: string;
}

function readScriptedMessages(): readonly ScriptedUsagePayload[] {
  const raw = process.env['ADL_TEST_USAGE_MESSAGES_JSON'];
  if (raw === undefined) return [];
  return JSON.parse(raw) as readonly ScriptedUsagePayload[];
}

const delayMs = Number(process.env['ADL_TEST_STAGE_DELAY_MS'] ?? '50');
const scriptedMessages = readScriptedMessages();

let assignedLeaseToken: string | undefined;

function send(message: WorkerToManagerMessage): void {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

const stageRunner: StageRunner = async (assign) => {
  assignedLeaseToken = assign.leaseToken;
  for (const scripted of scriptedMessages) {
    send({
      t: 'usage',
      leaseToken: scripted.leaseToken ?? assignedLeaseToken,
      modelId: scripted.modelId,
      speed: scripted.speed,
      inputTokens: scripted.inputTokens,
      outputTokens: scripted.outputTokens,
      cacheCreationInputTokens: scripted.cacheCreationInputTokens,
      cacheReadInputTokens: scripted.cacheReadInputTokens,
      costUsd: scripted.costUsd,
      costSource: scripted.costSource as 'reported' | 'computed' | 'unknown',
      costCategory: scripted.costCategory as 'feature' | 'overhead',
    });
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return {
    verdictJson: JSON.stringify({
      outcome: 'skip',
      summary: 'scripted worker — usage-message double, no agent involved',
      findings: [],
    }),
  };
};

runWorker({ stageRunner });
