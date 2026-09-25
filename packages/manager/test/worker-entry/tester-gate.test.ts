/**
 * The behaviour tester's own decisions (ROLE-05, M08 step 8.4).
 *
 * `test/scenario/behaviour-tester.test.ts` drives it through a real daemon against
 * a real app. These are the decisions that are made before or after that, and two
 * of them are load-bearing properties of the *prompt* — which a scenario can only
 * observe indirectly and which are exactly the kind of thing that erodes silently.
 */
import { describe, expect, it } from 'vitest';
import type {
  AgentRunResult,
  AgentRunner,
  GateContext,
  Workspace,
} from '@adl/core/stage';
import type { NormalizedSpec } from '@adl/core/spec';
import { runTesterGate } from '../../src/worker-entry/gates/tester-gate.js';

/**
 * A minimal spec, cast rather than constructed.
 *
 * `AcceptanceCriterion` is a discriminated union carrying a `SourceSpan` and a
 * text hash, because `@adl/core/spec` guarantees `raw.slice(start, end)`
 * reproduces the criterion byte-for-byte. Building a faithful one here would make
 * every case in this file depend on the spec parser's internals, and not one of
 * them reads anything but `id` and `text`.
 */
const SPEC = {
  title: 'Export button',
  raw: '# Export button\n\nThe user can export.\n\n## Acceptance Criteria\n\n- It exports.\n',
  acceptanceCriteria: [{ id: 'AC-1', kind: 'statement', text: 'It exports.' }],
  format: 'markdown',
} as unknown as NormalizedSpec;

/** What the runner was asked, so the prompt can be asserted rather than guessed at. */
interface Captured {
  readonly gate: GateContext;
  asked(): { systemPrompt: string; instructions: string } | undefined;
}

function gateFor(
  options: {
    readonly app?: { readonly port: number };
    readonly changedPaths?: readonly string[];
    readonly verdictFile?: string;
    readonly outcome?: AgentRunResult['outcome'];
  } = {},
): Captured {
  let asked: { systemPrompt: string; instructions: string } | undefined;

  const workspace = {
    id: 'blind',
    root: '/nowhere',
    scratchHome: '/nowhere',
    exec: () => Promise.reject(new Error('the tester does not exec directly')),
    read: (relPath: string) =>
      options.verdictFile === undefined
        ? Promise.reject(new Error(`ENOENT: ${relPath}`))
        : Promise.resolve(options.verdictFile),
    write: () => Promise.resolve(),
    snapshot: () => Promise.reject(new Error('not used')),
    detach: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  } as unknown as Workspace;

  const agents: AgentRunner = {
    run: (task) => {
      asked = {
        systemPrompt: task.systemPrompt,
        instructions: task.instructions,
      };
      return Promise.resolve({
        outcome: options.outcome ?? 'completed',
      } as AgentRunResult);
    },
    probe: () => Promise.resolve({ ok: true }) as never,
  };

  const gate: GateContext = {
    stageId: 'behaviour',
    workspace,
    spec: SPEC,
    diff: {
      base: 'base-sha',
      head: 'head-sha',
      changedPaths: options.changedPaths ?? ['src/export/total.ts'],
    },
    config: {},
    agents,
    onEvent: () => {},
    ...(options.app !== undefined ? { app: options.app } : {}),
  };

  return { gate, asked: () => asked };
}

describe('a tester with no app refuses rather than testing nothing', () => {
  it('is a StageError naming needs_app, and no agent is invoked', async () => {
    // The whole point: ADL does not infer `needs_app` from a stage's NAME, because
    // a built-in that quietly got more than a third party's gate would make
    // HARN-04 false. So the gate has to be able to refuse, and refusing before
    // spending anything is the difference between a clear configuration error and
    // a model's confused guess at what it was supposed to test.
    const captured = gateFor({ app: undefined });
    const result = await runTesterGate(captured.gate);

    expect(result.kind).toBe('stage_error');
    if (result.kind === 'stage_error') {
      expect(result.error.kind).toBe('binary_missing');
      expect(result.error.detail).toContain('needs_app: true');
      // Non-retryable: another attempt cannot add a key to `adl.yml`.
      expect(result.error.retryable).toBe(false);
    }
    expect(captured.asked()).toBeUndefined();
  });
});

