import {
  AstBuilder,
  dialects,
  Errors,
  GherkinClassicTokenMatcher,
  Parser,
} from '@cucumber/gherkin';
import type Dialect from '@cucumber/gherkin/dist/Dialect.js';
import { IdGenerator, StepKeywordType } from '@cucumber/messages';
import type { Background, Feature, Scenario, Step } from '@cucumber/messages';

import { LoadError, type SourcePosition } from '../errors.js';
import { sha256Hex } from '../hash.js';
import { assignCriterionIds, type CriterionBody } from './criterion-ids.js';
import { GHERKIN_EXTENSION } from './detect-format.js';
import { MAX_SPEC_BYTES } from './markdown.js';
import type { NormalizedSpec, SourceSpan, SpecStep } from './types.js';

/**
 * Gherkin feature file → {@link NormalizedSpec} (SPEC-02).
 *
 * The organising rule of this module, and the reason most of it exists:
 * **parser success is necessary and never sufficient.** Verified against
 * `@cucumber/gherkin@42.0.1`, an empty file, a whitespace-only file, a
 * comment-only file, a feature with no scenarios, a scenario with no steps, a
 * `Scenario Outline` with no `Examples`, and a step written outside any
 * scenario are all accepted without complaint. A loader that treated acceptance
 * as proof would hand the loop a feature with zero acceptance criteria — and a
 * gate with nothing to check against cannot fail, so it goes green.
 */

/**
 * The steps of one scenario or background, with keywords trimmed.
 *
 * `keyword` comes from `keywordType` rather than from the literal keyword
 * string, because the literal is dialect-specific — a French feature file says
 * `Soit`, not `Given` — while `keywordType` is the semantic classification the
 * parser already computed. The author's literal keyword is never lost: the
 * criterion's verbatim `text` contains it exactly as written.
 */
const KEYWORD_BY_TYPE: Readonly<Record<string, SpecStep['keyword']>> = {
  [StepKeywordType.CONTEXT]: 'Given',
  [StepKeywordType.ACTION]: 'When',
  [StepKeywordType.OUTCOME]: 'Then',
  [StepKeywordType.CONJUNCTION]: 'And',
  [StepKeywordType.UNKNOWN]: '*',
};

/** The English literals, used to keep `And`/`But` distinct — both are CONJUNCTION. */
const LITERAL_KEYWORDS = new Set<SpecStep['keyword']>([
  'Given',
  'When',
  'Then',
  'And',
  'But',
  '*',
]);

function toSpecStep(step: Step): SpecStep {
  // The literal wins when it is one we model, so `But` survives as `But`
  // instead of collapsing into `And`. `keywordType` is the fallback that keeps
  // non-English dialects working.
  const literal = step.keyword.trim() as SpecStep['keyword'];
  if (LITERAL_KEYWORDS.has(literal))
    return { keyword: literal, text: step.text };
  const byType =
    step.keywordType === undefined
      ? undefined
      : KEYWORD_BY_TYPE[step.keywordType];
  return { keyword: byType ?? '*', text: step.text };
}

/**
 * Every scenario in the document, in document order, `Rule`-nested ones
 * included and `Background` excluded (Pattern 3).
 *
 * Both halves matter and both are easy to get wrong, because the AST is shaped
 * for round-tripping rather than for consumption. `FeatureChild` is a three-way
 * optional `{ rule?, background?, scenario? }`, so:
 *
 * - a naive `feature.children.map(c => c.scenario)` silently drops every
 *   `Rule`-scoped scenario, losing criteria the author wrote; and
 * - treating every child uniformly turns a `Background` into a spurious `AC-1`
 *   and shifts every subsequent id by one, which D-01 says means re-running
 *   every agent prompt.
 */
export function collectScenarios(feature: Feature): Scenario[] {
  const out: Scenario[] = [];
  for (const child of feature.children) {
    if (child.scenario) out.push(child.scenario);
    if (child.rule) {
      for (const ruleChild of child.rule.children) {
        if (ruleChild.scenario) out.push(ruleChild.scenario);
      }
    }
    // `child.background` is deliberately not a criterion — shared preamble.
  }
  return out;
}

/**
 * Whether a scenario is a `Scenario Outline`.
 *
 * There is no distinct node type for one: verified, a `Scenario` and a
 * `Scenario Outline` both arrive as `FeatureChild.scenario` and differ only in
 * `keyword`. Code that assumes a separate type handles outlines as plain
 * scenarios and drops the `Examples` table — losing the parameterisation that
 * was the author's whole reason for using an outline.
 *
 * The keyword is trimmed before comparison. Step keywords carry a trailing
 * space (`"Given "`), and reading any keyword untrimmed is a verified trap.
 */
