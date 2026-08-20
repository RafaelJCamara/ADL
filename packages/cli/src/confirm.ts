import { createInterface } from 'node:readline/promises';

/**
 * `src/confirm.ts` — D-29's scoping rule for `adl pause`/`resume`/`kill`: a
 * positional argument for the common single-feature case, explicit flags for
 * wider blast radii, and a confirmation proportionate to an operation that
 * can stop every in-flight run on the host.
 */

/**
 * Whether the current process is attached to an interactive terminal.
 *
 * A thin wrapper around `stdin.isTTY` rather than a bare property read
 * scattered at call sites, so a test can inject a fake stream instead of
 * needing a real TTY (which CI does not have).
 */
export function isInteractive(
  stdin: NodeJS.ReadStream = process.stdin,
): boolean {
  return Boolean(stdin.isTTY);
}

export interface ConfirmBlastRadiusOptions {
  /** `--yes` — bypasses the prompt for scripts. */
  readonly yes?: boolean;
  /** Injected so a test can drive both branches without a real TTY. */
  readonly isInteractive?: () => boolean;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

/**
 * Ask before a wide-blast-radius operation proceeds. Returns whether it
 * should.
 *
 * `--yes` always short-circuits to `true` — the script escape hatch. Absent
 * that, a **non-interactive** context refuses outright: there is no one to
 * ask, and silently proceeding is how a CI script stops a production host
 * (D-29). Only an interactive context prompts, and only an explicit
 * affirmative answer proceeds — anything else, including a bare newline, is
 * a decline.
 */
export async function confirmBlastRadius(
  summary: string,
  options: ConfirmBlastRadiusOptions = {},
): Promise<boolean> {
  if (options.yes) return true;

  const interactive = (options.isInteractive ?? isInteractive)();
  if (!interactive) return false;

  const rl = createInterface({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
  });
  try {
    const answer = await rl.question(`${summary} Proceed? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** The three blast radii D-29 defines: a single feature, a repository, or every feature. */
export type ControlScope = 'feature' | 'repo' | 'all';

export interface ResolvedScope {
  readonly scope: ControlScope;
  readonly featureId?: string;
  readonly repoId?: string;
}

/** A usage error: none of, or more than one of, `featureId`/`--repo`/`--all` were given. */
export class ScopeUsageError extends Error {
  override readonly name = 'ScopeUsageError';
}

export interface ScopeOptions {
  readonly featureId?: string;
  readonly repo?: string;
  readonly all?: boolean;
}

/**
 * The one shared scope-resolution helper `pause`/`resume`/`kill` all use: a
 * positional feature id, `--repo <id>`, or `--all` — mutually exclusive, so
 * a usage error is raised (and nothing is posted) rather than one silently
 * winning over another.
 */
export function resolveScope(options: ScopeOptions): ResolvedScope {
  const given = [
    options.featureId !== undefined,
    options.repo !== undefined,
    options.all === true,
  ].filter(Boolean).length;

  if (given === 0) {
    throw new ScopeUsageError(
      'one of a feature id, --repo <id>, or --all is required',
    );
  }
  if (given > 1) {
    throw new ScopeUsageError(
      'a feature id, --repo <id>, and --all are mutually exclusive',
    );
  }

  if (options.featureId !== undefined) {
    return { scope: 'feature', featureId: options.featureId };
  }
  if (options.repo !== undefined) {
    return { scope: 'repo', repoId: options.repo };
  }
  return { scope: 'all' };
}
