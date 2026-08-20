/**
 * `src/stage-name.ts` — resolving a feature's stage cell (D-22..25) from its
 * own persisted row, with no help from the lifecycle.
 *
 * `feature-state.ts`'s own docblock explains why the pipeline is not part of
 * the `FeatureState` union: `gating` is one state, and the pipeline position
 * is `features.current_stage_index` — data on a row, not a name the lifecycle
 * carries (EXEC-07). That is exactly what makes this module necessary: the
 * dashboard reading `current_stage_index` against the pipeline snapshotted in
 * `effective_config_json` is "strictly richer than a state name would have
 * been," and this file is that reading, done once, in the one place the
 * manager already owns `effective_config_json`.
 *
 * `TransitionCtx` still carries only a length and an index — nothing here
 * changes that. This module reads the *stored*, already-snapshotted pipeline
 * back out of a feature row for **display only**; it is never consulted by
 * `transition()` and never feeds a decision back into the lifecycle.
 */

/** The pipeline entries `EffectiveConfigSchema.pipeline` actually stores. */
type StoredPipelineEntry = string | { readonly harness?: unknown };

function stageNameOf(entry: StoredPipelineEntry): string {
  if (typeof entry === 'string') return entry;
  const harness =
    typeof entry === 'object' && entry !== null ? entry.harness : undefined;
  return typeof harness === 'string' ? harness : '';
}

/**
 * Read the ordered stage names back out of a feature's snapshotted
 * `effective_config_json`.
 *
 * Returns `undefined` for anything that is not a usable pipeline: a `null`
 * column (nothing has been leased yet — no config was ever snapshotted),
 * malformed JSON, or a shape that does not carry a `pipeline` array. Never
 * throws — a status view that crashes on an unusual row is worse than one
 * that shows less (D-24).
 */
export function pipelineFromEffectiveConfig(
  effectiveConfigJson: string | null,
): readonly string[] | undefined {
  if (effectiveConfigJson === null) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(effectiveConfigJson);
  } catch {
    return undefined;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('pipeline' in parsed) ||
    !Array.isArray((parsed as { pipeline: unknown }).pipeline)
  ) {
    return undefined;
  }

  return (parsed as { pipeline: readonly StoredPipelineEntry[] }).pipeline.map(
    stageNameOf,
  );
}

/**
 * The stage cell `GET /features` and `adl status` render (D-22..25):
 * `state` alone is always present; `position`/`pipelineLength`/`name` are
 * present together only when the row's snapshotted pipeline resolves to a
 * usable, non-empty list. `label` is the fully-formatted cell — e.g.
 * `gating 2/4 (test)` — pre-assembled here so every caller (the manager's own
 * test, the CLI's table renderer) reaches for the same string rather than
 * re-deriving the "state position/length (name)" format independently.
 */
export interface StageCell {
  readonly state: string;
  readonly position?: number;
  readonly pipelineLength?: number;
  readonly name?: string;
  readonly label: string;
}

/** The subset of a feature row `resolveStageCell` needs. */
export interface StageCellInput {
  readonly state: string;
  readonly current_stage_index: number;
  readonly effective_config_json: string | null;
}

/**
 * Resolve one feature row's `StageCell` — one-based position, pipeline
 * length, and the resolved stage name, joined against the pipeline
 * snapshotted at lease time.
 *
 * A row with no resolvable pipeline (nothing leased yet, or malformed data)
 * renders the state alone: no position, no pipeline length, no name, and
 * `label` is exactly `state` — never `undefined` printed as text, and never
 * a throw (D-24's "a status view that crashes on an unusual row is worse
 * than one that shows less").
 */
export function resolveStageCell(feature: StageCellInput): StageCell {
  const pipeline = pipelineFromEffectiveConfig(feature.effective_config_json);

  if (pipeline === undefined || pipeline.length === 0) {
    return { state: feature.state, label: feature.state };
  }

  const position = feature.current_stage_index + 1;
  const name = pipeline[feature.current_stage_index];

  return {
    state: feature.state,
    position,
    pipelineLength: pipeline.length,
    ...(name !== undefined ? { name } : {}),
    label:
      name !== undefined
        ? `${feature.state} ${position}/${pipeline.length} (${name})`
        : `${feature.state} ${position}/${pipeline.length}`,
  };
}
