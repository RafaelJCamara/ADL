import {
  HarnessResolutionError,
  resolvePipeline,
  type ResolvedStage,
} from '@adl/core/config';

/**
 * `resolveSnapshotPipeline` — `@adl/core/config`'s `resolvePipeline`, applied
 * to the pipeline a feature snapshotted at lease time (M05 step 5.13).
 *
 * `resolvePipeline` has existed since M01 with no caller. This is it, and
 * there is exactly one so that dispatch and the round loop cannot disagree
 * about what the pipeline *is*: `dispatchOnce` names the stage it is about to
 * run from this list, and `loop/round-runner.ts` decides what runs next from
 * the same list, read back out of the same `effective_config_json` column.
 *
 * **Resolved from the snapshot, never from live `adl.yml`.** Versioning rule 3
 * (`state/feature-state.ts`): the effective configuration is snapshotted into
 * the feature row at lease time, so editing `adl.yml` mid-flight must not
 * change a running feature's pipeline. Reading the column is what makes that
 * true here rather than merely intended.
 *
 * ## The registry is the built-ins, and that is a real limitation today
 *
 * D-23's resolution order is built-in id → npm package → repo-relative path,
 * and the second and third tiers need a harness loader that does not exist
 * yet (M13). `resolvePipeline`'s default registry is the three built-in stage
 * ids, so a pipeline naming `{ harness: security }` resolves to nothing and
 * this function reports a refusal rather than pretending. That is the honest
 * answer: ADL genuinely cannot run a harness it has no loader for, and
 * silently skipping the entry would be a round that reported on a pipeline it
 * did not run.
 *
 * Returned rather than thrown (rule 5): "this configuration names a harness
 * this build cannot run" is expected-but-notable, and both callers have to
 * classify it — dispatch refuses to dispatch, the round loop escalates — which
 * a `try`/`catch` around a resolution deep inside either would obscure.
 */

export type SnapshotPipeline =
  | { readonly ok: true; readonly stages: readonly ResolvedStage[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Read the ordered, resolved pipeline back out of a feature's snapshotted
 * `effective_config_json`.
 *
 * A `null` column (nothing has ever been leased, so no configuration was
 * snapshotted), malformed JSON, a missing or empty `pipeline` array, and an
 * unresolvable harness id are all refusals naming what was wrong. Never throws.
 */
export function resolveSnapshotPipeline(
  effectiveConfigJson: string | null,
): SnapshotPipeline {
  if (effectiveConfigJson === null) {
    return {
      ok: false,
      reason:
        'the feature has no snapshotted effective configuration — nothing has been leased for it yet',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(effectiveConfigJson) as unknown;
  } catch (error) {
    return {
      ok: false,
      reason: `the snapshotted effective configuration did not parse as JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const entries =
    typeof parsed === 'object' && parsed !== null && 'pipeline' in parsed
      ? (parsed as { pipeline: unknown }).pipeline
      : undefined;
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      ok: false,
      reason:
        'the snapshotted effective configuration carries no non-empty `pipeline` array',
    };
  }

  try {
    return {
      ok: true,
      stages: resolvePipeline(entries as Parameters<typeof resolvePipeline>[0]),
    };
  } catch (error) {
    if (error instanceof HarnessResolutionError) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
}
