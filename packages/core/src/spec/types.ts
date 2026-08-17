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
 * The half-open region of `NormalizedSpec.raw` a criterion occupies.
 *
 * This is what makes verbatim retention *checkable* rather than merely
 * claimed: `raw.slice(start, end) === criterion.text` must hold for every
 * criterion of every format, so a loader that ever re-serialises its parse
 * tree instead of slicing the source is caught by an assertion rather than by
 * a reader noticing that an em dash turned into a hyphen.
 */
export interface SourceSpan {
  /** 0-based index into `raw`, inclusive. */
  readonly start: number;
  /** 0-based index into `raw`, exclusive. */
  readonly end: number;
}

/**
 * One step of a Gherkin scenario or background.
 *
 * `keyword` is the **trimmed** keyword. The parser hands it over with a
 * trailing space (`"Given "`, `"And "`), and carrying that through would put a
 * stray space into every rendered checklist and every prompt.
 */
export interface SpecStep {
  readonly keyword: 'Given' | 'When' | 'Then' | 'And' | 'But' | '*';
  readonly text: string;
}

/**
 * One acceptance criterion, addressable by `id`.
 *
 * The `id` is the join key that propagates from the spec into the developer
 * prompt, every `Finding`, every test result, the send-back brief, and the PR
 * coverage table. Both spec formats share **one flat `AC-n` sequence** (D-02);
 * there is no separate `SCN-n` namespace and no addressable sub-steps.
 *
 * `kind` is a detail of which format the author chose, not a second identity:
 * the behaviour tester branches on it in its **prompt template**, never in the
 * loader, so one coverage table addresses criteria from both formats without
 * translation.
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
      /** Where `text` came from; `raw.slice(start, end)` reproduces it exactly. */
      readonly source: SourceSpan;
      readonly textHash: string;
    }
  | {
      readonly id: string;
      readonly kind: 'scenario';
      /**
       * The author's original text, verbatim — the source region the scenario
       * occupies, tags and `Examples` table included.
       */
      readonly text: string;
      /** Where `text` came from; `raw.slice(start, end)` reproduces it exactly. */
      readonly source: SourceSpan;
      readonly name: string;
      readonly tags: readonly string[];
      readonly steps: readonly SpecStep[];
      /**
       * A `Scenario Outline` is ONE criterion retaining its `Examples` table
       * verbatim — never expanded per example row. Expansion would multiply
       * the `AC-n` count by the row count and couple criterion IDs to test
       * data, and D-01 makes criterion numbering a one-way door.
       * (Assumption A6, resolved at plan 01-01's gate.)
       *
       * The `steps` keep their `<placeholder>` tokens unexpanded, and this
       * table sits beside them.
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
  /**
   * A Gherkin `Background` — shared preamble belonging to the **document**,
   * never to an individual criterion.
   *
   * `Background` sits in the AST right next to `Scenario`, so treating feature
   * children uniformly turns it into a spurious `AC-1` and shifts every
   * subsequent id by one. Storing it here rather than as a criterion is what
   * keeps that from happening (Pitfall 4).
   */
  readonly background?: { readonly steps: readonly SpecStep[] };
  readonly nonGoals?: readonly string[];
  readonly constraints?: readonly string[];
  readonly contextRefs: readonly ContextRef[];
  /** ALWAYS the verbatim source. */
  readonly raw: string;
  /** `sha256Hex(raw)` — identity and change detection. */
  readonly specHash: string;
}
