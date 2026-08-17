import * as z from 'zod';
import { sha256Hex } from '../hash.js';
import { CriterionRefSchema } from './criterion-ref.js';

/**
 * How badly a finding blocks. `blocker` and `major` are what a `send_back`
 * is made of; `minor` and `nit` travel on `warn` verdicts too.
 */
export const SeveritySchema = z.enum(['blocker', 'major', 'minor', 'nit']).meta({
  id: 'Severity',
  description: 'How badly a finding blocks',
});

export type Severity = z.infer<typeof SeveritySchema>;

/**
 * Where in the workspace a finding points.
 *
 * `path` is **workspace-relative** — never a host path. Plan 01-07 adds the
 * shared path guard (rejecting absolute paths, `..` segments, drive letters,
 * UNC prefixes, and NUL bytes) and this schema adopts it there; until then the
 * field is documented as relative and no fixture carries a host path
 * (threat T-1-02).
 */
export const FindingLocationSchema = z
  .strictObject({
    path: z.string().min(1),
    line: z.int().positive().optional(),
    endLine: z.int().positive().optional(),
  })
  .meta({
    id: 'FindingLocation',
    description: 'A workspace-relative path and optional line range',
  });

export type FindingLocation = z.infer<typeof FindingLocationSchema>;

/**
 * One thing a gate found wrong.
 *
 * `criterionRef` is **required** (D-03, CORE-04). A gate with a complaint that
 * is not about an acceptance criterion says so explicitly with
 * `{ kind: 'global', category }` rather than omitting the field — which is
 * what lets the PR coverage table answer "was every acceptance criterion
 * actually verified?" honestly.
 *
 * Every constraint here is structural, so it survives `z.toJSONSchema()`
 * emission intact (Pattern 1, threat T-1-06).
 */
export const FindingSchema = z
  .strictObject({
    /** sha256 hex from {@link fingerprintFinding} — the stall-detection key. */
    fingerprint: z.string().length(64),
    severity: SeveritySchema,
    title: z.string().min(1),
    detail: z.string(),
    criterionRef: CriterionRefSchema,
    location: FindingLocationSchema.optional(),
    suggestedAction: z.string().optional(),
  })
  .meta({
    id: 'Finding',
    description: 'One thing a gate found wrong, always tied to a criterion or a global category',
  });

export type Finding = z.infer<typeof FindingSchema>;

/**
 * The inputs the fingerprint is computed over. Deliberately narrower than
 * `Finding`, because the fingerprint has to exist *before* the `Finding` can be
 * constructed — the schema requires it.
 */
export interface FingerprintInput {
  /** The stage that raised it. Two gates raising the same words are two findings. */
  readonly stageId: string;
  readonly title: string;
  readonly location?: { readonly path?: string } | undefined;
}

/** Matches a trailing `(line 42)` / `(lines 42-47)` / `(at line 42)` suffix. */
const TRAILING_LINE_REF = /\s*\((?:at\s+)?lines?\s+\d+(?:\s*[-–—]\s*\d+)?\)$/;

/**
 * Normalise a finding title for fingerprinting.
 *
 * NFKC → lowercase → collapse whitespace → strip a trailing parenthesised line
 * reference. Line numbers are excluded from the fingerprint entirely because
 * code moves: "line 42 is unvalidated" and "line 47 is unvalidated" are the
 * same finding one commit apart (01-CONTEXT.md § Claude's Discretion).
 *
 * Code identifiers inside the title are deliberately **preserved** — "`foo` is
 * unvalidated" and "`bar` is unvalidated" are different findings.
 *
 * The strength of this normalisation is the one genuinely unsettled parameter
 * in the fingerprint design (01-RESEARCH.md § Open Questions 1). Too strict and
 * stall detection never fires; too loose and it fires falsely. Phase 6 tunes it
 * against the fixture corpus plan 01-04 ships, not against intuition.
 */
export function normaliseTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TRAILING_LINE_REF, '')
    .trim();
}

/**
 * `sha256(stageId + NUL + normalise(title) + NUL + (location?.path ?? ''))`.
 *
 * The NUL separators are not decoration: without them, a stage id ending in
 * the same characters a title begins with could collide across the field
 * boundary. NUL cannot appear in any of the three inputs, so the encoding is
 * unambiguous.
 *
 * This is LOOP-06's stall-detection key — two rounds producing the same
 * fingerprint means the developer did not move the gate.
 */
export function fingerprintFinding(input: FingerprintInput): string {
  const path = input.location?.path ?? '';
  const NUL = '\u0000';
  return sha256Hex([input.stageId, normaliseTitle(input.title), path].join(NUL));
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = Object.freeze({
  blocker: 0,
  major: 1,
  minor: 2,
  nit: 3,
});

/**
 * Order findings blocker → major → minor → nit, breaking ties by `fingerprint`
 * ascending.
 *
 * The tiebreak is the point. Without it, equal-severity findings come out in
 * whatever order the gate happened to emit them, so the send-back brief and
 * the PR comment churn between rounds that found the same things. With it,
 * sorting the same set twice is byte-identical.
 *
 * Returns a new array; the input is not mutated.
 */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0;
  });
}