export function isOutline(scenario: Scenario): boolean {
  const keyword = scenario.keyword.trim();
  return (
    keyword === 'Scenario Outline' ||
    keyword === 'Scenario Template' ||
    scenario.examples.length > 0
  );
}

/** Backgrounds anywhere in the document, in document order. */
function collectBackgrounds(feature: Feature): Background[] {
  const out: Background[] = [];
  for (const child of feature.children) {
    if (child.background) out.push(child.background);
    if (child.rule) {
      for (const ruleChild of child.rule.children) {
        if (ruleChild.background) out.push(ruleChild.background);
      }
    }
  }
  return out;
}

/**
 * A Gherkin `Location` as a {@link SourcePosition}. `column` is optional on the
 * upstream type, though every location this parser actually emits carries one;
 * an absent column is treated as the start of the line.
 */
function toPosition(location: {
  readonly line: number;
  readonly column?: number;
}): SourcePosition {
  return { line: location.line, column: location.column ?? 1 };
}

/** Offsets of every line start in `raw`, so a (line, column) becomes an index. */
function lineStartOffsets(raw: string): number[] {
  const starts = [0];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/**
 * A Gherkin `Location` as an index into `raw`.
 *
 * Gherkin locations are 1-based line and column and carry **no offset**, unlike
 * mdast positions — so unlike the markdown loader, this one has to compute the
 * index itself. Line starts are found by scanning for `\n`, which is correct
 * under both LF and CRLF (verified): a `\r` sits at the end of the preceding
 * line, so it never shifts the next line's start.
 */
function toOffset(
  lineStarts: readonly number[],
  line: number,
  column: number | undefined,
): number {
  const start = lineStarts[line - 1];
  if (start === undefined) {
    throw new LoadError(`internal: line ${line} is outside the source`);
  }
  // A `Location` without a column (verified: the type declares it optional,
  // though every location this parser actually emits carries one) means "the
  // start of the line" — column 1 is the identity element for this arithmetic.
  return start + ((column ?? 1) - 1);
}

interface Located {
  readonly location: { readonly line: number; readonly column?: number };
  readonly tags?: readonly {
    readonly location: { readonly line: number; readonly column?: number };
  }[];
}

/**
 * Where a block begins in the source — at its first tag line when it has tags,
 * otherwise at its keyword.
 *
 * Tags are part of what the author wrote about that scenario, so they belong
 * inside its verbatim text rather than trailing the previous scenario.
 */
function blockStart(lineStarts: readonly number[], node: Located): number {
  const own = toOffset(lineStarts, node.location.line, node.location.column);
  const firstTag = node.tags?.[0];
  if (firstTag === undefined) return own;
  return Math.min(
    own,
    toOffset(lineStarts, firstTag.location.line, firstTag.location.column),
  );
}

/**
 * Every structural block boundary in the document, ascending.
 *
 * A scenario's verbatim region runs from its own start to the next boundary,
 * because Gherkin locations mark only where things *begin*. Deriving the end
 * from the next sibling keeps everything the author wrote between them —
 * steps, docstrings, data tables, and an outline's `Examples` — inside the
 * criterion, which is exactly what CORE-05 asks for.
 */
function blockBoundaries(
  feature: Feature,
  lineStarts: readonly number[],
): number[] {
  const offsets: number[] = [];
  for (const child of feature.children) {
    if (child.background)
      offsets.push(blockStart(lineStarts, child.background));
    if (child.scenario) offsets.push(blockStart(lineStarts, child.scenario));
    if (child.rule) {
      offsets.push(blockStart(lineStarts, child.rule));
      for (const ruleChild of child.rule.children) {
        if (ruleChild.background)
          offsets.push(blockStart(lineStarts, ruleChild.background));
        if (ruleChild.scenario)
          offsets.push(blockStart(lineStarts, ruleChild.scenario));
      }
    }
  }
  return offsets.sort((a, b) => a - b);
}

/** The verbatim region a scenario occupies, trailing whitespace trimmed off. */
function scenarioSpan(
  raw: string,
  lineStarts: readonly number[],
  boundaries: readonly number[],
  scenario: Scenario,
): SourceSpan {
  const start = blockStart(lineStarts, scenario);
  const next = boundaries.find((offset) => offset > start);
  const rawEnd = next ?? raw.length;
  const trimmed = raw.slice(start, rawEnd).replace(/\s+$/, '');
  return { start, end: start + trimmed.length };
}

/**
 * The step keywords of a dialect, each carrying its trailing space
 * (`"Given "`, `"* "`), so a prefix test cannot match `Givenchy`.
 */
function stepKeywordsFor(language: string): readonly string[] {
  const table = dialects as Readonly<Record<string, Dialect>>;
  const source = table[language] ?? table['en'];
  if (source === undefined)
    return ['Given ', 'When ', 'Then ', 'And ', 'But ', '* '];
  return [
    ...source.given,
    ...source.when,
    ...source.then,
    ...source.and,
    ...source.but,
  ];
}

/**
 * Count the lines in `raw` that begin a step, skipping docstring bodies.
 *
 * The docstring exclusion is not defensive padding — a docstring can contain
 * any text at all, including a line reading exactly `Given something`, and
 * counting it would make a perfectly valid feature file fail to load.
 */
function countSourceStepLines(
  raw: string,
  keywords: readonly string[],
): number {
  let count = 0;
  let docStringDelimiter: string | undefined;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();

    if (docStringDelimiter !== undefined) {
      if (trimmed.startsWith(docStringDelimiter))
        docStringDelimiter = undefined;
      continue;
    }
    if (trimmed.startsWith('"""')) {
      docStringDelimiter = '"""';
      continue;
    }
    if (trimmed.startsWith('```')) {
      docStringDelimiter = '```';
      continue;
    }
    if (keywords.some((keyword) => trimmed.startsWith(keyword))) count++;
  }

  return count;
}

