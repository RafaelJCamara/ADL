/**
 * The behaviour tester (ROLE-05, M08 step 8.4) — an agent that judges a running
 * app and **structurally cannot read the implementation that runs it** — whose
 * outcome is decided by **the suite ADL runs after it, not by what it says**
 * (ROLE-08, M08 step 8.5).
 *
 * `runReviewerGate`'s shape, deliberately, for its first half: compose a prompt,
 * run through `GateContext.agents`, read a claim out of a file, and treat every
 * way of not producing one as a `StageError`. The second half is what makes it a
 * tester: ADL then runs the suite the pipeline entry declares, in the same blind
 * workspace, against the same running app, reads the runner's own report, and
 * that report decides.
 *
 * ## The three things that make it a tester rather than a second reviewer
 *
 * 1. **Its workspace holds only what the pipeline entry declared** (ROLE-06, step
 *    8.1). A materialised copy of `visible_paths` with no `.git`, outside every
 *    repository — so the implementation is *absent*, not forbidden. This module
 *    contains no code enforcing that and should not: code-blindness is a property
 *    of what is on disk under `Workspace.root`, and a gate asked to honour it
 *    would be the *"merely forbidden by instruction"* criterion 1 rules out.
 * 2. **It is told the port of a running app** (ROLE-07, steps 8.2/8.3), through
 *    `GateContext.app` — the member step 8.4 added, and the first one an agent
 *    gate could not do without, because a command gate reads its port out of its
 *    own interpolated `env` and an agent gate has no command.
 * 3. **Its outcome comes from structured runner output** (ROLE-08, step 8.5). An
 *    agent that says "the suite ran and passed" is making a claim; a TAP report
 *    with two executed, passing tests in it is evidence. So the entry declares
 *    `with.suite` — a command and the report format it prints — and ADL runs it
 *    **itself** once the agent is done, through `gate.workspace.exec` on the
 *    blind copy while the app is still up, and judges it with
 *    `@adl/core/stage`'s `judgeRunnerReport`: the **same** function a command
 *    gate declaring `emits: tap` is judged by. A suite that executed no test is
 *    `inconclusive`, never a `pass`, whatever the agent claimed.
 *
 * ## The run decides; the claim can only make it stricter
 *
 * | Suite's evidence | Agent's claim | Answer |
 * |---|---|---|
 * | could not be judged | any | `unparseable` — the suite did not judge (D-12) |
 * | a test failed | any | the suite's `send_back` — findings from the failing tests, fingerprints ADL computed. The claim's own findings are dropped: a model's note repeated each round would feed stall detection. |
 * | **no test executed** | **any, `pass` included** | **`inconclusive`** (ROLE-08) |
 * | every executed test passed | `pass` | `pass`, citing `{ global: build }` only. The criteria the agent claimed are named in the summary, **not** recorded as coverage — which test verifies which criterion is step 8.7's link. |
 * | every executed test passed | `warn` | `warn` — its notes (an ambiguous criterion, the reading taken), fingerprints **recomputed** by ADL, never trusted from the model |
 * | every executed test passed | `send_back`, `fail`, `inconclusive`, `skip` | `inconclusive` — ADL does not act on a problem no executed test shows, and does not pass a feature the tester says is broken. It escalates to a human. |
 *
 * The last row is the interesting one. Returning the claim's `send_back` would
 * cost the developer a round on a `deterministic` stage LOOP-09 never demotes,
 * with nothing executed behind it — the model's word alone. Returning the
 * suite's `pass` would ship a feature the tester reported broken. Neither side
 * has the evidence, so a human decides; the prompt tells the tester this, and
 * tells it the remedy: write a test that fails.
 *
 * **ROLE-04 runs on the claim, inside this gate, before the suite does.**
 * `stage-runner.ts` refuses any verdict citing a criterion the spec lacks — but
 * the verdict it sees here carries the suite's citations, not the claim's, so a
 * claim citing `AC-99` would pass through unseen. So the same
 * `unknownCitedCriteria` runs on the claim first, and refuses it before the
 * suite is paid for.
 *
 * ## It refuses to run without an app, and that is not a special case
 *
 * ADL does **not** infer `needs_app` from a stage's name — that would be exactly
 * the branch on the tester's identity HARN-04 forbids. So a pipeline that names
 * `behaviour` without declaring `needs_app: true` produces a tester with no app,
 * and this module returns a `StageError` naming the key rather than testing
 * nothing and reporting a pass. The same for a `with.suite` that is missing or
 * malformed: refused by name before the agent or the suite is paid for — though
 * not before the app, which `stage-runner.ts` has already built and started by
 * the time this gate runs (validating `with.suite` earlier is 8.7's, when the
 * suite becomes a key ADL itself reads). A gate being stricter
 * about its own configuration is what any third party's gate is equally free to
 * do (reviewer-gate's own docblock).
 *
 * ## What the prompt deliberately does NOT say
 *
 * **The changed paths.** `GateContext.diff.changedPaths` is on the contract and
 * this gate receives it, exactly as every other gate does — withholding it *for
 * the tester* would be a special case. The decision (step 8.4) is that the member
 * stays and the **prompt does not use it**: a tester told that
 * `src/checkout/total.ts` changed writes tests about a module, and a tester told
 * only the acceptance criteria writes tests about behaviour.
 * `test/worker-entry/tester-gate.test.ts` asserts the absence.
 *
 * **How to avoid writing a test that cannot fail.** That is step 8.7's assertion
 * floor and step 8.8's must-fail-at-base guardrail, and a prompt is the wrong
 * place for it — the same reason ROLE-06 is a workspace composition and not an
 * instruction.
 *
 * ## What it IS told, and why each item is on the list
 *
 * Step 8.0's spike settled this: the acceptance criteria with their ids, the base
 * URL of the running app, the test directory (which is its own workspace, so it
 * is simply "what you can see"), and **the command that runs the suite** — which
 * until step 8.5 this module's docblock claimed and its prompt did not contain.
 * The command is shown with its environment **already interpolated**, so what the
 * tester is told is what runs (rule 8). Plus the one thing the spike insisted on:
 * that the blindness is deliberate and the implementation is absent rather than
 * off-limits.
 *
 * **Ambiguity is reported, not guessed** — a `warn` naming the criterion and the
 * reading taken, which `aggregate` already knows never produces a `send_back`.
 */
