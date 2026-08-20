/**
 * Where a transcript file lives (`ARCHITECTURE.md` §4, §9) — and the one rule
 * that governs it: the path is a pure function of a **resolved** attempt
 * address, and nothing else.
 *
 * `04-RESEARCH.md`'s security section names building a filesystem path from
 * an untrusted route parameter as the traversal risk this phase carries
 * (T-4-18). `transcriptPathFor` closes that door at the type level rather
 * than the review level: it accepts `TranscriptAddress` — the shape
 * `bookkeeping/attempt.ts`'s `findAttempt` returns, built entirely from
 * database columns — and not a bare string. A caller that has not resolved
 * an id through the database has no way to construct one of these; the
 * compiler enforces what `findAttempt`'s own docblock states in words.
 *
 * ── Validate, then apply the containment guard as a backstop ───────────────
 *
 * Every address component is checked before it becomes a path segment: a
 * path separator, a `.`/`..` segment, a drive-letter or UNC-style prefix, or
 * a NUL byte is a **refusal**, never a silent rewrite. Sanitising instead of
 * refusing would let two distinct ids collapse onto one path — a worse
 * failure than an error, since it would splice two features' transcripts
 * together.
 *
 * The containment check that follows reuses `@adl/workspace`'s
 * `resolveWithinRoot` rather than a second implementation of the same rule
 * (`packages/workspace/src/paths.ts` is exported on the barrel precisely so a
 * second enforcement is observed to be identical rather than argued to be).
 * This module deliberately uses the **lexical** half
 * (`resolveWithinRoot`/`isWithinRoot`), not `assertWithinRoot`'s realpath
 * walk: `assertWithinRoot` requires the root to already exist on disk, and a
 * transcript's path is computed *before* `openTranscriptWriter` creates the
 * directory chain underneath it (Task 2) — a builder that could only run
 * after its own output directory exists would not be a pure function of an
 * address. The lexical guard needs no filesystem access and is exactly as
 * strong against the traversal this threat register entry names, because
 * every component reaching it has already been proven free of `..` segments
 * and separators.
 */
import { dirname, join } from 'node:path';
import { resolveWithinRoot } from '@adl/workspace';
import type { AttemptAddress } from '../bookkeeping/attempt.js';

/** The extension every transcript file carries (`ARCHITECTURE.md` §4). */
export const TRANSCRIPT_EXTENSION = '.ndjson';

/**
 * The address `transcriptPathFor` accepts.
 *
 * Deliberately an alias for `AttemptAddress` (`bookkeeping/attempt.ts`),
 * not a new shape: the whole point is that the only way to obtain one is
 * `findAttempt`'s DB-backed resolution. Re-exported under this module's own
 * name so a caller of `store/transcript-path.js` — the worker writing a
 * transcript, or the HTTP route reading one (04-08) — does not need to
 * reach into `bookkeeping/` to know what it is handing this function.
 */
export type TranscriptAddress = AttemptAddress;

/** The address components validated as path segments. `stageIndex` addresses nothing on disk (`ARCHITECTURE.md` §4 keys the path off `stageId`, not the index). */
type TranscriptPathComponent = 'featureId' | 'roundId' | 'stageId';

/**
 * Thrown by {@link transcriptPathFor} when an address component cannot
 * become a path segment. Named and structured — `component` and `value` are
 * readable programmatically, not only through the message — so a caller can
 * distinguish "this id is hostile" from any other failure.
 */
export class TranscriptAddressError extends Error {
  readonly component: TranscriptPathComponent | 'attempt';
  readonly value: string | number;

  constructor(
    component: TranscriptPathComponent | 'attempt',
    value: string | number,
    reason: string,
  ) {
    super(
      `transcript address component "${component}" (${JSON.stringify(value)}) ${reason}`,
    );
    this.name = 'TranscriptAddressError';
    this.component = component;
    this.value = value;
  }
}

/** Either separator, checked as a raw substring test — the value has not been normalised to the host separator yet and must not be assumed to be. */
const PATH_SEPARATOR_PATTERN = /[/\\]/;

/** A Windows drive-letter prefix (`C:`), which carries no `/`/`\` of its own and so slips past {@link PATH_SEPARATOR_PATTERN}. */
const DRIVE_LETTER_PATTERN = /^[A-Za-z]:/;

/**
 * Reject, never sanitise. Every check below is a named refusal — see the
 * module docblock.
 */
function assertValidPathComponent(
  component: TranscriptPathComponent,
  value: string,
): void {
  if (value.length === 0) {
    throw new TranscriptAddressError(component, value, 'is empty');
  }
  if (value.includes('\0')) {
    throw new TranscriptAddressError(component, value, 'contains a NUL byte');
  }
  if (value === '.' || value === '..') {
    throw new TranscriptAddressError(
      component,
      value,
      'is a current- or parent-directory reference',
    );
  }
  if (PATH_SEPARATOR_PATTERN.test(value)) {
    throw new TranscriptAddressError(
      component,
      value,
      'contains a path separator',
    );
  }
  if (DRIVE_LETTER_PATTERN.test(value)) {
    throw new TranscriptAddressError(
      component,
      value,
      'carries a drive-letter prefix',
    );
  }
}

/** `attempt` is a filename stem, not a path segment string, but the same "refuse a hostile value" discipline applies to it. */
function assertValidAttempt(attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TranscriptAddressError(
      'attempt',
      attempt,
      'must be a positive integer',
    );
  }
}

/**
 * The path one stage attempt's transcript lives at, under `root`:
 * `<root>/<featureId>/<roundId>/<stageId>/<attempt>.ndjson`
 * (`ARCHITECTURE.md` §4).
 *
 * A pure function of `address`: the same address always produces the same
 * path, and two addresses differing only in `attempt` always produce
 * different paths. `address` must be a resolved {@link TranscriptAddress} —
 * see the module docblock for why a bare string is a type error, not a
 * runtime check.
 */
export function transcriptPathFor(
  root: string,
  address: TranscriptAddress,
): string {
  assertValidPathComponent('featureId', address.featureId);
  assertValidPathComponent('roundId', address.roundId);
  assertValidPathComponent('stageId', address.stageId);
  assertValidAttempt(address.attempt);

  const relative = join(
    address.featureId,
    address.roundId,
    address.stageId,
    `${address.attempt}${TRANSCRIPT_EXTENSION}`,
  );

  // The backstop: every component above is already proven free of `..`
  // segments, separators, and drive-letter prefixes, so this can never
  // actually reject — it is defense in depth against a future change to the
  // checks above, not the primary control (see module docblock).
  return resolveWithinRoot(root, relative);
}

/**
 * The directory every transcript lives under, derived from ADL's existing
 * state directory — the same one the database file lives beside — rather
 * than a new configuration surface.
 *
 * Mirrors `daemon.ts`'s own inline `scratchRoot` derivation
 * (`join(dirname(dbFilePath), 'scratch')`) exactly, but as an **exported**
 * function rather than an inline expression: `scratchRoot` only ever needs
 * computing once, by the manager, at daemon startup. A transcript's root
 * needs computing twice — once by whichever component builds the writer's
 * path and once by whichever serves a read — by two different processes in
 * the general case (`ARCHITECTURE.md` §9's manager/worker split), and two
 * independent derivations of "the same" directory is exactly how a writer
 * and a reader end up looking at different files while both look correct.
 * Publishing the one calculation is what keeps them looking at the same one.
 */
export function logsRootFor(dbFilePath: string): string {
  return join(dirname(dbFilePath), 'logs');
}