/** The `Examples` table of an outline, headers and body rows verbatim. */
function examplesTable(
  scenario: Scenario,
  label: string,
): { headers: string[]; rows: string[][] } {
  let headers: string[] | undefined;
  const rows: string[][] = [];

  for (const block of scenario.examples) {
    const header = block.tableHeader;
    if (header === undefined) {
      throw new LoadError(
        `"${label}": the Examples table of "${scenario.name}" has no header row, so its values cannot be read.`,
        toPosition(block.location),
      );
    }
    const blockHeaders = header.cells.map((cell) => cell.value);
    if (headers === undefined) {
      headers = blockHeaders;
    } else if (
      headers.length !== blockHeaders.length ||
      headers.some((name, i) => name !== blockHeaders[i])
    ) {
      // Refusing beats silently keeping one table and dropping the other: a
      // dropped Examples block is parameterisation the author wrote and nothing
      // downstream would know had ever existed.
      throw new LoadError(
        `"${label}": the Scenario Outline "${scenario.name}" has Examples tables with different columns ` +
          `(${headers.join(', ')} vs ${blockHeaders.join(', ')}); split it into separate outlines so every row has the same shape.`,
        toPosition(block.location),
      );
    }
    for (const row of block.tableBody)
      rows.push(row.cells.map((cell) => cell.value));
  }

  return { headers: headers ?? [], rows };
}

/**
 * Parse a Gherkin feature file into the same normalized shape an ADL template
 * spec produces (SPEC-02, CORE-05, D-02).
 *
 * @param raw The verbatim file contents. Reading the file is the caller's job.
 * @param featureId The `features/<id>/` folder name (D-16).
 * @param entryFile The feature file's name, so errors can name the author's file.
 * @throws {LoadError} on any structural problem, always naming what is wrong.
 */