import * as z from 'zod';
import {
  interpolateCommandEnv,
  TestSuiteSchema,
  type CommandSpec,
} from '@adl/core/config';
import type { AgentEvent, GateContext, RunnerEvidence } from '@adl/core/stage';
import {
  judgeRunnerReport,
  readRunnerReport,
  stageErrorPolicy,
} from '@adl/core/stage';
import {
  fingerprintFinding,
  unknownCitedCriteria,
  VerdictSchema,
  type Verdict,
} from '@adl/core/verdict';
import type { StageRunnerVerdict } from '../../ipc/stage-verdict.js';
import type { AgentGateHost } from './agent-gate-host.js';
import { runCaptured } from './captured-exec.js';
import { verdictPathFor } from './reviewer-gate.js';

/**
 * How long the tester gets before it is killed and reported as a timeout.
 *
 * The same ceiling the reviewer gets, and the same reason: `EffectiveConfig.limits`
 * has no per-invocation wall-clock field. It does **not** cover the suite ADL runs
 * afterwards, which is bounded by its own `with.suite.command.timeout`.
 */
const TESTER_MAX_WALL_CLOCK_MS = 10 * 60 * 1000;

/**
 * The tester's own `with:` block — `strictObject`, because a misspelled key here
 * is a configuration error worth reporting, not a third party's business.
 *
 * The suite lives under `suite` and never under `command`: `declaresCommand`
 * reads a top-level `with.command` object as "this entry is a program", which
 * would dispatch this stage as a plain command gate instead of the tester.
 */
const TesterWithSchema = z.strictObject({ suite: TestSuiteSchema });

/** How much of a claim's own words travel into an `inconclusive` reason. */
const CLAIM_EXCERPT_CHARS = 200;

/**
 * The loopback URL of the app, composed here rather than handed over.
 *
 * `GateContext.app` carries a port and not a URL, deliberately — see its own
 * docblock: a URL would make ADL own an `http://` convention that is wrong for
 * the app with no HTTP surface `ExecReadyProbeSchema` exists for. The gate that
 * knows it is testing an HTTP app is the right place to assume one.
 */
