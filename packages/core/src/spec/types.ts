/**
 * Which authoring format a spec was written in. Detection is by filename and
 * deterministic — `spec.md` → `adl-template`, `*.feature` → `gherkin` (D-17).
 * Content sniffing is deliberately not a thing: a spec that sniffs wrong
 * produces silently wrong acceptance criteria which then propagate into every
 * prompt, finding, and coverage row downstream.
 */
export type SourceFormat = 'adl-template' | 'gherkin';

/**
 * A supporting file beside the spec — a mockup, a sample payload, a schema —
 * that agents should read.
 *
 * `path` is workspace-relative. `@adl/core` never resolves or reads it; that
 * is the caller's job.
 */
export interface ContextRef {
  readonly path: string;
  /** Why this file matters, carried into the prompt beside the path. */
  readonly why?: string;
}

/**
 * One acceptance criterion, addressable by `id`.
 *
 * The `id` is the join key that propagates from the spec into the developer
 * prompt, every `Finding`, every test result, the send-back brief, and the PR
 * coverage table. Both spec formats share **one flat `AC-n` sequence** (D-02);
 * there is no separate `SCN-n` namespace and no addressable sub-steps.
 *
 * `textHash` exists solely so a stale cross-revision join can be invalidated
 * rather than silently mis-joining when a criterion's meaning changed between
 * spec revisions (D-01).
 */
export type AcceptanceCriterion =
  | {
      readonly id: string;
      readonly kind: 'statement';
      /** The author's original text, verbatim — a byte-exact source slice. */
      readonly text: string;
      readonly textHash: string;
    }
  | {
      readonly id: string;
      readonly kind: 'scenario';
      readonly name: string;
      readonly tags: readonly string[];
      readonly steps: readonly {
        readonly keyword: 'Given' | 'When' | 'Then' | 'And' | 'But';
        readonly text: string;
      }[];
      /**
       * A `Scenario Outline` is ONE criterion retaining its `Examples` table
       * verbatim — never expanded per example row. Expansion would multiply
       * the `AC-n` count by the row count and couple criterion IDs to test
       * data, and D-01 makes criterion numbering a one-way door.
       * (Assumption A6, resolved at plan 01-01's gate.)
       */
      readonly examples?: {
        readonly headers: readonly string[];
        readonly rows: readonly (readonly string[])[];
      };
      readonly textHash: string;
    };

/**
 * A feature spec after parsing, with the source always retained beside it.
 *
 * Two rules, both commonly got wrong:
 *
 * 1. **Normalise the container, not the content.** The criteria are structured;
 *    the author's words inside them are not rewritten.
 * 2. **Always ship `raw`.** The prompt contains the raw spec verbatim *and* the
 *    normalised criteria as an ID'd checklist. Never make an agent read only
 *    the parsed form — you lose tables, links, embedded diagrams, and nuance
 *    (CORE-05).
 */
export interface NormalizedSpec {
  /** The `features/<id>/` folder name; also the branch suffix (D-16). */
  readonly id: string;
  readonly title: string;
  readonly sourceFormat: SourceFormat;
  /** Prose intent, from `## Intent` in the ADL template. */
  readonly narrative?: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly nonGoals?: readonly string[];
  readonly constraints?: readonly string[];
  readonly contextRefs: readonly ContextRef[];
  /** ALWAYS the verbatim source. */
  readonly raw: string;
  /** `sha256Hex(raw)` — identity and change detection. */
  readonly specHash: string;
}
