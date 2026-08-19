/**
 * The visible-skip helper (D-21).
 *
 * Two of Phase 2's acceptance criteria cannot execute on the Windows
 * development machine, and D-21 is the decision that says what to do about it:
 * skip with a stated reason rather than pass vacuously, and do not call the
 * phase done until they have run green on Linux.
 *
 * The failure this exists to prevent is specific. A `it.skipIf(...)` reads as a
 * dot in a summary line and as nothing at all in a scrolled CI log — so a suite
 * in which the two assertions that carry WORK-05's entire evidence never ran is
 * indistinguishable, at a glance, from one in which they passed. Both are green.
 *
 * So there are two mechanisms here, not one:
 *
 * 1. A skip WRITES ITS REASON to standard error, prefixed with the requirement
 *    id. A reader who greps a green log for the requirement finds either the
 *    skip line or nothing, and "nothing" now means the assertions ran.
 * 2. A Linux run with no worker user configured FAILS. Not skips — fails.
 *    A CI job that forgets the provisioning step must go red, because a gate
 *    that quietly declines to run on the only platform where it applies is a
 *    decoration (T-2-33).
 */
import { WORKER_GROUP_VAR, WORKER_USER_VAR } from '../../src/exec/privilege.js';

/**
 * The decision, as a discriminated union — with a deliberate asymmetry.
 *
 * There are two variants but three situations. The third — Linux with the
 * worker user unset — is a THROW rather than a returned variant, and that is
 * the point: a returned `{ kind: 'misconfigured' }` is a case a test author can
 * forget to handle, and forgetting it produces exactly the silent pass D-21
 * exists to prevent. A throw inside the test body fails the case whether or not
 * anyone remembered it was possible.
 */
export type LinuxOnlyGate =
  | {
      readonly kind: 'run';
      readonly workerUser: string;
      readonly workerGroup: string;
    }
  | { readonly kind: 'skip'; readonly reason: string };

/** Prefix on the skip line. Greppable, and it names the requirement. */
export const SKIP_PREFIX = '[ADL][SKIPPED]';

/**
 * Gate a Linux-only assertion, loudly.
 *
 * @param reason  Why this case cannot run elsewhere, in the words a reader of a
 *                green log needs. Stated by the caller rather than generated,
 *                because "not Linux" is not a reason — "the privilege drop is
 *                Linux-only in v1 (D-05), so WORK-05's uid assertion has no
 *                subject here" is.
 * @param requirementId  The requirement whose evidence is at stake.
 */
export function linuxOnly(
  reason: string,
  requirementId = 'WORK-05',
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): LinuxOnlyGate {
  if (platform !== 'linux') {
    const stated = `${SKIP_PREFIX}[${requirementId}] ${reason} (platform: ${platform})`;
    // Written unconditionally, and to standard error rather than through the
    // reporter: vitest's own skip reason is rendered by some reporters and not
    // others, and this line has to survive whichever one CI happens to use.
    process.stderr.write(`${stated}\n`);
    return { kind: 'skip', reason: stated };
  }

  const workerUser = env[WORKER_USER_VAR]?.trim() ?? '';
  const workerGroup = env[WORKER_GROUP_VAR]?.trim() ?? '';

  if (workerUser === '' || workerGroup === '') {
    const missing = [
      ...(workerUser === '' ? [WORKER_USER_VAR] : []),
      ...(workerGroup === '' ? [WORKER_GROUP_VAR] : []),
    ].join(' and ');

    throw new Error(
      `${requirementId}: the Linux privilege assertions were expected to run on this platform and could not — ` +
        `${missing} ${workerUser === '' && workerGroup === '' ? 'are' : 'is'} not set. ` +
        `This is a FAILURE and not a skip on purpose (D-21, T-2-33): a CI job that forgot to provision the worker ` +
        `user would otherwise go green having produced none of WORK-05's evidence. Provision the user and group ` +
        `(see .github/workflows/ci.yml § Provision the unprivileged worker user, and packages/workspace/README.md) ` +
        `or run this suite on a non-Linux machine, where it skips with a stated reason instead.`,
    );
  }

  return { kind: 'run', workerUser, workerGroup };
}

/**
 * The decision for a case that needs POSIX permission bits and nothing else.
 */
export type PosixOnlyGate =
  { readonly kind: 'run' } | { readonly kind: 'skip'; readonly reason: string };

/**
 * Gate a POSIX-permission assertion, just as loudly — and deliberately NOT
 * through {@link linuxOnly}.
 *
 * The two gates answer different questions and conflating them would break both
 * of D-21's mechanisms at once:
 *
 * - {@link linuxOnly} guards assertions about the *privilege drop*, so a Linux
 *   runner with no worker user provisioned is a FAILURE there — the evidence was
 *   expected and was not produced.
 * - This one guards assertions about *mode bits* (`0700` on a directory ADL
 *   created, say). They need no worker user, no `sudo`, and no provisioning;
 *   they simply have no meaning on Windows, where `fs.Stats.mode` reports the
 *   read-only attribute rather than permissions. Failing a Linux developer's run
 *   because `ADL_WORKER_USER` is unset would be a gate going red for a reason
 *   that has nothing to do with what it measures — and a gate that cries wolf is
 *   a gate that gets deleted.
 *
 * What the two share is the part that matters: a skip WRITES ITS REASON, with a
 * requirement id, to standard error.
 */
export function posixOnly(
  reason: string,
  requirementId = 'WORK-05',
  platform: NodeJS.Platform = process.platform,
): PosixOnlyGate {
  if (platform === 'win32') {
    const stated = `${SKIP_PREFIX}[${requirementId}] ${reason} (platform: ${platform})`;
    process.stderr.write(`${stated}\n`);
    return { kind: 'skip', reason: stated };
  }
  return { kind: 'run' };
}
