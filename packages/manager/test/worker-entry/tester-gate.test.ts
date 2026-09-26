/**
 * The behaviour tester's own decisions (ROLE-05, M08 step 8.4; ROLE-08, M08 step
 * 8.5).
 *
 * `test/scenario/behaviour-tester.test.ts` and `test/scenario/runner-outcomes.test.ts`
 * drive it through a real daemon against a real app. These are the decisions made
 * before and after the agent runs, and three kinds of them are load-bearing:
 *
 * - **What is refused before anything is spent** — no app, no suite, a suite env
 *   ADL cannot interpolate, a claim citing a criterion the spec lacks.
 * - **The reconciliation table**: the suite's report decides, and the agent's claim
 *   can only make that stricter. Every row is exercised here, because a scenario
 *   can reach only two or three of them.
 * - **The prompt**, which a scenario can only observe indirectly and which is
 *   exactly the kind of thing that erodes silently.
 *
 * The workspace's `exec` replays a scripted runner report **one line per chunk,
 * newline stripped** — what the real launcher delivers (`captured-exec.ts`'s
 * docblock), so a gate that concatenated chunks would fail here as it would in
 * production.
 */
import { describe, expect, it } from 'vitest';
import type { AppVariableValues } from '@adl/core/config';
import {
  judgeRunnerReport,
  readRunnerReport,
  type AgentRunResult,
  type AgentRunner,
  type ExecSpec,
  type GateContext,
  type LogChunk,
  type Workspace,
} from '@adl/core/stage';
import type { NormalizedSpec } from '@adl/core/spec';
import { fingerprintFinding, type Verdict } from '@adl/core/verdict';
import type { AgentGateHost } from '../../src/worker-entry/gates/agent-gate-host.js';
import { runCommandGate } from '../../src/worker-entry/gates/command-gate.js';
import {
  reconcileTesterClaim,
  runTesterGate,
} from '../../src/worker-entry/gates/tester-gate.js';

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

const PORT = 41234;

const VARIABLES: AppVariableValues = {
  ADL_PORT: String(PORT),
  ADL_FEATURE_ID: 'feat-1',
};

const HOST: AgentGateHost = { path: '/usr/bin', variables: VARIABLES };

/** The suite the pipeline entry declares, env still carrying its variable. */
const SUITE = {
  command: {
    argv: ['node', '--test', '--test-reporter=tap'],
    env: { APP_URL: 'http://127.0.0.1:${ADL_PORT}' },
    timeout: '90s',
  },
  emits: 'tap',
} as const;

/** Real node output, trimmed to what the reader needs. */
const TAP_TWO_PASS = [
  'TAP version 13',
  'ok 1 - AC-1: it exports a csv',
  'ok 2 - AC-1: the csv has a header row',
  '1..2',
].join('\n');
const TAP_ZERO = 'TAP version 13\n1..0';
const TAP_ONE_SKIPPED =
  'TAP version 13\nok 1 - AC-1: it exports # SKIP not yet\n1..1';
const TAP_ONE_FAIL = [
  'TAP version 13',
  'not ok 1 - AC-1: it exports a csv',
  '  ---',
  "  error: 'GET /export answered 404'",
  '  ...',
  'ok 2 - AC-1: the csv has a header row',
  '1..2',
].join('\n');

const PASS_CLAIM: Verdict = {
  outcome: 'pass',
  summary: 'every criterion verified',
  checked: [{ kind: 'criterion', id: 'AC-1' }],
};

interface Scripted {
  readonly gate: GateContext;
  asked(): { systemPrompt: string; instructions: string } | undefined;
  /** Every exec the gate issued, in order. */
  readonly execs: ExecSpec[];
  /** Every transcript event the gate emitted. */
  readonly events: { messageId?: string; delta?: string; kind: string }[];
}

