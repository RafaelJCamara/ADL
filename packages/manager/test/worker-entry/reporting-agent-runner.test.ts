import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunResult, AgentTask } from '@adl/core/stage';
import type {
  AgentUsageRecord,
  ClaudeCodeAgentRunner,
} from '@adl/agent-claude-code';
import { reportingAgentRunner } from '../../src/worker-entry/stage-runner.js';
import type { WorkerToManagerMessage } from '../../src/ipc/protocol.js';

/**
 * D-5-18-1, closed by construction (M07 step 7.1).
 *
 * The debt asked for a channel through which a gate-invoked agent reports its
 * spend. `GateContext` deliberately has no such member: a channel on the *gate*
 * is a call a gate can forget to make, and after M06 a forgotten call is spend
 * that never reaches 6.4's per-feature budget or 6.5's global cap — an agent
 * gate would burn tokens while the budget gates kept running as though it had
 * not. So the obligation sits on the runner a gate is handed, and this file
 * asserts that the runner really carries it.
 *
 * **What this does not prove.** No gate calls a model until 7.4's reviewer
 * exists, so there is no end-to-end path through the real stage runner to
 * observe yet. This tests the mechanism; 7.4 is where a real invocation runs
 * through it, and the milestone file says so rather than leaving the gap
 * implied.
 */

/** The shape `sendUsage` puts on the wire, narrowed to the discriminant we assert on. */
type UsageMessage = Extract<WorkerToManagerMessage, { t: 'usage' }>;

const TASK: AgentTask = {
  systemPrompt: 'you are a gate',
  instructions: 'judge the diff',
  contextFiles: [],
  limits: { maxWallClockMs: 1_000 },
};

const RUN_CONTEXT = {
  workspace: {} as never,
  onEvent: () => {},
  signal: new AbortController().signal,
};

const COMPLETED: AgentRunResult = {
  outcome: 'completed',
  durationMs: 1,
  usage: {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  },
};

/**
 * Stand in for `process.send`, which is defined only in a forked child.
 *
 * Restored in `afterEach` rather than left assigned: a leaked `process.send`
 * would make every later test in this worker think it was forked, which is the
 * kind of cross-file contamination that shows up as an unrelated flake.
 */
function captureSends(): UsageMessage[] {
  const sent: UsageMessage[] = [];
  (process as { send?: unknown }).send = (message: WorkerToManagerMessage) => {
    if (message.t === 'usage') sent.push(message);
    return true;
  };
  return sent;
}

const ORIGINAL_SEND = process.send;

afterEach(() => {
  (process as { send?: unknown }).send = ORIGINAL_SEND;
});

/** One priceable usage record, the shape a real completed invocation produces. */
const USAGE: AgentUsageRecord = {
  modelId: 'claude-haiku-4-5',
  speed: 'standard',
  inputTokens: 10,
  outputTokens: 5,
  cacheCreationInputTokens: null,
  cacheReadInputTokens: null,
  costUsd: 0.001,
  costSource: 'reported',
  costCategory: 'feature',
};

/** A runner that reports the usage record it was constructed with, or none. */
function runnerReporting(
  usageRecord: AgentUsageRecord | undefined,
): ClaudeCodeAgentRunner {
  return {
    run: () =>
      Promise.resolve(
        usageRecord === undefined ? COMPLETED : { ...COMPLETED, usageRecord },
      ),
    probe: () =>
      Promise.resolve({
        usable: true,
        installedVersion: '1.0.0',
        expectedVersion: '1.0.0',
      }),
  };
}

describe('reportingAgentRunner', () => {
  it('sends one usage message per invocation, carrying the lease token it was built with', async () => {
    const sent = captureSends();
    const runner = reportingAgentRunner(runnerReporting(USAGE), 'lease-abc');

    await runner.run(TASK, RUN_CONTEXT);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.leaseToken).toBe('lease-abc');
    expect(sent[0]?.modelId).toBe('claude-haiku-4-5');
    expect(sent[0]?.costSource).toBe('reported');
  });

  it('sends nothing when the run reported no usage at all', async () => {
    // `usageRecord` absent means the agent process was never started, so
    // nothing was invoked and nothing was billed. A zero-valued row here would
    // be a *claim* that an agent ran for free — the shape of lie D-31 exists to
    // prevent, and the same reasoning the command gate's silence rests on.
    const sent = captureSends();
    const runner = reportingAgentRunner(
      runnerReporting(undefined),
      'lease-abc',
    );

    await runner.run(TASK, RUN_CONTEXT);

    expect(sent).toEqual([]);
  });

  it('reports every invocation, not just the first', async () => {
    // A gate may call a model more than once — a reviewer that re-reads a file,
    // a tester that retries. Reporting only the first would understate spend by
    // an unbounded factor while looking like it worked.
    const sent = captureSends();
    const runner = reportingAgentRunner(runnerReporting(USAGE), 'lease-abc');

    await runner.run(TASK, RUN_CONTEXT);
    await runner.run(TASK, RUN_CONTEXT);
    await runner.run(TASK, RUN_CONTEXT);

    expect(sent).toHaveLength(3);
  });

  it('returns the wrapped runner’s own result unchanged', async () => {
    // The wrapper is an accounting obligation, not a translation layer. A gate
    // that could not see what its own model call returned would have to be
    // written against the wrapper rather than against `AgentRunner`.
    captureSends();
    const runner = reportingAgentRunner(
      runnerReporting(undefined),
      'lease-abc',
    );

    const result = await runner.run(TASK, RUN_CONTEXT);

    expect(result.outcome).toBe('completed');
    expect(result.durationMs).toBe(1);
  });
});
