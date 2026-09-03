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

  it('refuses an approval that cites only a global category (ROLE-04)', async () => {
    // `PassVerdictSchema.checked` is non-empty by schema, and this satisfies
    // it — so the schema accepts it and the reviewer must not. A pass citing
    // only `{ kind: 'global' }` is the COMMAND gate's honest answer: a build
    // that went green genuinely checked no criterion. From a gate whose job is
    // to judge implementation against the spec, it is an approval that claims
    // coverage of nothing at all, which is exactly what ROLE-04 refuses.
    const { gate } = harness({
      files: {
        [verdictPathFor('review')]: JSON.stringify({
          outcome: 'pass',
          summary: 'looks fine to me',
          checked: [{ kind: 'global', category: 'code_quality' }],
        }),
      },
    });

    const result = await runReviewerGate(gate);

    expect(result.kind).toBe('stage_error');
    if (result.kind !== 'stage_error') return;
    expect(result.error.kind).toBe('unparseable');
    // Non-retryable: a reviewer that approved without checking anything will
    // not check anything on a retry either, so the round escalates to a human.
    expect(result.error.retryable).toBe(false);
    expect(result.error.detail).toContain('acceptance');
  });

  it('accepts an approval that cites a criterion alongside a global', async () => {
    // The negative control for the case above: the rule is "cite at least one
    // criterion", not "cite nothing but criteria". A reviewer that verified
    // AC-1 and also has a code-quality note it is content with must not be
    // refused for saying both.
    const { gate } = harness({
      files: {
        [verdictPathFor('review')]: JSON.stringify({
          outcome: 'pass',
          summary: 'checked it',
          checked: [
            { kind: 'global', category: 'code_quality' },
            { kind: 'criterion', id: 'AC-1' },
          ],
        }),
      },
    });

    const result = await runReviewerGate(gate);

    expect(result.kind).toBe('verdict');
  });

  it('does not apply the citation rule to a send_back', async () => {
    // The rule is about APPROVAL. A send-back whose findings are all
    // code-quality notes is an ordinary, honest send-back, and refusing it
    // would make "I found problems, none of them tied to a criterion"
    // unsayable.
    const { gate } = harness({
      files: {
        [verdictPathFor('review')]: JSON.stringify({
          outcome: 'send_back',
          summary: 'quality problems',
          findings: [
            {
              fingerprint: 'd'.repeat(64),
              severity: 'major',
              title: 'no error handling',
              detail: 'the write is unguarded',
              criterionRef: { kind: 'global', category: 'code_quality' },
            },
          ],
        }),
      },
    });

    const result = await runReviewerGate(gate);

    expect(result.kind).toBe('verdict');
  });

  it('tells the reviewer the rule it will be judged by', async () => {
    // A gate that refuses an output it never asked for is a gate that fails
    // for a reason the model could not have known. The instructions carry the
    // rule this file's first case enforces.
    const { gate, tasks } = harness({
      files: { [verdictPathFor('review')]: VALID_PASS },
    });

    await runReviewerGate(gate);

    expect(tasks[0]!.instructions).toContain('A pass must');
    expect(tasks[0]!.instructions).toContain('cite at least one of them');
  });

  it('names the verdict file after the stage, so two agent gates cannot overwrite each other', async () => {
    // Reachable now that a pipeline may carry more than one agent gate (7.3
    // made a multi-gate pipeline buildable, M08 adds the second agent).
    expect(verdictPathFor('review')).not.toBe(verdictPathFor('behaviour'));
  });
});
