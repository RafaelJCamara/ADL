import { fromMarkdown } from 'mdast-util-from-markdown';
import { LoadError } from '../errors.js';
import { sha256Hex } from '../hash.js';
import { assignCriterionIds, type CriterionBody } from './criterion-ids.js';
import { SPEC_ENTRY_FILENAME } from './detect-format.js';
import type { ContextRef, NormalizedSpec, SourceSpan } from './types.js';

/**
 * The mdast node types, derived from the parser's own return type rather than
 * imported from `mdast`. `@types/mdast` is a transitive dependency, and
 * importing it directly would be a phantom dependency that pnpm's strict
 * `node_modules` is specifically there to catch.
 */
type MdRoot = ReturnType<typeof fromMarkdown>;
type MdNode = MdRoot['children'][number];

/**
 * Hard ceiling on spec size, in UTF-8 bytes, enforced **before** the parser is
 * called (threat T-1-05).
 *
 * A spec is repo-supplied and therefore untrusted: anyone who can write a file
 * into a watched repository can hand ADL this input. One megabyte is far past
 * any spec a human writes and far short of anything that troubles the parser.
 */
export const MAX_SPEC_BYTES = 1_048_576;

/** The two headings D-18 requires. Everything else in the template is optional. */
const HEADING_TITLE = 'Title';
const HEADING_ACCEPTANCE_CRITERIA = 'Acceptance Criteria';
const HEADING_INTENT = 'Intent';
const HEADING_NON_GOALS = 'Non-Goals';
const HEADING_CONSTRAINTS = 'Constraints';
const HEADING_CONTEXT_FILES = 'Context Files';

/**
 * The flattened text of a node — concatenated `value`s of its descendants.
 *
 * Structural rather than type-driven on purpose: it has to work over headings,
 * paragraphs, list items, inline code, links, and emphasis without enumerating
 * the mdast union. It is used only for *matching and labelling*; a criterion's
 * own text always comes from a verbatim source slice, never from here.
 */
function nodeText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  const n = node as { value?: unknown; children?: unknown };
  if (typeof n.value === 'string') return n.value;
  if (Array.isArray(n.children)) return n.children.map(nodeText).join('');
  return '';
}

function isHeading(node: MdNode): node is Extract<MdNode, { type: 'heading' }> {
  return node.type === 'heading';
}

/**
 * The run of top-level siblings after the named heading, terminated by the
 * next heading of depth ≤ that heading's depth (Pattern 5).
 *
 * `fromMarkdown` returns headings and their content as **flat siblings** —
 * mdast does not nest content under headings — which is what makes D-18's
 * headings-only template trivially implementable.
 *
 * Returns `null` when the heading is absent. That is deliberately distinct
 * from returning `[]` for a heading present but empty: those are two different
 * authoring mistakes and they get two different error messages.
 */
function sectionNodes(
  children: readonly MdNode[],
  title: string,
): MdNode[] | null {
  const index = children.findIndex(
    (n) =>
      isHeading(n) && nodeText(n).trim().toLowerCase() === title.toLowerCase(),
  );
  if (index === -1) return null;

  const start = children[index];
  if (start === undefined || !isHeading(start)) return null;
  const depth = start.depth;

  const out: MdNode[] = [];
  for (let j = index + 1; j < children.length; j++) {
    const n = children[j];
    if (n === undefined) continue;
    if (isHeading(n) && n.depth <= depth) break;
    out.push(n);
  }
  return out;
}

/** The exact source region a node occupies. Never a re-serialisation. */
function verbatimSpan(node: MdNode): SourceSpan {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    // Every node produced by `fromMarkdown` over a real string carries a
    // position. If one ever does not, failing loudly beats silently emitting
    // an empty criterion that would then be hashed and cited as if real.
    throw new LoadError(
      'internal: markdown node is missing source position information',
    );
  }
  return { start, end };
}

/** Top-level `listItem` nodes across every list in a section (D-19). */
function topLevelListItems(section: readonly MdNode[]): MdNode[] {
  const items: MdNode[] = [];
  for (const node of section) {
    if (node.type !== 'list') continue;
    for (const item of node.children) items.push(item as MdNode);
  }
  return items;
}

/** Plain-text bullets from an optional section, used for non-goals and constraints. */
function bulletTexts(section: readonly MdNode[] | null): string[] | undefined {
  if (section === null) return undefined;
  const texts = topLevelListItems(section)
    .map((item) => nodeText(item).trim())
    .filter((t) => t.length > 0);
  return texts.length > 0 ? texts : undefined;
}

/**
 * `## Context Files` bullets become {@link ContextRef}s.
 *
 * `path — why it matters` splits on the first em dash or ` - `; a bullet with
 * no separator is a bare path. Nothing here resolves or reads the path —
 * `@adl/core` does not touch the filesystem.
 */
function contextRefs(section: readonly MdNode[] | null): ContextRef[] {
  if (section === null) return [];
  const refs: ContextRef[] = [];
  for (const item of topLevelListItems(section)) {
    const text = nodeText(item).trim();
    if (text.length === 0) continue;
    const match = /^(.*?)(?:\s+[—–]\s+|\s+-\s+)(.*)$/.exec(text);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      refs.push({ path: match[1].trim(), why: match[2].trim() });
    } else {
      refs.push({ path: text });
    }
  }
  return refs;
}

