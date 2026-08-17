import {
  parseDocument,
  type DocumentOptions,
  type ParseOptions,
  type SchemaOptions,
} from 'yaml';

import { LoadError, type SourcePosition } from '../errors.js';

/**
 * The single place in this repository where YAML is parsed.
 *
 * Two properties make that singularity worth enforcing.
 *
 * **Positions.** The parse goes through the document-level API
 * (`parseDocument`) rather than the convenience `parse()`, because a document
 * collects its errors with line and column attached instead of throwing the
 * first one bare (C-8). `adl.yml` errors are shown to the person who wrote the
 * file; "invalid YAML" with no position is a support ticket.
 *
 * **Defences.** Every option below is pinned explicitly with the attack its
 * value prevents named beside it. 01-RESEARCH.md § Security Domain is blunt
 * that these are library *defaults*, not guarantees: someone later adding
 * `{ merge: true }` or a custom schema to make an anchor work would silently
 * re-open a hole and nothing would fail. Writing them out makes that a visible
 * edit to a commented block, and `test/config/yaml-security.test.ts` then
 * fails on it. `adl.yml` is untrusted input under D-22's trust boundary, so
 * this is a security boundary and not a parsing convenience.
 *
 * The source is taken as a string. Reading the file — and capping its size
 * before it gets here — is the caller's job; `@adl/core` performs no I/O.
 */

/**
 * Pinned parse, document, and schema options.
 *
 * - `version: '1.2'` — the YAML 1.2 core schema. 1.1 enables merge keys and
 *   the Norway problem (`no` parsing as `false`); neither belongs in a config
 *   file whose whole premise is that nothing is implicit.
 * - `schema: 'core'` — the standard tag set only. A custom schema is how a
 *   parser grows the ability to construct arbitrary objects from tags, which
 *   is deserialization-to-execution. Unknown tags resolve inert instead.
 * - `merge: false` — a merge key (`<<`) stays a literal key rather than
 *   splicing an anchored map's fields in. Merge-key abuse is how a document
 *   injects fields that are not visible at the place they take effect; as a
 *   literal key, `<<` is instead an unrecognised key that every strict schema
 *   in this package rejects loudly.
 * - `uniqueKeys: true` — a duplicate mapping key is an error rather than
 *   last-wins. Last-wins is how a maintainer ends up with a setting they
 *   believe is in effect and is not.
 * - `prettyErrors: true` — errors carry `linePos` and a source excerpt, which
 *   is the entire reason for using the document API.
 */
const YAML_OPTIONS: ParseOptions & DocumentOptions & SchemaOptions = {
  version: '1.2',
  schema: 'core',
  merge: false,
  uniqueKeys: true,
  prettyErrors: true,
};

/**
 * The alias-expansion budget, enforced when the document is converted to plain
 * JavaScript values.
 *
 * An alias bomb ("billion laughs") is a small document whose aliases expand
 * geometrically — seven lines can describe a structure with millions of nodes.
 * The limit is a resource-exhaustion defence, and it fires at `toJS()` rather
 * than at parse time, which is why the conversion below sits inside the same
 * guarded block as the parse. 100 is the library default, restated here so
 * that raising it is a deliberate, reviewable act.
 */
const MAX_ALIAS_COUNT = 100;

/** Convert a `yaml` error's position, when it has one, into ADL's shape. */
function toSourcePosition(error: {
  linePos?: readonly [{ line: number; col: number }, ...unknown[]] | undefined;
  pos?: readonly [number, number] | undefined;
}): SourcePosition | undefined {
  const start = error.linePos?.[0];
  if (!start) return undefined;
  const offset = error.pos?.[0];
  return offset === undefined
    ? { line: start.line, column: start.col }
    : { line: start.line, column: start.col, offset };
}

/**
 * Parse a YAML source string into plain JavaScript values.
 *
 * Returns `null` for an empty source — an empty `adl.yml` is a *schema* error
 * naming the keys it is missing, not a parse error, and keeping the two apart
 * is what makes the message useful.
 *
 * @throws {LoadError} when the source is syntactically invalid, contains a
 * duplicate key, contains more than one document, or exceeds the alias budget.
 * The error carries the first reported position when the parser supplied one.
 */
export function parseYamlDocument(source: string): unknown {
  const doc = parseDocument(source, YAML_OPTIONS);

  const [firstError] = doc.errors;
  if (firstError) {
    throw new LoadError(firstError.message, toSourcePosition(firstError));
  }

  try {
    return doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT }) as unknown;
  } catch (error) {
    // The alias-count limit surfaces here, as a bare `ReferenceError`, because
    // expansion only happens on conversion. Anything else thrown by `toJS` is
    // equally a statement about the author's file rather than about ADL, so it
    // travels the same channel.
    throw new LoadError(error instanceof Error ? error.message : String(error));
  }
}
