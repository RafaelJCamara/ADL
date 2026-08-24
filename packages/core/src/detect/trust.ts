/**
 * The trusted-path filter (SPEC-06, M05 step 5.3) — deciding whether a
 * feature folder ADL is about to enqueue actually came from somewhere ADL
 * should act on unattended.
 *
 * Three checks, in order: the ref is the default branch; it is not a fork,
 * or forks are explicitly opted in; and whoever authored the most recent
 * commit touching the folder has write access. Reject before anything is
 * enqueued — this predicate runs on 5.2's output, before a `features` row
 * ever exists (AC5).
 *
 * Pure, matching `scan.ts`'s and `undeveloped.ts`'s own split: the caller
 * resolves the branch/fork facts and the author's permission — the last one
 * through `ForgeAdapter.authorPermission` — and hands in a plain object. See
 * `packages/manager/src/detect/trust.ts` for the I/O half.
 *
 * M05's own call site always passes `ref === defaultBranch` and
 * `isFork: false`: `@adl/core/detect`'s scanner (5.1) only ever reads the
 * default branch's committed tree, so there is no live path through M05
 * that could produce anything else. Those two fields exist so this same
 * predicate serves M10's webhook-triggered PR detection without a second,
 * narrower one being invented then — DETECT-01 and SPEC-06 name one
 * predicate, not one per detection surface.
 */
import type { CollaboratorPermission } from '../forge/forge.js';

export const UNTRUSTED_REASONS = Object.freeze([
  'non-default-branch',
  'fork',
  'unresolvable-author',
  'insufficient-permission',
] as const);

export type UntrustedReason = (typeof UNTRUSTED_REASONS)[number];

export interface TrustedDecision {
  readonly kind: 'trusted';
}

export interface UntrustedDecision {
  readonly kind: 'untrusted';
  readonly reason: UntrustedReason;
}

export type TrustDecision = TrustedDecision | UntrustedDecision;

export interface TrustInput {
  /** The ref the folder was scanned from. */
  readonly ref: string;
  readonly defaultBranch: string;
  /** Whether `ref` lives in a fork of the watched repository. */
  readonly isFork: boolean;
  /** The repo's own opt-in for fork-originated specs — off unless a maintainer turned it on. */
  readonly allowForkPRs: boolean;
  /** The permission level of whoever authored the folder's most recent commit — `ForgeAdapter.authorPermission`'s result. */
  readonly authorPermission: CollaboratorPermission;
}

/**
 * `'admin'` and `'write'` are the only permission levels SPEC-06 accepts —
 * both give the account push access to the repository, which is the actual
 * trust boundary a maintainer is granting when they add a collaborator.
 */
function hasWriteAccess(permission: CollaboratorPermission): boolean {
  return permission === 'admin' || permission === 'write';
}

export function evaluateSpecTrust(input: TrustInput): TrustDecision {
  if (input.ref !== input.defaultBranch) {
    return { kind: 'untrusted', reason: 'non-default-branch' };
  }
  if (input.isFork && !input.allowForkPRs) {
    return { kind: 'untrusted', reason: 'fork' };
  }
  if (input.authorPermission === 'unknown') {
    return { kind: 'untrusted', reason: 'unresolvable-author' };
  }
  if (!hasWriteAccess(input.authorPermission)) {
    return { kind: 'untrusted', reason: 'insufficient-permission' };
  }
  return { kind: 'trusted' };
}