export function loadGherkinSpec(
  raw: string,
  featureId: string,
  entryFile?: string,
): NormalizedSpec {
  const label = entryFile ?? `features/${featureId}/*${GHERKIN_EXTENSION}`;

  if (featureId.trim().length === 0) {
    throw new LoadError('feature id is empty');
  }

  // Cap first, parse second (threat T-1-05). A DoS guard that runs after the
  // expensive thing is not a guard. Measured in UTF-8 bytes, because `.length`
  // counts UTF-16 code units and would let a multi-byte spec through at
  // roughly three times the intended ceiling.
  const byteLength = Buffer.byteLength(raw, 'utf8');
  if (byteLength > MAX_SPEC_BYTES) {
    throw new LoadError(
      `"${label}" is ${byteLength} bytes, which exceeds the ${MAX_SPEC_BYTES}-byte limit`,
    );
  }

  const parser = new Parser(
    // Incrementing, never uuid(): verified that a random generator makes two
    // parses of identical source produce different trees, which breaks every
    // hash over the result and every repeat-parse assertion.
    new AstBuilder(IdGenerator.incrementing()),
    new GherkinClassicTokenMatcher(),
  );

  let doc;
  try {
    doc = parser.parse(raw);
  } catch (error) {
    if (error instanceof Errors.CompositeParserException) {
      // `.errors` is typed as `Error[]`, but every element the parser actually
      // puts there is a `GherkinException` carrying `.location` — verified by
      // execution. `instanceof` narrows honestly rather than casting blind.
      const first = error.errors[0];
      const position =
        first instanceof Errors.GherkinException
          ? toPosition(first.location)
          : undefined;
      throw new LoadError(
        `"${label}" could not be parsed:\n${error.errors.map((e) => e.message).join('\n')}`,
        position,
      );
    }
    throw error;
  }

  // Everything below this line exists because the parser said yes.
  const feature = doc.feature;
  if (feature === undefined) {
    // Three different authoring mistakes reach this branch, and they get three
    // different messages. "No Feature declared" is true of an empty file, but
    // it is not what the author needs to hear about one — and a message that
    // covers every case equally well guides nobody to the fix.
    if (raw.length === 0) {
      throw new LoadError(
        `"${label}" is empty; a Gherkin spec needs a "Feature:" line.`,
      );
    }
    if (raw.trim().length === 0) {
      throw new LoadError(
        `"${label}" contains only whitespace; a Gherkin spec needs a "Feature:" line.`,
      );
    }
    throw new LoadError(
      `"${label}" declares no Feature${
        doc.comments.length > 0 ? ' — only comments were found' : ''
      }; a Gherkin spec needs a "Feature:" line and at least one scenario.`,
    );
  }

  const scenarios = collectScenarios(feature);
  if (scenarios.length === 0) {
    throw new LoadError(
      `"${label}" declares zero scenarios, so it has no acceptance criteria; a spec cannot enter the loop with nothing to check against.`,
      toPosition(feature.location),
    );
  }

  for (const scenario of scenarios) {
    if (scenario.steps.length === 0) {
      throw new LoadError(
        `"${label}": the scenario "${scenario.name}" has no steps, so there is nothing for a gate to check.`,
        toPosition(scenario.location),
      );
    }
    if (isOutline(scenario) && scenario.examples.length === 0) {
      throw new LoadError(
        `"${label}": the Scenario Outline "${scenario.name}" has no Examples table, so its placeholders have no values.`,
        toPosition(scenario.location),
      );
    }
  }

  const backgrounds = collectBackgrounds(feature);

  // Step-count reconciliation (Pitfall 3). A step written at feature level,
  // outside any scenario — a common mistake when reorganising a file — parses
  // successfully and is then discarded with no error anywhere. The file still
  // loads, the criterion count silently drops, and no gate can detect the
  // omission because nothing downstream knows the step was ever written.
  const reachableSteps =
    scenarios.reduce((sum, s) => sum + s.steps.length, 0) +
    backgrounds.reduce((sum, b) => sum + b.steps.length, 0);
  const sourceSteps = countSourceStepLines(
    raw,
    stepKeywordsFor(feature.language),
  );
  if (sourceSteps !== reachableSteps) {
    throw new LoadError(
      `"${label}" contains ${sourceSteps} step lines but only ${reachableSteps} are inside a scenario or background. ` +
        `A step written outside any scenario is discarded by the parser, so it is refused here instead of being silently lost. ` +
        `Move the stray step under a "Scenario:" — or, if a line of prose merely begins with a step keyword, rephrase it.`,
      toPosition(feature.location),
    );
  }

  const lineStarts = lineStartOffsets(raw);
  const boundaries = blockBoundaries(feature, lineStarts);

  const bodies: CriterionBody[] = scenarios.map((scenario) => {
    const source = scenarioSpan(raw, lineStarts, boundaries, scenario);
    const examples = isOutline(scenario)
      ? examplesTable(scenario, label)
      : undefined;
    return {
      kind: 'scenario',
      // Verbatim, sliced from the source — never rebuilt from the tree, so an
      // outline's placeholders, docstrings, and table pipes survive exactly.
      text: raw.slice(source.start, source.end),
      source,
      name: scenario.name,
      tags: scenario.tags.map((tag) => tag.name),
      steps: scenario.steps.map(toSpecStep),
      ...(examples !== undefined ? { examples } : {}),
    };
  });

  // The shared path, so Gherkin and template criteria share one flat sequence.
  const acceptanceCriteria = assignCriterionIds(bodies, label);

  // Backgrounds are flattened into one document-level preamble in document
  // order. A Rule may declare its own Background, and `NormalizedSpec` models
  // one; keeping the steps together preserves every word the author wrote,
  // which matters more here than modelling the narrower scope, since a
  // background is context for the prompt and never a criterion.
  const backgroundSteps = backgrounds.flatMap((b) => b.steps.map(toSpecStep));
  const description = feature.description.trim();

  return {
    id: featureId,
    title: feature.name,
    sourceFormat: 'gherkin',
    ...(description.length > 0 ? { narrative: description } : {}),
    acceptanceCriteria,
    ...(backgroundSteps.length > 0
      ? { background: { steps: backgroundSteps } }
      : {}),
    contextRefs: [],
    raw,
    specHash: sha256Hex(raw),
  };
}