function baseUrlFor(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

const TESTER_SYSTEM_PROMPT =
  'You are the ADL behaviour tester. You verify that a running application does what its ' +
  'specification says, by writing and running tests against it over the network. ' +
  '**You cannot read the implementation, and this is deliberate: the source is not on disk ' +
  'in your workspace at all.** Do not spend turns looking for it — there is nothing to find, ' +
  'and no command will recover it. Judge the application by its observable behaviour only. ' +
  'Write tests and your verdict file; change nothing else.';

/** `AC-3: the export button appears`, one per line, in the spec's own order. */
function renderCriteria(gate: GateContext): string {
  const criteria = gate.spec.acceptanceCriteria;
  if (criteria.length === 0) {
    return '(no acceptance criteria — this spec should not have loaded)';
  }
  return criteria
    .map((criterion) => `- ${criterion.id}: ${criterion.text}`)
    .join('\n');
}

/** An argv element as a person would type it: bare when it can be, JSON-quoted when it cannot. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : JSON.stringify(word);
}

/** The suite as the tester is told it, with the env ALREADY interpolated — what it is told is what runs. */
function renderSuite(command: CommandSpec): string {
  const env = Object.entries(command.env ?? {});
  return [
    `Command: ${command.argv.map(shellWord).join(' ')}`,
    `Directory: ${command.cwd ?? '.'}`,
    ...(env.length === 0
      ? ['Environment: (nothing beyond the defaults)']
      : ['Environment:', ...env.map(([name, value]) => `- ${name}=${value}`)]),
  ].join('\n');
}

/**
 * The instructions handed to the tester.
 *
 * Composed here rather than in `prompt/build.ts`, which this directory may not
 * import — that is where the *developer's* prompt lives, and a gate that can reach
 * it can read what the developer was asked (`adl/gate-fresh-context`).
 *
 * The verbatim spec goes in alongside the identified criteria, for
 * `buildDeveloperPrompt`'s reason: a criterion's own text slice does not carry the
 * tables, links and nuance around it. For a code-blind tester that matters more
 * than it does for the reviewer — the spec is the *only* description of intent it
 * will ever see.
 */
function renderInstructions(
  gate: GateContext,
  baseUrl: string,
  verdictPath: string,
  suite: CommandSpec,
): string {
  return [
    `# Behaviour test: ${gate.spec.title}`,
    '',
    '## Acceptance criteria',
    '',
    renderCriteria(gate),
    '',
    '## The specification, verbatim',
    '',
    gate.spec.raw,
    '',
    '## The application under test',
    '',
    // On its own line with no trailing punctuation, deliberately: a URL at the end
    // of a sentence invites both a model and a parser to take the full stop with
    // it, which is a five-minute debugging session for everyone who ever hits it.
    `Base URL: ${baseUrl}`,
    '',
    'It is already built, started and answering there. ADL started it and ADL will',
    'stop it — do not start or stop it yourself.',
    '',
    '## Your workspace',
    '',
    'Everything you can see in your working directory is everything you have. The',
    'application source is **not** there: it was never copied in, there is no `.git`',
    'to recover it from, and no repository above you. That is on purpose, so that',
    'what you verify is behaviour rather than implementation.',
    '',
    '## How ADL runs your tests',
    '',
    'When you have finished, ADL runs this suite itself, in your working directory:',
    '',
    renderSuite(suite),
    '',
    '**That run decides this stage’s outcome, not your verdict.** A test that fails',
    'there sends the feature back to the developer, with your test’s name as the',
    'finding’s title and its failure message as the detail — so name each test after',
    'the criterion and behaviour it checks, keep anything that changes between runs',
    '(ports, times) out of the name, and make every assertion message say what you',
    'sent and what came back. A run in which no test executes — none written, or all',
    'skipped — is never a pass: it goes to a human. A problem you report while every',
    'test passes also goes to a human instead of sending the feature back — if',
    'something is wrong, write a test that fails.',
    '',
    'If the environment above carries the application’s address, read it from there',
    'rather than writing the port into a test: your tests will be run again later,',
    'against an app on a different port.',
    '',
    '## What to do',
    '',
    `1. Write tests that exercise ${baseUrl} against the acceptance criteria above.`,
    '   Put them in the directory you can already see tests in, following the',
    '   conventions of the tests that are there.',
    '2. Run them with the command and environment above, as often as you like — your',
    '   run is not the one that counts, and reading what actually happened is.',
    `3. Write your verdict as a single JSON object to \`${verdictPath}\`.`,
    '',
    'The verdict must match ADL’s published verdict schema:',
    '',
    '- `{"outcome":"pass","summary":"…","checked":[{"kind":"criterion","id":"AC-1"}, …]}`',
    '  — the criteria you believe your passing tests verify, by the exact ids listed',
    '  above. A pass must cite at least one of them.',
    '- `{"outcome":"send_back","summary":"…","findings":[{"fingerprint":"…","severity":"blocker",',
    '  "title":"…","detail":"…","criterionRef":{"kind":"criterion","id":"AC-2"}}]}`',
    '  — when a test you wrote FAILED. Put what you sent and what came back in',
    '  `detail`. `fingerprint` is 64 lowercase hex characters identifying this finding',
    '  stably across rounds — derive it from the stage and the finding title, never',
    '  from a line number or a timestamp.',
    '',
    'If a criterion admits more than one reading and you cannot resolve it — which you',
    'often will not be able to, because you cannot look at the implementation — then',
    '**write the test against the most literal reading and say so**: add a finding with',
    '`"severity":"minor"` naming the criterion and the reading you took, inside a',
    '`send_back` if a test failed, or use',
    '`{"outcome":"warn","summary":"…","findings":[…]}` if everything passed and the only',
    'thing worth saying is which reading you assumed. A `warn` is not a failure and does',
    'not send the feature back; it reaches the developer and the pull request.',
    '',
    'Do not report a pass for a criterion you did not test. A criterion you could not',
    'test at all is a finding, not a silent omission.',
  ].join('\n');
}

/**
 * Run the tester, then its suite, and report what the suite decided.
 *
 * Never throws: every failure becomes a `StageRunnerVerdict`, beside the code that
 * knows what went wrong. Every refusal that needs no agent happens before one is
 * paid for.
 */
export async function runTesterGate(
  gate: GateContext,
  host: AgentGateHost,
): Promise<StageRunnerVerdict> {
  // Before anything is spent. A tester with no app cannot test behaviour, and
  // reporting a `pass` from one would be the exact silently-green failure this
  // milestone exists to prevent. `binary_missing` because it is a configuration
  // fact that another attempt cannot change — the same classification
  // `resolveStageRole` gives a stage this build cannot run. `host.variables` is
  // present exactly when `gate.app` is; both are checked so neither is trusted
  // to imply the other.
  if (gate.app === undefined || host.variables === undefined) {
    return stageError(
      'binary_missing',
      `the ${gate.stageId} gate is the behaviour tester and was dispatched without an app under test. ` +
        "Add `needs_app: true` to this stage's pipeline entry so ADL builds, starts and " +
        "reaps the app around it (ROLE-07). ADL does not infer it from the stage's name, " +
        "because a built-in that quietly got more than a third party's gate would make " +
        'HARN-04 false.',
    );
  }

  const parsedWith = TesterWithSchema.safeParse(gate.config);
  if (!parsedWith.success) {
    return stageError(
      'unparseable',
      `the ${gate.stageId} gate's \`with:\` block must declare the suite ADL runs after the ` +
        'tester (ROLE-08) — for example `with: { suite: { command: { argv: [node, --test, ' +
        '--test-reporter=tap] }, emits: tap } }`: ' +
        parsedWith.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
    );
  }
  const { suite } = parsedWith.data;

  // D-21: a variable ADL does not supply is refused, not substituted with
  // nothing — and refused here, before the agent is paid for, because it will
  // not interpolate on a retry either. The same function and the same record a
  // command gate's `env` is interpolated with.
  let suiteCommand: CommandSpec;
  try {
    suiteCommand = interpolateCommandEnv(suite.command, host.variables);
  } catch (error) {
    return stageError(
      'unparseable',
      `the ${gate.stageId} gate's suite env could not be interpolated: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const verdictPath = verdictPathFor(gate.stageId);
  const baseUrl = baseUrlFor(gate.app.port);

  const runResult = await gate.agents.run(
    {
      systemPrompt: TESTER_SYSTEM_PROMPT,
      instructions: renderInstructions(
        gate,
        baseUrl,
        verdictPath,
        suiteCommand,
      ),
      contextFiles: [],
      limits: { maxWallClockMs: TESTER_MAX_WALL_CLOCK_MS },
    },
    {
      workspace: gate.workspace,
      onEvent: (event: AgentEvent) => {
        gate.onEvent(event);
      },
      // `runReviewerGate`'s reasoning verbatim: `AgentRunContext.signal` is
      // required and `GateContext.signal` is not, and a fresh never-firing
      // controller is the honest filler rather than a cast.
      signal: gate.signal ?? new AbortController().signal,
    },
  );

  if (runResult.outcome !== 'completed') {
    return stageError(
      runResult.outcome === 'cancelled' ? 'timeout' : 'provider_error',
      `the ${gate.stageId} tester did not complete (${runResult.outcome})`,
    );
  }

  let raw: string;
  try {
    raw = await gate.workspace.read(verdictPath);
  } catch (error) {
    return stageError(
      'unparseable',
      `the ${gate.stageId} tester completed but wrote no verdict to ` +
        `${verdictPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (error) {
    return stageError(
      'unparseable',
      `the ${gate.stageId} tester's verdict file is not JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const claimed = VerdictSchema.safeParse(parsed);
  if (!claimed.success) {
    return stageError(
      'unparseable',
      `the ${gate.stageId} tester's verdict file is not a valid verdict: ` +
        claimed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
    );
  }
  const claim = claimed.data;

  // ROLE-04, on the CLAIM, before the suite is paid for — see the module
  // docblock: the verdict `stage-runner.ts` checks is the reconciled one, and it
  // no longer carries the claim's citations.
  const knownCriterionIds = gate.spec.acceptanceCriteria.map(
    (criterion) => criterion.id,
  );
  const unknown = unknownCitedCriteria({ verdict: claim, knownCriterionIds });
  if (unknown.length > 0) {
    return stageError(
      'unparseable',
      `the ${gate.stageId} tester's verdict cites ${unknown.length === 1 ? 'a criterion' : 'criteria'} ` +
        `the spec does not contain: ${unknown.join(', ')}. The spec defines ` +
        `${knownCriterionIds.length === 0 ? 'none' : knownCriterionIds.join(', ')}.`,
    );
  }

  // ROLE-08: the suite, run by ADL, in the tester's own blind workspace, with the
  // app still up (this runs inside `withAppUnderTest`'s body).
  const run = await runCaptured(gate, {
    command: suiteCommand,
    path: host.path,
    readStdout: true,
    transcriptPrefix: 'suite:',
  });
  const runLabel = suiteCommand.argv.join(' ');

  if (run.kind === 'spawn_failed') {
    return stageError(
      'provider_error',
      `the ${gate.stageId} tester's suite \`${runLabel}\` could not be run: ${run.detail}`,
    );
  }
  // One terminal record for the suite, so a transcript reader can tell "ADL's
  // run finished" from "the file stopped growing". A `text` record rather than a
  // second `result`: the agent's run already has its own.
  gate.onEvent({
    kind: 'text',
    messageId: 'suite:exit',
    delta:
      run.kind === 'killed'
        ? `killed after ${String(run.durationMs)}ms`
        : `exited ${String(run.exitCode)} after ${String(run.durationMs)}ms`,
  });
  if (run.kind === 'killed') {
    return stageError(
      'timeout',
      `the ${gate.stageId} tester's suite \`${runLabel}\` was killed after ` +
        `${String(run.durationMs)}ms without exiting: ${run.tail}`,
    );
  }
  if (run.stdoutOverflowed) {
    return stageError(
      'unparseable',
      `the ${gate.stageId} tester's suite \`${runLabel}\` printed more report than ADL reads; ` +
        'it was not judged in part',
    );
  }

  const evidence = judgeRunnerReport({
    stageId: gate.stageId,
    runLabel,
    exitCode: run.exitCode,
    read: readRunnerReport(suite.emits, run.stdout),
    outputTail: run.tail,
  });
  return reconcileTesterClaim({ stageId: gate.stageId, claim, evidence });
}

/** A claim, in at most {@link CLAIM_EXCERPT_CHARS} of its own words. */
function claimInItsOwnWords(claim: Verdict): string {
  const words =
    claim.outcome === 'send_back'
      ? `${claim.summary} (${claim.findings.map((finding) => finding.title).join('; ')})`
      : claim.outcome === 'fail' ||
          claim.outcome === 'inconclusive' ||
          claim.outcome === 'skip'
        ? claim.reason
        : claim.summary;
  return words.length <= CLAIM_EXCERPT_CHARS
    ? words
    : `${words.slice(0, CLAIM_EXCERPT_CHARS)}…`;
}

/**
 * The run decides; the claim can only make it stricter. The module docblock's
 * table, as code — exported so every row is tested directly.
 */
export function reconcileTesterClaim(input: {
  readonly stageId: string;
  readonly claim: Verdict;
  readonly evidence: RunnerEvidence;
}): StageRunnerVerdict {
  const { stageId, claim, evidence } = input;

  switch (evidence.kind) {
    case 'unjudgeable':
      return stageError(
        'unparseable',
        `the ${stageId} tester's suite could not be judged: ${evidence.detail}`,
      );

    case 'failed': {
      const disagreed =
        claim.outcome === 'send_back'
          ? ''
          : `the tester reported \`${claim.outcome}\`; its suite disagrees — `;
      return {
        kind: 'verdict',
        verdict: {
          ...evidence.verdict,
          summary: `${disagreed}${evidence.verdict.summary}`,
        },
      };
    }

    case 'nothing_executed':
      return {
        kind: 'verdict',
        verdict: {
          ...evidence.verdict,
          reason:
            `${evidence.verdict.reason}; the tester reported \`${claim.outcome}\`: ` +
            claimInItsOwnWords(claim),
        },
      };

    case 'passed': {
      const executed = evidence.executed.length;
      switch (claim.outcome) {
        case 'pass': {
          const claimedIds = claim.checked
            .filter((ref) => ref.kind === 'criterion')
            .map((ref) => ref.id);
          return {
            kind: 'verdict',
            verdict: {
              ...evidence.verdict,
              summary:
                claimedIds.length === 0
                  ? evidence.verdict.summary
                  : `${evidence.verdict.summary} — the tester claimed ${claimedIds.join(', ')}; ` +
                    'recorded as its claim, not as coverage, until step 8.7 links tests to criteria',
            },
          };
        }
        case 'warn':
          return {
            kind: 'verdict',
            verdict: {
              outcome: 'warn',
              summary: `${evidence.verdict.summary} — the tester noted: ${claim.summary}`,
              // A model-authored fingerprint is never a stall key ADL trusts:
              // recomputed from the stage and the title, as every ADL-produced
              // finding's is.
              findings: claim.findings.map((finding) => ({
                ...finding,
                fingerprint: fingerprintFinding({
                  stageId,
                  title: finding.title,
                  location: finding.location,
                }),
              })),
            },
          };
        case 'send_back':
        case 'fail':
        case 'inconclusive':
        case 'skip':
          return {
            kind: 'verdict',
            verdict: {
              outcome: 'inconclusive',
              summary: `the ${stageId} tester's claim and its suite disagree`,
              reason:
                `every test the suite executed passed (${String(executed)}), but the tester ` +
                `reported \`${claim.outcome}\`: ${claimInItsOwnWords(claim)} — ADL does not ` +
                'act on a claim no executed test backs; a failing test is how a tester shows a defect',
            },
          };
        default: {
          const unhandled: never = claim;
          return unhandled;
        }
      }
    }

    default: {
      const unhandled: never = evidence;
      return unhandled;
    }
  }
}

/** A `StageError` envelope with `retryable` derived from the kind, never restated (rule 8). */
function stageError(
  kind: 'provider_error' | 'timeout' | 'unparseable' | 'binary_missing',
  detail: string,
): StageRunnerVerdict {
  return {
    kind: 'stage_error',
    error: { kind, retryable: stageErrorPolicy(kind).retryable, detail },
  };
}
