/**
 * The reviewer gate (ROLE-02, M07 step 7.4) — ADL's first agent-backed gate,
 * and the first thing to run on the published gate contract with no privileged
 * path of any kind.
 *
 * ## Why it is a gate and not a role
 *
 * HARN-04 asks that the reviewer be "implemented on the same interface third
 * parties use". That is only a real claim if removing it from `adl.yml` removes
 * it from the pipeline, which is 7.9's proof. Everything that makes this
 * function work is a member of {@link GateContext} — the spec, the diff, the
 * workspace, its own `with:` block, and an {@link AgentRunner}. There is no
 * parameter through which the developer's session, transcript, rendered prompt
 * or send-back brief could arrive, and `eslint.config.js`'s
 * `adl/gate-fresh-context` closes the residual a type cannot: this directory
 * may not import the transcript store, the prompt builder, the round loop, or
 * the assign envelope.
 *
 * ## Why the verdict comes from a FILE, not from the transcript
 *
 * An agentic CLI owns its own loop and prints prose. Scraping a verdict out of
 * that prose would make ADL's contract "whatever the model happened to say
 * last", which is exactly the class of thing CORE-06 exists to keep out of the
 * verdict channel. So the reviewer is told to *write* its verdict to a path in
 * the workspace, and this module reads that file and validates it against the
 * same `VerdictSchema` the published JSON Schema is emitted from. `adl.yml`'s
 * `ADL_VERDICT_FILE` interpolation variable has named this mechanism since M01
 * — this is its first consumer.
 *
 * **Every failure to produce a valid verdict is a `StageError`, never a
 * verdict.** No file, unreadable file, not JSON, JSON that is not a verdict:
 * all `unparseable`, all non-retryable, all escalating to a human. A reviewer
 * that did not judge must never cost the developer a round, and — far more
 * importantly — must never be read as approval. The same discipline
 * `command-gate.ts` applies to a command it had to kill.
 *
 * ## What this module does NOT do
 *
 * - **It does not check that the citations name real criteria.** That is M07
 *   step 7.6 (ROLE-04), and it is deliberately a separate step: the schema can
 *   check that a `pass` cites *something*, and only something holding the spec
 *   can check that what it cites *exists*.
 * - **It does not decide whether the round ends.** `on_send_back` is the
 *   pipeline's policy (7.2), read by the manager from the resolved stage.
 * - **It does not report its own spend.** The `AgentRunner` it is handed
 *   already does (7.1) — there is no call here to forget.
 */
import type { AgentEvent, GateContext } from '@adl/core/stage';
import { stageErrorPolicy } from '@adl/core/stage';
import { VerdictSchema } from '@adl/core/verdict';
import type { StageRunnerVerdict } from '../../ipc/stage-verdict.js';

/**
 * Where the reviewer is told to write its verdict, relative to the workspace
 * root.
 *
 * Under `.adl/` because that directory is ADL's own inside a feature worktree
 * and is not the repository's source: a reviewer writing here cannot collide
 * with the developer's work, and a stray file left behind is obviously ADL's.
 * The stage id is in the name so two agent gates in one pipeline cannot
 * overwrite each other's answer — a real possibility now that a pipeline may
 * carry more than one.
 */
export function verdictPathFor(stageId: string): string {
  return `.adl/${stageId}-verdict.json`;
}

/** How long the reviewer gets before it is killed and reported as a timeout. */
const REVIEWER_MAX_WALL_CLOCK_MS = 10 * 60 * 1000;

const REVIEWER_SYSTEM_PROMPT =
  'You are the ADL code reviewer. You are reviewing one feature branch against the ' +
  'specification it was written from. You did not write this code and you have no access to ' +
  "the developer's reasoning — judge what the diff actually does, not what it intended. " +
  'Report code-quality problems as well as unmet acceptance criteria. Do not modify any ' +
  'file except the verdict file you are told to write.';

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

function renderChangedPaths(gate: GateContext): string {
  const paths = gate.diff.changedPaths;
  if (paths.length === 0) return '(no files changed)';
  return paths.map((path) => `- ${path}`).join('\n');
}

/**
 * The instructions handed to the reviewer.
 *
 * Composed here rather than in `prompt/build.ts` for a reason the lint fence
 * makes literal: this directory may not import the prompt builder, because
 * that is where the *developer's* prompt lives and a gate that can reach it
 * can read what the developer was asked. A gate's own prompt is the gate's.
 *
 * The verbatim spec text goes in alongside the identified criteria, for the
 * same reason `buildDeveloperPrompt` includes it: a criterion's own text slice
 * does not carry the tables, links and nuance around it, and a reviewer judging
 * against less than the developer saw would raise findings about things the
 * spec answered.
 */
