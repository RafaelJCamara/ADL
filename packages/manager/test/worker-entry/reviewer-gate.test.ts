import { describe, expect, it } from 'vitest';
import type {
  AgentRunResult,
  AgentRunner,
  AgentTask,
  GateContext,
} from '@adl/core/stage';
import {
  runReviewerGate,
  verdictPathFor,
} from '../../src/worker-entry/gates/reviewer-gate.js';

/**
 * The reviewer gate (ROLE-02, M07 step 7.4).
 *
 * Driven against a fake `AgentRunner` and a fake `Workspace` rather than a real
 * agent, deliberately: what is being tested is the **contract between ADL and
 * whatever answers** — that a verdict is read from a file and validated, and
 * that every way of failing to produce one is a `StageError` rather than an
 * approval. A real agent would make those cases nondeterministic, which is the
 * same reasoning M05 used to make the command gate the first gate rather than
 * the reviewer.
 *
 * The cases that carry weight:
 *
 * - **Nothing is ever read as approval.** No file, bad JSON, JSON that is not a
 *   verdict, an agent that never finished — four ways to end up with no
 *   judgement, and none of them may produce a `pass`. This is CORE-06 at the
 *   place it matters most: the reviewer is the gate whose false green is
 *   indistinguishable from a real one.
 * - **The prompt carries the spec and the diff, and nothing else.** A reviewer
 *   handed less than the developer saw raises findings about things the spec
 *   answered; a reviewer handed more than spec+diff+repository is ROLE-03
 *   violated.
 */

const SPEC = {
  title: 'Widget export',
  raw: '# Widget export\n\nA button.\n\n## Acceptance Criteria\n\n- It exports.\n',
  narrative: 'A button.',
  acceptanceCriteria: [
    {
      id: 'AC-1',
      kind: 'statement' as const,
      text: 'It exports.',
      source: { start: 0, end: 11 },
      textHash: 'a'.repeat(64),
    },
  ],
} as unknown as GateContext['spec'];

interface Harness {
  readonly gate: GateContext;
  readonly tasks: AgentTask[];
  readonly written: Map<string, string>;
}

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
 * A gate context whose workspace serves files from a map and whose runner
 * records the task it was given.
 *
 * `files` is what the agent "wrote": the harness plays the agent's part by
 * pre-seeding it, because what this file tests is how ADL reads the answer, not
 * how a model produces one.
 */
function harness(options: {
  readonly files?: Record<string, string>;
  readonly runResult?: AgentRunResult;
}): Harness {
  const tasks: AgentTask[] = [];
  const written = new Map(Object.entries(options.files ?? {}));

  const agents: AgentRunner = {
    run: (task) => {
      tasks.push(task);
      return Promise.resolve(options.runResult ?? COMPLETED);
    },
    probe: () => {
      throw new Error('the reviewer never probes');
    },
  };

  const workspace = {
    root: '/nowhere',
    read: (relPath: string): Promise<string> => {
      const found = written.get(relPath);
      if (found === undefined) {
        return Promise.reject(
          new Error(`ENOENT: no such file or directory, open '${relPath}'`),
        );
      }
      return Promise.resolve(found);
    },
  } as unknown as GateContext['workspace'];

  const gate: GateContext = {
    stageId: 'review',
    workspace,
    spec: SPEC,
    diff: {
      base: 'b'.repeat(40),
      head: 'c'.repeat(40),
      changedPaths: ['src/exporter.ts'],
    },
    config: {},
    agents,
    onEvent: () => {},
  };

  return { gate, tasks, written };
}

const VALID_PASS = JSON.stringify({
  outcome: 'pass',
  summary: 'every criterion is satisfied',
  checked: [{ kind: 'criterion', id: 'AC-1' }],
});

describe('runReviewerGate', () => {
  it('reads the verdict the reviewer wrote and returns it', async () => {
    const { gate } = harness({
      files: { [verdictPathFor('review')]: VALID_PASS },
    });

    const result = await runReviewerGate(gate);

    expect(result.kind).toBe('verdict');
    if (result.kind !== 'verdict') return;
    expect(result.verdict.outcome).toBe('pass');
  });

  it('reports a missing verdict file as unparseable, never as a pass', async () => {
    // The single most important case in this file. An agent that ran, said
    // reassuring things and wrote nothing must not be read as approval — that
    // is a false green produced by silence, and it is indistinguishable from a
    // real one downstream.
    const { gate } = harness({});

    const result = await runReviewerGate(gate);

    expect(result.kind).toBe('stage_error');
    if (result.kind !== 'stage_error') return;
    expect(result.error.kind).toBe('unparseable');
    expect(result.error.retryable).toBe(false);
    expect(result.error.detail).toContain(verdictPathFor('review'));
  });

  it('reports a verdict file that is not JSON as unparseable', async () => {
    const { gate } = harness({
      files: { [verdictPathFor('review')]: 'Looks good to me!' },
    });

    const result = await runReviewerGate(gate);

    expect(result.kind).toBe('stage_error');
    if (result.kind !== 'stage_error') return;
    expect(result.error.kind).toBe('unparseable');
  });

  it('reports JSON that is not a verdict as unparseable, naming the field', async () => {
    const { gate } = harness({
      files: {
        [verdictPathFor('review')]: JSON.stringify({ outcome: 'looks_fine' }),
      },
    });

    const result = await runReviewerGate(gate);

    expect(result.kind).toBe('stage_error');
    if (result.kind !== 'stage_error') return;
    expect(result.error.kind).toBe('unparseable');
    expect(result.error.detail).toContain('outcome');
  });

  it('reports an agent that never completed as a stage error, and does not read the file', async () => {
    // A killed agent may have left a stale verdict from an earlier attempt.
    // Reading it would attribute an old judgement to a run that produced none —
    // so the outcome is checked first, and the file is not consulted at all.
    const { gate } = harness({
      files: { [verdictPathFor('review')]: VALID_PASS },
      runResult: { ...COMPLETED, outcome: 'cancelled' },
    });

    const result = await runReviewerGate(gate);

    expect(result.kind).toBe('stage_error');
    if (result.kind !== 'stage_error') return;
    expect(result.error.kind).toBe('timeout');
  });

  it('hands the agent the spec, the criteria and the changed paths', async () => {
    const { gate, tasks } = harness({
      files: { [verdictPathFor('review')]: VALID_PASS },
    });

    await runReviewerGate(gate);

    expect(tasks).toHaveLength(1);
    const rendered = tasks[0]!.instructions;
    expect(rendered).toContain('Widget export');
    expect(rendered).toContain('AC-1');
    // The raw spec, verbatim, alongside the identified criteria — a criterion's
    // own text slice does not carry the tables, links and nuance around it, and
    // a reviewer judging against less than the developer saw raises findings
    // about things the spec answered.
    expect(rendered).toContain('## Acceptance Criteria');
    expect(rendered).toContain('src/exporter.ts');
    expect(rendered).toContain(verdictPathFor('review'));
  });

  it('names the verdict file after the stage, so two agent gates cannot overwrite each other', async () => {
    // Reachable now that a pipeline may carry more than one agent gate (7.3
    // made a multi-gate pipeline buildable, M08 adds the second agent).
    expect(verdictPathFor('review')).not.toBe(verdictPathFor('behaviour'));
  });
});
