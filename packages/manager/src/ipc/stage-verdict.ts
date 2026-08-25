import * as z from 'zod';
import { DeveloperOutcomeSchema, StageErrorSchema } from '@adl/core/stage';
import { VerdictSchema } from '@adl/core/verdict';

/**
 * `StageRunnerVerdict` — what a worker packs into `stage_result.verdictJson`,
 * and the manager's validated reader for it (M05 step 5.13).
 *
 * The envelope itself is M04's; what this module adds is the third member and
 * a **schema**. Until this step the type lived in `worker-entry/stage-runner.ts`
 * and the manager's only reader was a hand-rolled cast that peeked at one field
 * (`worker-supervisor/supervisor.ts`'s `committedShaFromVerdict`). That was
 * enough to answer "is there a sha to publish?" and is not enough to drive a
 * round: the loop branches on which of three things came back, and a cast
 * cannot tell a well-formed `blocked` outcome from a crashed worker's garbage.
 *
 * It lives under `ipc/` rather than under `worker-entry/` because it is a wire
 * contract with two ends, exactly like `protocol.ts` — the worker writes it and
 * the manager reads it, and putting the shared shape inside one end's directory
 * is what made the manager reach into `worker-entry/` for a type in the first
 * place.
 *
 * **Parsed, never trusted.** `parseStageRunnerVerdict` returns a discriminated
 * result and never throws, matching `parseWorkerMessage`'s own discipline just
 * next door: an unparseable payload from a crashed or malicious worker is an
 * infrastructure failure, never data (CORE-06). The caller turns that into a
 * `StageError` it can route, rather than a verdict it half-believes.
 */

/** The developer's own result — index 0 of the pipeline, and only there (D-05). */
const DeveloperOutcomeEnvelopeSchema = z
  .strictObject({
    kind: z.literal('developer_outcome'),
    outcome: DeveloperOutcomeSchema,
  })
  .meta({ id: 'StageRunnerDeveloperOutcome' });

/**
 * A gate's judgement — one of the six outcomes (CORE-01).
 *
 * **Nothing produces this yet.** `worker-entry/stage-runner.ts` runs the
 * developer agent and has no gate implementation to run; the command gate is
 * M05 step 5.14. The member is declared here rather than there because the
 * manager-side reader is what this step builds, and a reader that cannot
 * represent a gate verdict would have to be widened by the step that first
 * produces one — leaving the round loop, which is this step's whole subject,
 * untestable against the input it exists to consume.
 */
const VerdictEnvelopeSchema = z
  .strictObject({ kind: z.literal('verdict'), verdict: VerdictSchema })
  .meta({ id: 'StageRunnerGateVerdict' });

/** The stage broke rather than judged (D-12) — outside the verdict union entirely. */
const StageErrorEnvelopeSchema = z
  .strictObject({ kind: z.literal('stage_error'), error: StageErrorSchema })
  .meta({ id: 'StageRunnerStageError' });

export const StageRunnerVerdictSchema = z
  .discriminatedUnion('kind', [
    DeveloperOutcomeEnvelopeSchema,
    VerdictEnvelopeSchema,
    StageErrorEnvelopeSchema,
  ])
  .meta({
    id: 'StageRunnerVerdict',
    description:
      'What a worker reports for one stage attempt: a developer outcome, a gate verdict, or an infrastructure failure',
  });

/** Envelope carried over IPC as `verdictJson` (D-05, D-12). */
export type StageRunnerVerdict = z.infer<typeof StageRunnerVerdictSchema>;

export type StageRunnerVerdictParseResult =
  | { readonly ok: true; readonly verdict: StageRunnerVerdict }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate a `stage_result` message's `verdictJson`.
 *
 * Never throws: a payload that is not JSON, or is JSON that is not an
 * envelope, both resolve to `{ ok: false, reason }`. The distinction the
 * caller needs is not *why* it was malformed but that nothing in it can be
 * believed — which is a `StageError`, not a verdict.
 */
export function parseStageRunnerVerdict(
  verdictJson: string,
): StageRunnerVerdictParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(verdictJson) as unknown;
  } catch (error) {
    return {
      ok: false,
      reason: `verdictJson did not parse as JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const result = StageRunnerVerdictSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      reason: result.error.issues
        .map((issue) => {
          const path = issue.path.join('.');
          return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
        })
        .join('; '),
    };
  }

  return { ok: true, verdict: result.data };
}