function renderInstructions(gate: GateContext, verdictPath: string): string {
  return [
    `# Review: ${gate.spec.title}`,
    '',
    '## Acceptance criteria',
    '',
    renderCriteria(gate),
    '',
    '## The specification, verbatim',
    '',
    gate.spec.raw,
    '',
    '## What this branch changed',
    '',
    `Base: ${gate.diff.base}`,
    `Head: ${gate.diff.head}`,
    '',
    renderChangedPaths(gate),
    '',
    '## What to do',
    '',
    'Read the changed files. Judge the implementation against every acceptance criterion',
    'above, and against ordinary code quality.',
    '',
    `Then write your verdict as a single JSON object to \`${verdictPath}\`, and write`,
    'nothing else anywhere. The verdict must match ADL’s published verdict schema:',
    '',
    '- `{"outcome":"pass","summary":"…","checked":[{"kind":"criterion","id":"AC-1"}, …]}`',
    '  — every criterion you actually verified. An approval that cites nothing is rejected.',
    '- `{"outcome":"send_back","summary":"…","findings":[{"fingerprint":"…","severity":"blocker",',
    '  "title":"…","detail":"…","criterionRef":{"kind":"criterion","id":"AC-2"}}]}`',
    '  — `criterionRef` may instead be `{"kind":"global","category":"code_quality"}` for a',
    '  finding that is not about one criterion. `fingerprint` is 64 lowercase hex characters',
    '  identifying this finding stably across rounds — derive it from the stage and the',
    '  finding title, never from a line number or a timestamp.',
    '- `{"outcome":"inconclusive","summary":"…","reason":"…"}` if you genuinely could not',
    '  tell. That is an honest answer and it is never treated as a pass.',
    '',
    'Do not report a pass for a criterion you did not check.',
  ].join('\n');
}

/**
 * Run the reviewer and report what it decided.
 *
 * Never throws: every failure becomes a `StageRunnerVerdict`, because the
 * caller (`stage-runner.ts`) has no better classification available than the
 * one made here, beside the code that knows what went wrong.
 */
export async function runReviewerGate(
  gate: GateContext,
): Promise<StageRunnerVerdict> {
  const verdictPath = verdictPathFor(gate.stageId);

  const runResult = await gate.agents.run(
    {
      systemPrompt: REVIEWER_SYSTEM_PROMPT,
      instructions: renderInstructions(gate, verdictPath),
      contextFiles: [],
      limits: { maxWallClockMs: REVIEWER_MAX_WALL_CLOCK_MS },
    },
    {
      workspace: gate.workspace,
      onEvent: (event: AgentEvent) => {
        gate.onEvent(event);
      },
      // `AgentRunContext.signal` is required, and `GateContext.signal` is not
      // — a gate may be run by a caller with nothing to cancel on. A fresh
      // never-firing controller is the honest filler: the alternative is a
      // cast, which would make an absent signal look like a present one at
      // every later read.
      signal: gate.signal ?? new AbortController().signal,
    },
  );

  if (runResult.outcome !== 'completed') {
    // The agent did not finish, so it did not judge. `cancelled` is a kill —
    // a timeout or a shutdown — and `turn_limit_reached` is a budget the
    // backend enforced; neither produced an opinion about this code.
    return stageError(
      runResult.outcome === 'cancelled' ? 'timeout' : 'provider_error',
      `the ${gate.stageId} reviewer did not complete (${runResult.outcome})`,
    );
  }

  let raw: string;
  try {
    raw = await gate.workspace.read(verdictPath);
  } catch (error) {
    return stageError(
      'unparseable',
      `the ${gate.stageId} reviewer completed but wrote no verdict to ${verdictPath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (error) {
    return stageError(
      'unparseable',
      `the ${gate.stageId} reviewer's verdict file is not JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = VerdictSchema.safeParse(parsed);
  if (!result.success) {
    return stageError(
      'unparseable',
      `the ${gate.stageId} reviewer's verdict file is not a valid verdict: ` +
        result.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
    );
  }

  return { kind: 'verdict', verdict: result.data };
}

/** A `StageError` envelope with `retryable` derived from the kind, never restated (rule 8). */
function stageError(
  kind: 'provider_error' | 'timeout' | 'unparseable',
  detail: string,
): StageRunnerVerdict {
  return {
    kind: 'stage_error',
    error: { kind, retryable: stageErrorPolicy(kind).retryable, detail },
  };
}