function gateFor(
  options: {
    readonly app?: { readonly port: number } | null;
    readonly changedPaths?: readonly string[];
    readonly verdictFile?: string;
    readonly outcome?: AgentRunResult['outcome'];
    readonly config?: Readonly<Record<string, unknown>>;
    /** What the suite prints on stdout, and how it exits. */
    readonly report?: string;
    readonly exitCode?: number | null;
  } = {},
): Scripted {
  let asked: { systemPrompt: string; instructions: string } | undefined;
  const execs: ExecSpec[] = [];
  const events: Scripted['events'] = [];

  const workspace = {
    id: 'blind',
    root: '/blind-root',
    scratchHome: '/blind-home',
    exec: (spec: ExecSpec, log: (chunk: LogChunk) => void) => {
      execs.push(spec);
      // One line per chunk, newline stripped — the real launcher's shape.
      for (const text of (options.report ?? TAP_TWO_PASS).split('\n')) {
        log({ stream: 'stdout', text });
      }
      return Promise.resolve({
        exitCode: options.exitCode === undefined ? 0 : options.exitCode,
        durationMs: 812,
      });
    },
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

  const app = options.app === undefined ? { port: PORT } : options.app;
  const gate: GateContext = {
    stageId: 'behaviour',
    workspace,
    spec: SPEC,
    diff: {
      base: 'base-sha',
      head: 'head-sha',
      changedPaths: options.changedPaths ?? ['src/export/total.ts'],
    },
    config: options.config ?? { suite: SUITE },
    agents,
    onEvent: (event) => {
      events.push(event as Scripted['events'][number]);
    },
    ...(app !== null ? { app } : {}),
  };

  return { gate, asked: () => asked, execs, events };
}

const claimFile = (claim: unknown): string => JSON.stringify(claim);

describe('what is refused before anything is spent', () => {
  it('a tester with no app is a StageError naming needs_app, and no agent is invoked', async () => {
    // ADL does not infer `needs_app` from a stage's NAME, because a built-in that
    // quietly got more than a third party's gate would make HARN-04 false. So the
    // gate has to be able to refuse, and refusing before spending anything is the
    // difference between a clear configuration error and a model's confused guess
    // at what it was supposed to test.
    const scripted = gateFor({ app: null });
    const result = await runTesterGate(scripted.gate, { path: '/usr/bin' });

    expect(result.kind).toBe('stage_error');
    if (result.kind !== 'stage_error') return;
    expect(result.error.kind).toBe('binary_missing');
    expect(result.error.detail).toContain('needs_app: true');
    // Non-retryable: another attempt cannot add a key to `adl.yml`.
    expect(result.error.retryable).toBe(false);
    expect(scripted.asked()).toBeUndefined();
    expect(scripted.execs).toHaveLength(0);
  });

  it('a tester whose entry declares no suite is refused, naming with.suite', async () => {
    // ROLE-08: without a suite ADL runs, the only evidence is the model's word.
    const scripted = gateFor({ config: {} });
    const result = await runTesterGate(scripted.gate, HOST);

    expect(result.kind).toBe('stage_error');
    if (result.kind !== 'stage_error') return;
    expect(result.error.kind).toBe('unparseable');
    expect(result.error.detail).toContain('suite');
    expect(result.error.detail).toContain('--test-reporter=tap');
    expect(scripted.asked()).toBeUndefined();
  });

  it('a suite declaring a mode that cannot say "nothing ran" is refused', async () => {
    for (const emits of ['exit_code', 'verdict']) {
      const scripted = gateFor({
        config: { suite: { command: SUITE.command, emits } },
      });
      const result = await runTesterGate(scripted.gate, HOST);
      expect(result.kind, emits).toBe('stage_error');
      expect(scripted.asked(), emits).toBeUndefined();
    }
  });

  it('a suite key named `command` at the top level is refused, not read', async () => {
    // Strict: a `with.command` here would have made the entry a command gate
    // before this gate ever ran, and a typo'd block must not half-work.
    const scripted = gateFor({
      config: { suite: SUITE, command: SUITE.command },
      verdictFile: claimFile(PASS_CLAIM),
    });
    const result = await runTesterGate(scripted.gate, HOST);
    expect(result.kind).toBe('stage_error');
    if (result.kind !== 'stage_error') return;
    expect(result.error.detail).toContain('command');
    // What only strictness produces: refused before the agent or the suite ran.
    // A non-strict block would read the suite, run the agent, and pass here.
    expect(scripted.asked()).toBeUndefined();
    expect(scripted.execs).toHaveLength(0);
  });

  it('a suite env using a variable ADL does not supply is refused before the agent runs (D-21)', async () => {
    const scripted = gateFor({
      config: {
        suite: {
          command: { argv: ['node', '--test'], env: { ROUND: '${ADL_ROUND}' } },
          emits: 'tap',
        },
      },
    });
    const result = await runTesterGate(scripted.gate, HOST);

    expect(result.kind).toBe('stage_error');
    if (result.kind !== 'stage_error') return;
    expect(result.error.kind).toBe('unparseable');
    expect(result.error.detail).toContain('ADL_ROUND');
    expect(scripted.asked()).toBeUndefined();
  });

  it('a claim citing a criterion the spec lacks is refused BEFORE the suite runs (ROLE-04)', async () => {
    // The verdict `stage-runner.ts` checks is the reconciled one, which carries
    // the suite's citations and not the claim's — so AC-99 would pass through
    // unseen unless it is checked here, on the claim.
    const scripted = gateFor({
      verdictFile: claimFile({
        outcome: 'pass',
        summary: 'all good',
        checked: [{ kind: 'criterion', id: 'AC-99' }],
      }),
    });
    const result = await runTesterGate(scripted.gate, HOST);

    expect(result.kind).toBe('stage_error');
    if (result.kind !== 'stage_error') return;
    expect(result.error.kind).toBe('unparseable');
    expect(result.error.detail).toContain('AC-99');
    expect(result.error.detail).toContain('AC-1');
    expect(scripted.execs).toHaveLength(0);
  });
});

describe('the suite ADL runs', () => {
  it('runs the declared argv, in the blind root, on the host PATH, with the env interpolated', async () => {
    const scripted = gateFor({ verdictFile: claimFile(PASS_CLAIM) });
    await runTesterGate(scripted.gate, HOST);

    expect(scripted.execs).toHaveLength(1);
    const [spec] = scripted.execs;
    expect(spec?.argv).toEqual(['node', '--test', '--test-reporter=tap']);
    expect(spec?.path).toBe('/usr/bin');
    expect(spec?.env).toEqual({ APP_URL: `http://127.0.0.1:${String(PORT)}` });
    expect(spec?.timeoutMs).toBe(90_000);
    // `join(root, '.')` — the blind workspace's own root, nothing else.
    expect(spec?.cwd.replace(/\\/g, '/')).toBe('/blind-root');
  });

  it('puts the suite on the transcript, tagged apart from the agent, with a terminal record', async () => {
    const scripted = gateFor({ verdictFile: claimFile(PASS_CLAIM) });
    await runTesterGate(scripted.gate, HOST);

    const suite = scripted.events.filter((event) =>
      event.messageId?.startsWith('suite:'),
    );
    expect(suite.some((event) => event.delta === '1..2')).toBe(true);
    expect(suite.at(-1)).toMatchObject({
      messageId: 'suite:exit',
      delta: 'exited 0 after 812ms',
    });
  });

  it('a killed suite is a retryable timeout, never a verdict', async () => {
    const scripted = gateFor({
      verdictFile: claimFile(PASS_CLAIM),
      exitCode: null,
    });
    const result = await runTesterGate(scripted.gate, HOST);
    expect(result.kind).toBe('stage_error');
    if (result.kind !== 'stage_error') return;
    expect(result.error.kind).toBe('timeout');
    expect(result.error.retryable).toBe(true);
  });
});

describe('the run decides; the claim can only make it stricter', () => {
  it('a suite that executed no test is inconclusive although the tester claimed pass (ROLE-08)', async () => {
    for (const report of [TAP_ZERO, TAP_ONE_SKIPPED]) {
      const result = await runTesterGate(
        gateFor({ verdictFile: claimFile(PASS_CLAIM), report }).gate,
        HOST,
      );
      expect(result.kind).toBe('verdict');
      if (result.kind !== 'verdict') return;
      expect(result.verdict.outcome).toBe('inconclusive');
      if (result.verdict.outcome !== 'inconclusive') return;
      expect(result.verdict.reason).toContain('no test executed');
      expect(result.verdict.reason).toContain('the tester reported `pass`');
    }
  });

  it('a green run with a pass claim is a pass citing the suite — the claimed criteria are named, not recorded', async () => {
    const result = await runTesterGate(
      gateFor({ verdictFile: claimFile(PASS_CLAIM) }).gate,
      HOST,
    );
    expect(result.kind).toBe('verdict');
    if (result.kind !== 'verdict' || result.verdict.outcome !== 'pass') {
      throw new Error(`expected a pass, got ${JSON.stringify(result)}`);
    }
    // Which test covers which criterion is step 8.7's link. Until then a
    // criterion citation here would be the model's claim written into the
    // coverage table as evidence.
    expect(result.verdict.checked).toEqual([
      { kind: 'global', category: 'build' },
    ]);
    expect(result.verdict.summary).toContain('2 executed tests');
    expect(result.verdict.summary).toContain('the tester claimed AC-1');
  });

  it('a failing test sends the work back with the suite’s own finding, whatever was claimed', async () => {
    const result = await runTesterGate(
      gateFor({
        verdictFile: claimFile(PASS_CLAIM),
        report: TAP_ONE_FAIL,
        exitCode: 1,
      }).gate,
      HOST,
    );
    expect(result.kind).toBe('verdict');
    if (result.kind !== 'verdict' || result.verdict.outcome !== 'send_back') {
      throw new Error(`expected a send_back, got ${JSON.stringify(result)}`);
    }
    expect(result.verdict.findings.map((finding) => finding.title)).toEqual([
      'test failed: AC-1: it exports a csv',
    ]);
    expect(result.verdict.findings[0]?.detail).toContain(
      'GET /export answered 404',
    );
    expect(result.verdict.summary).toContain(
      'the tester reported `pass`; its suite disagrees',
    );
  });

  it('a green run with a warn keeps the notes, with fingerprints ADL recomputed', async () => {
    const forged = 'f'.repeat(64);
    const result = await runTesterGate(
      gateFor({
        verdictFile: claimFile({
          outcome: 'warn',
          summary: 'AC-1 read literally',
          findings: [
            {
              fingerprint: forged,
              severity: 'minor',
              title: 'AC-1 is ambiguous about the delimiter',
              detail: 'I assumed a comma',
              criterionRef: { kind: 'criterion', id: 'AC-1' },
            },
          ],
        }),
      }).gate,
      HOST,
    );
    expect(result.kind).toBe('verdict');
    if (result.kind !== 'verdict' || result.verdict.outcome !== 'warn') {
      throw new Error(`expected a warn, got ${JSON.stringify(result)}`);
    }
    const [finding] = result.verdict.findings;
    expect(finding?.fingerprint).not.toBe(forged);
    expect(finding?.fingerprint).toBe(
      fingerprintFinding({
        stageId: 'behaviour',
        title: 'AC-1 is ambiguous about the delimiter',
      }),
    );
  });

  it('a green run the tester says is broken goes to a human — never a send_back nothing executed backs, never a pass', async () => {
    const claims: Verdict[] = [
      {
        outcome: 'send_back',
        summary: 'the export is wrong',
        findings: [
          {
            fingerprint: 'a'.repeat(64),
            severity: 'blocker',
            title: 'wrong delimiter',
            detail: 'semicolons',
            criterionRef: { kind: 'criterion', id: 'AC-1' },
          },
        ],
      },
      { outcome: 'fail', summary: 'no', reason: 'cannot work' },
      { outcome: 'inconclusive', summary: 'unsure', reason: 'could not tell' },
      { outcome: 'skip', reason: 'nothing to test' },
    ];
    for (const claim of claims) {
      const result = await runTesterGate(
        gateFor({ verdictFile: claimFile(claim) }).gate,
        HOST,
      );
      expect(result.kind, claim.outcome).toBe('verdict');
      if (result.kind !== 'verdict') return;
      expect(result.verdict.outcome, claim.outcome).toBe('inconclusive');
      if (result.verdict.outcome !== 'inconclusive') return;
      expect(result.verdict.reason).toContain(`reported \`${claim.outcome}\``);
    }
  });

  it('a report that cannot be judged is unparseable, whatever was claimed', async () => {
    const result = await runTesterGate(
      gateFor({
        verdictFile: claimFile(PASS_CLAIM),
        report: '✔ AC-1 (2ms)\nℹ tests 1',
      }).gate,
      HOST,
    );
    expect(result.kind).toBe('stage_error');
    if (result.kind !== 'stage_error') return;
    expect(result.error.kind).toBe('unparseable');
    expect(result.error.detail).toContain('--test-reporter=tap');
  });

  it('every row of the table is reachable through reconcileTesterClaim directly', () => {
    // The table as data: every evidence kind against a representative claim.
    const judge = (report: string, exitCode = 0) =>
      judgeRunnerReport({
        stageId: 'behaviour',
        runLabel: 'node --test',
        exitCode,
        read: readRunnerReport('tap', report),
        outputTail: '',
      });
    const rows: [string, ReturnType<typeof judge>, string][] = [
      ['unjudgeable', judge('no tap here'), 'stage_error'],
      ['failed', judge(TAP_ONE_FAIL, 1), 'send_back'],
      ['nothing_executed', judge(TAP_ZERO), 'inconclusive'],
      ['passed', judge(TAP_TWO_PASS), 'pass'],
    ];
    for (const [label, evidence, expected] of rows) {
      expect(evidence.kind, label).toBe(label);
      const result = reconcileTesterClaim({
        stageId: 'behaviour',
        claim: PASS_CLAIM,
        evidence,
      });
      expect(
        result.kind === 'verdict' ? result.verdict.outcome : result.kind,
        label,
      ).toBe(expected);
    }
  });
});

describe('HARN-04: a third party’s command gate reaches the same judgement', () => {
  it('the same report through `emits: tap` and through the tester’s green path agree', async () => {
    // One judgement, two callers. If the tester ever judged a report by a rule of
    // its own, this is where the two answers would part.
    const tester = await runTesterGate(
      gateFor({
        verdictFile: claimFile({
          outcome: 'pass',
          summary: 'ok',
          checked: [{ kind: 'global', category: 'other' }],
        }),
      }).gate,
      HOST,
    );

    const commandGate = gateFor({ report: TAP_TWO_PASS }).gate;
    const command = await runCommandGate(commandGate, {
      command: { argv: ['node', '--test', '--test-reporter=tap'] },
      path: '/usr/bin',
      emits: 'tap',
    });

    expect(tester.kind).toBe('verdict');
    expect(command.kind).toBe('verdict');
    if (tester.kind !== 'verdict' || command.kind !== 'verdict') return;
    expect(tester.verdict).toEqual(command.verdict);
  });
});

describe('what the tester is told', () => {
  it('is told the base URL of the running app, composed from the port', async () => {
    const scripted = gateFor({ verdictFile: claimFile(PASS_CLAIM) });
    await runTesterGate(scripted.gate, HOST);

    // On its own line and with no trailing punctuation, so a consumer cannot
    // capture a sentence-ending period into the URL.
    expect(scripted.asked()?.instructions).toContain(
      `Base URL: http://127.0.0.1:${String(PORT)}\n`,
    );
  });

  it('is told the command that runs the suite, its env interpolated, and that ADL’s run decides', async () => {
    // Step 8.0's spike said the tester is given "the command that runs the
    // suite", and until step 8.5 this module's docblock claimed it while its
    // prompt did not contain it.
    const scripted = gateFor({ verdictFile: claimFile(PASS_CLAIM) });
    await runTesterGate(scripted.gate, HOST);

    const instructions = scripted.asked()?.instructions ?? '';
    expect(instructions).toContain('Command: node --test --test-reporter=tap');
    // What it is told is what runs: the interpolated value, never the template.
    expect(instructions).toContain(
      `- APP_URL=http://127.0.0.1:${String(PORT)}`,
    );
    expect(instructions).not.toContain('${ADL_PORT}');
    expect(instructions).toContain('not the one that counts');
    expect(instructions).toContain('is never a pass');
  });

  it('is told the blindness is DELIBERATE and the source is absent', async () => {
    // M08 step 8.0's spike insisted on this, and gave the reason: a tester that
    // does not know spends turns hunting for source that is not there.
    const scripted = gateFor({ verdictFile: claimFile(PASS_CLAIM) });
    await runTesterGate(scripted.gate, HOST);

    const asked = scripted.asked();
    expect(asked?.systemPrompt).toContain('cannot read the implementation');
    expect(asked?.systemPrompt).toContain('deliberate');
    expect(asked?.instructions).toContain('is **not** there');
  });

  it('is NOT told which files changed, though it is handed them', async () => {
    // Step 8.1's carried finding, decided in 8.4. `diff.changedPaths` stays on the
    // contract — withholding it for the tester specifically would be the special
    // case HARN-04 forbids — and the PROMPT does not use it, because a tester told
    // `src/export/total.ts` changed writes tests about a module.
    const scripted = gateFor({
      changedPaths: ['src/export/total.ts', 'src/export/csv.ts'],
      verdictFile: claimFile(PASS_CLAIM),
    });
    await runTesterGate(scripted.gate, HOST);

    const asked = scripted.asked();
    expect(asked?.instructions).not.toContain('src/export/total.ts');
    expect(asked?.instructions).not.toContain('src/export/csv.ts');
    // And the member really was populated, so this is an absence in the prompt
    // rather than an absence in the fixture.
    expect(scripted.gate.diff.changedPaths).toHaveLength(2);
  });

  it('is told how to report an ambiguous criterion without failing the feature', async () => {
    const scripted = gateFor({ verdictFile: claimFile(PASS_CLAIM) });
    await runTesterGate(scripted.gate, HOST);

    const instructions = scripted.asked()?.instructions ?? '';
    expect(instructions).toContain('most literal reading');
    expect(instructions).toContain('"outcome":"warn"');
  });
});

describe('every way of not producing a claim is a StageError, and the suite is not run', () => {
  it('reports a missing verdict file as unparseable', async () => {
    const scripted = gateFor();
    const result = await runTesterGate(scripted.gate, HOST);
    expect(result.kind).toBe('stage_error');
    if (result.kind !== 'stage_error') return;
    expect(result.error.kind).toBe('unparseable');
    expect(result.error.detail).toContain('wrote no verdict');
    expect(scripted.execs).toHaveLength(0);
  });

  it('reports a non-JSON verdict file as unparseable', async () => {
    const scripted = gateFor({ verdictFile: 'I ran the tests, they passed!' });
    const result = await runTesterGate(scripted.gate, HOST);
    expect(result.kind).toBe('stage_error');
    if (result.kind !== 'stage_error') return;
    expect(result.error.kind).toBe('unparseable');
    expect(result.error.detail).toContain('not JSON');
    expect(scripted.execs).toHaveLength(0);
  });

  it('reports JSON that is not a verdict as unparseable', async () => {
    const scripted = gateFor({ verdictFile: '{"outcome":"probably fine"}' });
    const result = await runTesterGate(scripted.gate, HOST);
    expect(result.kind).toBe('stage_error');
    if (result.kind !== 'stage_error') return;
    expect(result.error.kind).toBe('unparseable');
    expect(result.error.detail).toContain('not a valid verdict');
    expect(scripted.execs).toHaveLength(0);
  });

  it('reports a killed run as a retryable timeout, and a failed one as provider_error', async () => {
    for (const [outcome, kind, retryable] of [
      ['cancelled', 'timeout', true],
      ['turn_limit_reached', 'provider_error', true],
    ] as const) {
      const scripted = gateFor({ outcome });
      const result = await runTesterGate(scripted.gate, HOST);
      expect(result.kind).toBe('stage_error');
      if (result.kind !== 'stage_error') return;
      expect(result.error.kind).toBe(kind);
      expect(result.error.retryable).toBe(retryable);
      expect(scripted.execs).toHaveLength(0);
    }
  });
});
