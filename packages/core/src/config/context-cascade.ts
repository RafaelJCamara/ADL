import { RepoRelativePathSchema, type RepoRelativePath } from './path-guard.js';

/**
 * The context-file cascade (SPEC-05) — which repo files feed every agent
 * prompt when the maintainer has not named any explicitly.
 *
 * This module is pure. `@adl/core` reads no filesystem — the directory
 * probe belongs to the caller (Phase 2's workspace layer), injected here as
 * a predicate. 01-RESEARCH.md § Architectural Responsibility Map: core owns
 * the ordered candidate list and the pure picker; the caller owns the
 * existence check.
 */

/**
 * The exact four filenames SPEC-05 names, in SPEC-05's order — quoted
 * verbatim from `.planning/REQUIREMENTS.md` § Feature Intake and
 * 01-RESEARCH.md § Assumptions Log A8.
 *
 * Exported as one frozen constant so no caller can reorder it locally: the
 * order is part of the contract, not an implementation detail a call site
 * is free to re-derive.
 */
export const CONTEXT_FILE_CASCADE = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  'README.md',
] as const satisfies readonly RepoRelativePath[]);

export type ContextCascadeFile = (typeof CONTEXT_FILE_CASCADE)[number];

/**
 * Return the first candidate the injected predicate reports present, or
 * `undefined` when none are.
 *
 * Pure and stateless: `exists` is called in order and the search stops at
 * the first present candidate — asserted by counting invocations, so a
 * future rewrite that probes every candidate before choosing does not
 * silently start doing four filesystem calls where one was needed. Because
 * nothing here is mutated, repeated or interleaved calls with the same
 * predicate results always return the same candidate — there is no shared
 * state for concurrent callers to race on.
 */
export function pickFirstPresent<T>(
  candidates: readonly T[],
  exists: (candidate: T) => boolean,
): T | undefined {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** The subset of `adl.yml`'s `context` config this resolver reads. */
export interface ContextFilesConfig {
  readonly files?: readonly RepoRelativePath[] | undefined;
}

/**
 * Resolve which repo-relative files feed the agent prompts.
 *
 * An explicit, non-empty `config.files` is returned unchanged — the
 * fallback applies only when nothing is declared, never as a supplement to
 * an explicit list. When `config.files` is absent or empty, the cascade
 * applies via {@link pickFirstPresent} over {@link CONTEXT_FILE_CASCADE},
 * returning at most one file (the first one present) rather than every
 * present candidate — the cascade names a priority order, not a merge.
 *
 * Every returned path is a validated {@link RepoRelativePathSchema} value,
 * whether it came from the explicit list (already validated by
 * `AdlYmlSchema`) or from the cascade (validated here, defensively, since
 * the cascade is a compile-time literal but this function's contract does
 * not otherwise depend on that).
 */
export function resolveContextFiles(
  config: ContextFilesConfig,
  exists: (candidate: ContextCascadeFile) => boolean,
): readonly RepoRelativePath[] {
  if (config.files !== undefined && config.files.length > 0) {
    return config.files;
  }

  const picked = pickFirstPresent(CONTEXT_FILE_CASCADE, exists);
  if (picked === undefined) return [];

  return [RepoRelativePathSchema.parse(picked)];
}