/**
 * Load a feature spec written to ADL's headings-only markdown template
 * (D-18, SPEC-01, CORE-05).
 *
 * Required: a level-1 title heading and a `## Acceptance Criteria` section
 * containing at least one top-level bullet. Optional: `## Intent`,
 * `## Non-Goals`, `## Constraints`, `## Context Files`.
 *
 * Criteria are numbered `AC-1`, `AC-2`, … positionally in document order
 * (D-01), and each criterion's `text` is the **exact source substring** the
 * bullet occupies — never a reconstruction from the AST. Re-serialising mdast
 * loses inline formatting, table pipes, and whitespace, so a `textHash` over a
 * reconstruction would change when the serialiser changed rather than when the
 * author's meaning changed (Pattern 4).
 *
 * Nested bullets are **not** separate criteria: a nested list is a child of its
 * parent `listItem` and therefore sits inside the parent's source range, so
 * indenting elaborates a criterion and outdenting adds one (D-19). This hands
 * the author direct control over granularity.
 *
 * @param raw The verbatim file contents. Reading the file is the caller's job.
 * @param featureId The `features/<id>/` folder name (D-16).
 * @throws {LoadError} on any structural problem — always naming what is wrong.
 */
export function loadAdlTemplateSpec(
  raw: string,
  featureId: string,
): NormalizedSpec {
  if (featureId.trim().length === 0) {
    throw new LoadError('feature id is empty');
  }

  // Cap first, parse second. The point of a DoS guard is to run before the
  // expensive thing does.
  const byteLength = Buffer.byteLength(raw, 'utf8');
  if (byteLength > MAX_SPEC_BYTES) {
    throw new LoadError(
      `spec is ${byteLength} bytes, which exceeds the ${MAX_SPEC_BYTES}-byte limit`,
    );
  }

  if (raw.trim().length === 0) {
    throw new LoadError('spec is empty');
  }

  // D-18 forbids frontmatter, and this is not a style preference: mdast turns a
  // leading `---` block into a `thematicBreak` plus text rather than metadata,
  // which would silently merge what the author meant as two separate regions.
  // Rejecting it loudly beats parsing it wrongly.
  if (/^﻿?---[ \t]*\r?\n/.test(raw)) {
    throw new LoadError(
      'spec begins with a "---" frontmatter block; the ADL template is headings-only and does not support frontmatter',
    );
  }

  const tree = fromMarkdown(raw);
  const children = tree.children;

  const titleHeading = children.find((n) => isHeading(n) && n.depth === 1);
  if (titleHeading === undefined) {
    throw new LoadError(`spec has no "# ${HEADING_TITLE}" heading`);
  }
  const title = nodeText(titleHeading).trim();
  if (title.length === 0) {
    throw new LoadError('spec title heading is empty');
  }

  const criteriaSection = sectionNodes(children, HEADING_ACCEPTANCE_CRITERIA);
  if (criteriaSection === null) {
    throw new LoadError(
      `spec has no "## ${HEADING_ACCEPTANCE_CRITERIA}" heading`,
    );
  }

  const items = topLevelListItems(criteriaSection);
  if (items.length === 0) {
    // Distinct from the missing-heading error above on purpose: "you forgot the
    // section" and "you wrote the section but left it empty" are two different
    // authoring mistakes and deserve two different messages.
    throw new LoadError(
      `"## ${HEADING_ACCEPTANCE_CRITERIA}" contains no list items; a spec cannot enter the loop with zero criteria`,
    );
  }

  const bodies: CriterionBody[] = items.map((item) => {
    const source = verbatimSpan(item);
    return {
      kind: 'statement',
      text: raw.slice(source.start, source.end),
      source,
    };
  });

  // Numbering goes through the shared path rather than being done inline, so
  // the one flat `AC-n` sequence D-02 requires is enforced in a single place
  // for both formats instead of agreed by convention in two.
  const acceptanceCriteria = assignCriterionIds(bodies, SPEC_ENTRY_FILENAME);

  const intentSection = sectionNodes(children, HEADING_INTENT);
  const narrative =
    intentSection !== null && intentSection.length > 0
      ? sectionSlice(raw, intentSection)
      : undefined;

  const nonGoals = bulletTexts(sectionNodes(children, HEADING_NON_GOALS));
  const constraints = bulletTexts(sectionNodes(children, HEADING_CONSTRAINTS));

  return {
    id: featureId,
    title,
    sourceFormat: 'adl-template',
    ...(narrative !== undefined ? { narrative } : {}),
    acceptanceCriteria,
    ...(nonGoals !== undefined ? { nonGoals } : {}),
    ...(constraints !== undefined ? { constraints } : {}),
    contextRefs: contextRefs(sectionNodes(children, HEADING_CONTEXT_FILES)),
    raw,
    specHash: sha256Hex(raw),
  };
}

/** The verbatim source spanning a whole section's nodes. */
function sectionSlice(raw: string, section: readonly MdNode[]): string {
  const first = section[0];
  const last = section[section.length - 1];
  if (first === undefined || last === undefined) return '';
  const start = first.position?.start.offset;
  const end = last.position?.end.offset;
  if (start === undefined || end === undefined) return '';
  return raw.slice(start, end).trim();
}
