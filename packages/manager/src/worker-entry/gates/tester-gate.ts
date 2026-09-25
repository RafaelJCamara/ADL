/**
 * The behaviour tester (ROLE-05, M08 step 8.4) — an agent that judges a running
 * app and **structurally cannot read the implementation that runs it**.
 *
 * `runReviewerGate`'s shape, deliberately: compose a prompt, run through
 * `GateContext.agents`, read a verdict out of a file, and treat every way of not
 * producing one as a `StageError`. Everything that differs is a consequence of
 * two facts about what this gate is handed rather than a second mechanism.
 *
 * ## The two things that make it a tester rather than a second reviewer
 *
 * 1. **Its workspace holds only what the pipeline entry declared** (ROLE-06, step
 *    8.1). A materialised copy of `visible_paths` with no `.git`, outside every
 *    repository — so the implementation is *absent*, not forbidden. This module
 *    contains no code enforcing that and should not: code-blindness is a property
 *    of what is on disk under `Workspace.root`, and a gate asked to honour it
 *    would be the *"merely forbidden by instruction"* criterion 1 rules out.
 * 2. **It is told the port of a running app** (ROLE-07, steps 8.2/8.3), through
 *    `GateContext.app` — the member this step added, and the first one an agent
 *    gate could not do without, because a command gate reads its port out of its
 *    own interpolated `env` and an agent gate has no command.
 *
 * ## It refuses to run without an app, and that is not a special case
 *
 * ADL does **not** infer `needs_app` from a stage's name — that would be exactly
 * the branch on the tester's identity HARN-04 forbids. So a pipeline that names
 * `behaviour` without declaring `needs_app: true` produces a tester with no app,
 * and this module returns a `StageError` naming the key rather than testing
 * nothing and reporting a pass.
 *
 * That is the same move `runReviewerGate` makes when it rejects an approval
 * citing no criterion, and reviewer-gate's own docblock says why it is the
 * opposite of special-casing: *"A gate being stricter about its own output is
 * what any third party's gate is equally free to do."*
 *
 * ## What the prompt deliberately does NOT say
 *
 * **The changed paths.** `GateContext.diff.changedPaths` is on the contract and
 * this gate receives it, exactly as every other gate does — withholding it *for
 * the tester* would be a special case, and step 8.1 flagged the disclosure to be
 * decided here rather than inherited. The decision is that the member stays and
 * the **prompt does not use it**, because the prompt is what shapes behaviour: a
 * tester told that `src/checkout/total.ts` changed writes tests about a module,
 * and a tester told only the acceptance criteria writes tests about behaviour.
 * A behaviour test derived from file names is a structural test wearing a
 * behaviour costume, which is the failure ROLE-05 exists to prevent.
 * `test/worker-entry/tester-gate.test.ts` asserts the absence, so it is a
 * checkable property rather than a comment.
 *
 * **How to avoid writing a test that cannot fail.** That is step 8.7's assertion
 * floor and step 8.8's must-fail-at-base guardrail, and a prompt is the wrong
 * place for it — the same reason ROLE-06 is a workspace composition and not an
 * instruction. M08 step 8.0's spike record says so outright.
 *
 * ## What it IS told, and why each item is on the list
 *
 * Step 8.0's spike settled this, and it is four things: the acceptance criteria
 * with their ids, the base URL of the running app, the declared test directory
 * (which is its own workspace, so it is simply "what you can see"), and the
 * command that runs the suite. Plus one thing the spike insisted on: **that the
 * blindness is deliberate and the implementation is absent rather than
 * off-limits.** A tester that does not know this spends turns hunting for source
 * that is not there, and 7.5's reviewer report is the precedent for how much
 * walking an agent will do before it concludes anything.
 *
 * **Ambiguity is reported, not guessed** — a `warn` finding naming the criterion
 * and the reading taken. This needs no new machinery: `aggregate` already knows a
 * `warn` never produces a `send_back` and that its findings still ride into the
 * brief and the pull request. Guessing silently would produce a false failure the
 * developer cannot act on; answering `inconclusive` would let one ambiguous
 * criterion sink an otherwise verified feature.
 */
import type { AgentEvent, GateContext } from '@adl/core/stage';
import { stageErrorPolicy } from '@adl/core/stage';
import { VerdictSchema } from '@adl/core/verdict';
import type { StageRunnerVerdict } from '../../ipc/stage-verdict.js';
import { verdictPathFor } from './reviewer-gate.js';

