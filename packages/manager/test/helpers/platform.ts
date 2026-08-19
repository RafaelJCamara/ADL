/**
 * The visible-skip helper for `@adl/manager` (D-21, D-33, P3/P4 in
 * `03-01-PLAN.md`'s prohibition ledger).
 *
 * `packages/workspace/test/helpers/platform.ts`'s `linuxOnly`/`posixOnly`
 * cover the Linux-only privilege-drop assertions from Phase 2. This phase
 * adds Windows-specific assertions (D-33) that have no Linux subject, so this
 * file re-declares the same shape rather than importing the workspace
 * package's helper — it lives in a different package's `test/` directory and
 * is not published on any barrel; a test helper reaching across package
 * boundaries by relative import would be exactly the kind of untracked
 * coupling the package split exists to prevent.
 *
 * `SKIP_PREFIX` keeps the same literal value as `packages/workspace`'s
 * because it is the string a reader greps a green CI log for, regardless of
 * which package's suite wrote the line.
 */

/** Prefix on the skip line. Greppable, and it names the requirement. */
export const SKIP_PREFIX = '[ADL][SKIPPED]';

/**
 * The decision, as a discriminated union.
 *
 * Unlike `packages/workspace`'s `LinuxOnlyGate`, there is no third
 * "misconfigured" case here: `requirePlatform` gates on the platform alone,
 * with no environment-variable precondition to be misconfigured. A case that
 * needs both — a required platform AND a required environment — composes
 * `requirePlatform` with its own throw, the same way `linuxOnly` does for
 * the worker-identity variables.
 */
export type PlatformGate =
  { readonly kind: 'run' } | { readonly kind: 'skip'; readonly reason: string };

/**
 * Gate an assertion to a single required platform, loudly.
 *
 * @param platform       The platform this assertion's subject requires.
 * @param reason         Why this case cannot run elsewhere, in the words a
 *                        reader of a green log needs. Stated by the caller
 *                        rather than generated, because "not win32" is not a
 *                        reason — "start-time verification reads `/proc`,
 *                        which has no Windows subject (D-33)" is.
 * @param requirementId  The requirement whose evidence is at stake.
 * @param currentPlatform  The platform to gate against. Defaulted to
 *                        `process.platform` so the helper's own unit test can
 *                        drive it directly, without spawning a second process
 *                        under a different OS.
 */
export function requirePlatform(
  platform: NodeJS.Platform,
  reason: string,
  requirementId: string,
  currentPlatform: NodeJS.Platform = process.platform,
): PlatformGate {
  if (currentPlatform !== platform) {
    const stated = `${SKIP_PREFIX}[${requirementId}] ${reason} (platform: ${currentPlatform})`;
    // Written unconditionally, and to standard error rather than through the
    // reporter: vitest's own skip reason is rendered by some reporters and
    // not others, and this line has to survive whichever one CI happens to
    // use (mirrors packages/workspace/test/helpers/platform.ts's linuxOnly).
    process.stderr.write(`${stated}\n`);
    return { kind: 'skip', reason: stated };
  }

  return { kind: 'run' };
}

/**
 * Convenience wrapper over {@link requirePlatform} for the D-33 case: an
 * assertion whose subject only exists on Windows.
 */
export function windowsOnly(
  reason: string,
  requirementId: string,
  currentPlatform: NodeJS.Platform = process.platform,
): PlatformGate {
  return requirePlatform('win32', reason, requirementId, currentPlatform);
}