describe('what the tester is told', () => {
  it('is told the base URL of the running app, composed from the port', async () => {
    const captured = gateFor({
      app: { port: 41234 },
      verdictFile: JSON.stringify({
        outcome: 'pass',
        summary: 'ok',
        checked: [{ kind: 'criterion', id: 'AC-1' }],
      }),
    });
    await runTesterGate(captured.gate);

    // On its own line and with no trailing punctuation, so a consumer cannot
    // capture a sentence-ending period into the URL.
    expect(captured.asked()?.instructions).toContain(
      'Base URL: http://127.0.0.1:41234\n',
    );
  });

  it('is told the blindness is DELIBERATE and the source is absent', async () => {
    // M08 step 8.0's spike insisted on this, and gave the reason: a tester that
    // does not know spends turns hunting for source that is not there, and 7.5's
    // reviewer report is the precedent for how much walking an agent will do
    // before it concludes anything.
    const captured = gateFor({ app: { port: 1 }, verdictFile: '{}' });
    await runTesterGate(captured.gate);

    const asked = captured.asked();
    expect(asked?.systemPrompt).toContain('cannot read the implementation');
    expect(asked?.systemPrompt).toContain('deliberate');
    expect(asked?.instructions).toContain('is **not** there');
  });

  it('is NOT told which files changed, though it is handed them', async () => {
    // Step 8.1's carried finding, decided here. `diff.changedPaths` stays on the
    // contract — withholding it for the tester specifically would be the special
    // case HARN-04 forbids — and the PROMPT does not use it, because the prompt is
    // what shapes behaviour. A tester told `src/export/total.ts` changed writes
    // tests about a module; a tester told only the criteria writes tests about
    // behaviour.
    const captured = gateFor({
      app: { port: 1 },
      changedPaths: ['src/export/total.ts', 'src/export/csv.ts'],
      verdictFile: '{}',
    });
    await runTesterGate(captured.gate);

    const asked = captured.asked();
    expect(asked?.instructions).not.toContain('src/export/total.ts');
    expect(asked?.instructions).not.toContain('src/export/csv.ts');
    // And the member really was populated, so this is an absence in the prompt
    // rather than an absence in the fixture.
    expect(captured.gate.diff.changedPaths).toHaveLength(2);
  });

  it('is told how to report an ambiguous criterion without failing the feature', async () => {
    // The spike's decision: ambiguity is reported, not guessed. Guessing silently
    // produces a false failure the developer cannot act on; `inconclusive` lets one
    // ambiguous criterion sink an otherwise verified feature. `warn` is the outcome
    // `aggregate` already treats as "no send-back, findings still travel".
    const captured = gateFor({ app: { port: 1 }, verdictFile: '{}' });
    await runTesterGate(captured.gate);

    const instructions = captured.asked()?.instructions ?? '';
    expect(instructions).toContain('most literal reading');
    expect(instructions).toContain('"outcome":"warn"');
  });
});

describe('every way of not producing a verdict is a StageError', () => {
  it('reports a missing verdict file as unparseable', async () => {
    const result = await runTesterGate(gateFor({ app: { port: 1 } }).gate);
    expect(result.kind).toBe('stage_error');
    if (result.kind === 'stage_error') {
      expect(result.error.kind).toBe('unparseable');
      expect(result.error.detail).toContain('wrote no verdict');
    }
  });

  it('reports a non-JSON verdict file as unparseable', async () => {
    const result = await runTesterGate(
      gateFor({
        app: { port: 1 },
        verdictFile: 'I ran the tests, they passed!',
      }).gate,
    );
    expect(result.kind).toBe('stage_error');
    if (result.kind === 'stage_error') {
      expect(result.error.kind).toBe('unparseable');
      expect(result.error.detail).toContain('not JSON');
    }
  });

  it('reports JSON that is not a verdict as unparseable', async () => {
    const result = await runTesterGate(
      gateFor({ app: { port: 1 }, verdictFile: '{"outcome":"probably fine"}' })
        .gate,
    );
    expect(result.kind).toBe('stage_error');
    if (result.kind === 'stage_error') {
      expect(result.error.kind).toBe('unparseable');
      expect(result.error.detail).toContain('not a valid verdict');
    }
  });

  it('reports a killed run as a retryable timeout, and a failed one as provider_error', async () => {
    for (const [outcome, kind, retryable] of [
      ['cancelled', 'timeout', true],
      ['turn_limit_reached', 'provider_error', true],
    ] as const) {
      const result = await runTesterGate(
        gateFor({ app: { port: 1 }, outcome }).gate,
      );
      expect(result.kind).toBe('stage_error');
      if (result.kind === 'stage_error') {
        expect(result.error.kind).toBe(kind);
        expect(result.error.retryable).toBe(retryable);
      }
    }
  });
});

describe('the tester does NOT borrow the reviewer’s citation rule', () => {
  it('accepts a pass citing only a global category, deliberately', async () => {
    // The asymmetry is the decision, not an omission. `runReviewerGate` rejects a
    // `pass` citing no criterion, because a reviewer that checked no criterion has
    // not reviewed against the spec. Applying that here NOW would reward the tester
    // for ASSERTING coverage it has no evidence for — and "the suite ran and
    // passed" is a different claim from "AC-3 was verified". Step 8.5 is where a
    // tester's coverage claim gets evidence behind it (structured runner output),
    // and step 8.7's spec-clause link is what makes a criterion citation from this
    // gate mean something.
    //
    // The check that DOES apply is the one every gate gets: `stage-runner.ts`
    // refuses a verdict citing a criterion the spec does not contain (ROLE-04).
    const result = await runTesterGate(
      gateFor({
        app: { port: 1 },
        verdictFile: JSON.stringify({
          outcome: 'pass',
          summary: 'the suite ran and passed',
          checked: [{ kind: 'global', category: 'other' }],
        }),
      }).gate,
    );
    expect(result.kind).toBe('verdict');
  });
});