/**
 * How long the tester gets before it is killed and reported as a timeout.
 *
 * The same ceiling the reviewer gets, and the same reason: `EffectiveConfig.limits`
 * has no per-invocation wall-clock field. Note what this does **not** cover — the
 * app's build and start already happened before this function was called, and
 * `commands.build.timeout` bounds those.
 */
const TESTER_MAX_WALL_CLOCK_MS = 10 * 60 * 1000;

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
    '## What to do',
    '',
    `1. Write tests that exercise ${baseUrl} against the acceptance criteria above.`,
    '   Put them in the directory you can already see tests in, following the',
    '   conventions of the tests that are there.',
    '2. Run them, and read what actually happened.',
    `3. Write your verdict as a single JSON object to \`${verdictPath}\`.`,
    '',
    'The verdict must match ADL’s published verdict schema:',
    '',
    '- `{"outcome":"pass","summary":"…","checked":[{"kind":"criterion","id":"AC-1"}, …]}`',
    '  — every criterion you verified **with a test that ran and passed**, by the exact',
    '  ids listed above. A pass must cite at least one of them.',
    '- `{"outcome":"send_back","summary":"…","findings":[{"fingerprint":"…","severity":"blocker",',
    '  "title":"…","detail":"…","criterionRef":{"kind":"criterion","id":"AC-2"}}]}`',
    '  — for a criterion whose test ran and FAILED. Put what you sent and what came back',
    '  in `detail`; the developer cannot see your tests. `fingerprint` is 64 lowercase hex',
    '  characters identifying this finding stably across rounds — derive it from the stage',
    '  and the finding title, never from a line number or a timestamp.',
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
 * Run the tester and report what it decided.
 *
 * Never throws: every failure becomes a `StageRunnerVerdict`, beside the code that
 * knows what went wrong.
 */
export async function runTesterGate(
  gate: GateContext,
): Promise<StageRunnerVerdict> {
  // Before anything is spent. A tester with no app cannot test behaviour, and
  // reporting a `pass` from one would be the exact silently-green failure this
  // milestone exists to prevent. `binary_missing` because it is a configuration
  // fact that another attempt cannot change — the same classification
  // `resolveStageRole` gives a stage this build cannot run.
  if (gate.app === undefined) {
    return stageError(
      'binary_missing',
      `the ${gate.stageId} gate is the behaviour tester and was dispatched without an app under test. ` +
        "Add `needs_app: true` to this stage's pipeline entry so ADL builds, starts and " +
        "reaps the app around it (ROLE-07). ADL does not infer it from the stage's name, " +
        "because a built-in that quietly got more than a third party's gate would make " +
        'HARN-04 false.',
    );
  }

  const verdictPath = verdictPathFor(gate.stageId);
  const baseUrl = baseUrlFor(gate.app.port);

  const runResult = await gate.agents.run(
    {
      systemPrompt: TESTER_SYSTEM_PROMPT,
      instructions: renderInstructions(gate, baseUrl, verdictPath),
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

  const result = VerdictSchema.safeParse(parsed);
  if (!result.success) {
    return stageError(
      'unparseable',
      `the ${gate.stageId} tester's verdict file is not a valid verdict: ` +
        result.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
    );
  }

  // **Deliberately NOT the reviewer's extra check**, and the asymmetry is the
  // point rather than an omission.
  //
  // `runReviewerGate` rejects a `pass` whose `checked` list cites no criterion,
  // because a reviewer that checked no criterion has not reviewed against the
  // spec. The same rule would be wrong here for a reason step 8.5 owns: "this
  // suite ran and passed" and "this suite verified AC-3" are different claims,
  // and a tester's coverage claim is only trustworthy if it is derived from
  // structured runner output rather than from the model's own summary. Enforcing
  // citation *now* would reward a tester for asserting coverage it has no
  // evidence for — which is worse than an honest global citation.
  //
  // Step 8.5 is where "zero tests executed is not a pass" lands, and step 8.7's
  // spec-clause link is what makes a criterion citation from this gate mean
  // something. Until then the citation check that applies is the one every gate
  // gets: `stage-runner.ts` refuses a verdict citing a criterion the spec does
  // not contain (ROLE-04, M07 step 7.6).
  return { kind: 'verdict', verdict: result.data };
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
