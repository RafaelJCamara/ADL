import { LoadError } from '../errors.js';
import type { SourceFormat } from './types.js';

/**
 * Which spec format a feature folder is written in, decided by **filename
 * only** (D-17).
 *
 * ## What a feature folder is
 *
 * A feature is `features/<id>/` containing exactly one spec entry file plus
 * any number of optional supporting files — mockups, sample payloads, schemas
 * — which become the spec's `contextRefs`. The folder name is both the feature
 * id and the branch suffix. **There is no manifest file** (D-16): the layout
 * is the declaration, so there is nothing to keep in sync and nothing to
 * forget to update.
 *
 * ## Why detection never looks inside the file
 *
 * Content sniffing is refused on principle, not on effort. A spec that sniffs
 * wrong does not fail — it produces a *plausible* parse with silently wrong
 * acceptance criteria, and those criteria then propagate into the developer
 * prompt, every finding, every test result, and every coverage row on the PR.
 * Because criterion ids are positional (D-01), correcting the format later
 * renumbers everything and means re-running every agent prompt to regenerate
 * the joins. Ambiguity is therefore a load error, never a guess.
 *
 * ## Why this takes names rather than a directory
 *
 * The `readdir` belongs to the caller. `@adl/core` is pure and imports no
 * filesystem builtin — the Architectural Responsibility Map assigns reading
 * `features/<id>/*` to Phase 2, and plan 01-03's lint rule enforces it.
 */

/** The ADL structured template's entry file. Exact match, not a suffix match. */
export const SPEC_ENTRY_FILENAME = 'spec.md';

/** The Gherkin entry file's extension. The stem is the author's to choose. */
export const GHERKIN_EXTENSION = '.feature';

/** What {@link detectFormat} concluded from a directory listing. */
export interface DetectedFormat {
  readonly sourceFormat: SourceFormat;
  /** The single file to hand to the matching loader. */
  readonly entryFile: string;
  /**
   * Every other name in the listing, in the order given. These are the
   * supporting files that become `contextRefs`; nothing here is resolved or
   * read by `@adl/core`.
   */
  readonly contextFiles: readonly string[];
}

/**
 * True when `name` is a bare filename — no directory separator of either
 * flavour, and not a relative-path marker.
 *
 * A listing entry carrying a separator means the caller passed paths where
 * names were expected. Treating `features/x/spec.md` as an entry file would
 * make `@adl/core` start reasoning about path shapes, which is precisely the
 * responsibility it does not have.
 */
function isBareName(name: string): boolean {
  return name.length > 0 && !name.includes('/') && !name.includes('\\');
}

function isGherkinEntry(name: string): boolean {
  return (
    isBareName(name) &&
    name.length > GHERKIN_EXTENSION.length &&
    name.endsWith(GHERKIN_EXTENSION)
  );
}

function isTemplateEntry(name: string): boolean {
  return isBareName(name) && name === SPEC_ENTRY_FILENAME;
}

/**
 * Decide which spec format a feature folder's listing declares.
 *
 * Exactly one entry file must be present. Both kinds, two of one kind, or
 * neither is a {@link LoadError} that names what it found — the author has to
 * be told which files are in conflict, or the message is unactionable.
 *
 * @param filenames The folder's directory listing, as bare filenames. Reading
 *   the directory is the caller's job.
 * @throws {LoadError} when the listing does not identify exactly one entry file.
 */
export function detectFormat(filenames: readonly string[]): DetectedFormat {
  const templateEntries = filenames.filter(isTemplateEntry);
  const gherkinEntries = filenames.filter(isGherkinEntry);

  if (templateEntries.length > 0 && gherkinEntries.length > 0) {
    throw new LoadError(
      `feature folder declares two spec formats at once: "${templateEntries.join('", "')}" and "${gherkinEntries.join('", "')}". ` +
        `Exactly one entry file is allowed — either "${SPEC_ENTRY_FILENAME}" or a single "*${GHERKIN_EXTENSION}" file. ` +
        `The format is never guessed from file contents.`,
    );
  }

  if (gherkinEntries.length > 1) {
    throw new LoadError(
      `feature folder contains ${gherkinEntries.length} "*${GHERKIN_EXTENSION}" files: "${gherkinEntries.join('", "')}". ` +
        `Exactly one spec entry file is allowed; two of the same kind is as ambiguous as one of each.`,
    );
  }

  // `spec.md` is an exact match, so more than one is unreachable from a real
  // listing. The branch exists so a caller that passes duplicates gets the
  // same refusal as any other ambiguity rather than a silently arbitrary pick.
  if (templateEntries.length > 1) {
    throw new LoadError(
      `feature folder listing contains "${SPEC_ENTRY_FILENAME}" more than once; exactly one spec entry file is allowed.`,
    );
  }

  const entryFile = templateEntries[0] ?? gherkinEntries[0];
  if (entryFile === undefined) {
    throw new LoadError(
      `feature folder contains no spec entry file: expected "${SPEC_ENTRY_FILENAME}" or a single "*${GHERKIN_EXTENSION}" file, ` +
        `found ${filenames.length === 0 ? 'an empty listing' : `"${filenames.join('", "')}"`}.`,
    );
  }

  return {
    sourceFormat: templateEntries.length === 1 ? 'adl-template' : 'gherkin',
    entryFile,
    contextFiles: filenames.filter((name) => name !== entryFile),
  };
}
