/**
 * The child environment builder (D-07, D-09, D-10, WORK-06, WORK-07).
 *
 * Every variable a child of a workspace receives is constructed here, from
 * nothing. `process.env` is never read: the worker's own environment is where a
 * forge token and a model API key both live, and the whole point of D-10 is that
 * a child sees neither unless a caller named it on that specific `ExecSpec`.
 *
 * **Do not add a "just pass the `GIT_*` prefix through" convenience, and do not
 * turn this into "inherit minus a denylist".** Both look like housekeeping and
 * neither is: `GIT_CONFIG_COUNT` with `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`
 * sets arbitrary git config, and arbitrary git config (`core.hooksPath`,
 * `core.pager`, any `*.sshCommand`) is arbitrary code execution. Verified:
 * `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=injected
 * git config --get user.name` prints `injected` (02-RESEARCH.md § Pitfall 10).
 * The zero-inherit default below is the only reason that vector is unreachable
 * today — there is no second control behind it. An allowlist that quietly
 * becomes a denylist is a security regression in which *every existing call site
 * looks unchanged in the diff*, which is what makes it worth a paragraph rather
 * than a line.
 *
 * **This function must never log, and must never put a value in an error
 * message.** It is the one place in ADL where a forge token and a model key are
 * simultaneously in scope as plain strings (threat T-2-08, T-2-19). Every error
 * below names the offending variable's *name* only.
 *
 * `scratchHome` is a second parameter rather than a field on `ExecSpec` because
 * it belongs to the `Workspace` instance (D-07). A caller cannot opt a child out
 * of it or point it somewhere else — see {@link WORKSPACE_OWNED_REASON}.
 */
import { join } from 'node:path';
import type { ExecSpec } from '@adl/core/stage';
import { WorkspaceError } from '../errors.js';

/**
 * The neutralisers, and the reason each one is a path *inside* the scratch home
 * rather than `/dev/null` or an empty string.
 *
 * WORK-07 is two claims, not one: agent-written configuration must not reach
 * ADL, and it must not survive the run. Pointing these at a sink would satisfy
 * the first and quietly fail the second — `git config --global` would error
 * instead of writing, and an agent that needs a committer identity would break
 * for a reason that looks like a bug. Pointing them into the scratch directory
 * satisfies both: the write succeeds, the child reads back what it wrote, and
 * the whole lot stops existing when `destroyScratchHome` removes the directory.
 * There is no separate wipe step that has to run correctly, which is D-07's
 * entire argument.
 *
 * Verified locally (02-RESEARCH.md § Code Examples):
 *
 * ```
 * $ HOME=/scratch git config --get core.hooksPath
 * /tmp/wtest/evilhooks                       <- leaks without the neutraliser
 * $ HOME=/scratch GIT_CONFIG_GLOBAL=/dev/null git config --get core.hooksPath
 *                                            <- exit 1, nothing found
 * $ HOME=/scratch npm config get registry
 * https://evil.example.com/                  <- leaks without the neutraliser
 * $ HOME=/scratch npm_config_userconfig=/dev/null npm config get registry
 * https://registry.npmjs.org/                <- neutralised
 * ```
 */
function neutralisers(scratchHome: string): Record<string, string> {
  return {
    // git looks at $HOME/.gitconfig unless this names a file explicitly. The
    // agent may write to it; it dies with the directory.
    GIT_CONFIG_GLOBAL: join(scratchHome, '.gitconfig'),
    // `/etc/gitconfig` is outside the scratch directory and outside ADL's
    // control, so the only way to make it not apply is to switch it off.
    GIT_CONFIG_NOSYSTEM: '1',
    // The npm equivalents. `npm_config_cache` is here as well as
    // `npm_config_userconfig` because a poisoned cache is a persistence
    // mechanism in its own right (T-2-17).
    npm_config_userconfig: join(scratchHome, '.npmrc'),
    npm_config_cache: join(scratchHome, '.npm'),
    // Everything else that follows the XDG spec — gh, a growing number of
    // agent CLIs, and anything that stores a credential helper under
    // `~/.config`.
    XDG_CONFIG_HOME: join(scratchHome, '.config'),
    XDG_CACHE_HOME: join(scratchHome, '.cache'),
    ...(process.platform === 'win32'
      ? {
          // git for Windows resolves a home directory by falling through
          // `HOME`, then `HOMEDRIVE` + `HOMEPATH`, then `USERPROFILE`, and
          // Node injects the last three into every child on Windows regardless
          // of what is passed (02-RESEARCH.md § Pitfall 6). Without this, the
          // fallback chain reaches the real user profile.
          //
          // This branch is a DEVELOPMENT-ENVIRONMENT NICETY under D-05, not a
          // security guarantee: the privilege drop is Linux-only in v1, so on
          // Windows a determined child can reach the host user's files whatever
          // its environment says. It exists so the maintainer's own machine
          // behaves like the deployment target while they are working, not so
          // anyone can rely on it.
          USERPROFILE: scratchHome,
        }
      : {}),
  };
}

/** Shared tail of the two "the workspace owns this variable" errors. */
const WORKSPACE_OWNED_REASON =
  'is owned by the Workspace instance (D-07, WORK-07) and cannot be set through ExecSpec.env. ' +
  'Its value points inside this run’s disposable HOME, which is what makes agent-written ' +
  'configuration die with the directory rather than survive a wipe step.';

export function buildChildEnv(
  spec: ExecSpec,
  scratchHome: string,
): Record<string, string> {
  const env: Record<string, string> = {
    // Required by the type, and required in fact: the runner launches children
    // with no inherited environment, under which the executable is resolved
    // from THIS `PATH` rather than the parent's (02-RESEARCH.md § Pitfall 7).
    // Without it, every bare-name command is ENOENT on Linux while working fine
    // on Windows.
    PATH: spec.path,
    // D-07: a fresh, unpredictably named directory per run, so tool config the
    // agent writes cannot outlive the run or reach the next one.
    HOME: scratchHome,
    ...neutralisers(scratchHome),
  };

  // Key normalisation is owned HERE, in the one function, and this map is the
  // mechanism. On Windows environment keys are case-INSENSITIVE, and Node
  // "lexicographically sorts the env keys and uses the first one that
  // case-insensitively matches" — so a record carrying both `PATH` and `Path`
  // delivers one of them, chosen by sort order, and silently discards the
  // other (nodejs.org/api/child_process.html; 02-RESEARCH.md § Pitfall 11).
  // Picking a winner here would reproduce that bug with better manners. Both
  // spellings are named and the build fails instead.
  const seen = new Map<string, string>();
  for (const key of Object.keys(env)) seen.set(key.toLowerCase(), key);

  // D-09: the caller's explicit allowlist, and the only other way anything
  // reaches the child. Declared as possibly-undefined values on purpose — the
  // static type forbids them, but the common caller shape is
  // `{ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }`, which produces one
  // at runtime whenever the variable is unset.
  const supplied: Readonly<Record<string, string | undefined>> = spec.env ?? {};
  const reserved = new Set(seen.keys());

  for (const [key, value] of Object.entries(supplied)) {
    if (value === undefined) {
      // Node silently DROPS undefined values from `env`, which would hand the
      // agent CLI a keyless invocation that fails ten minutes later with an
      // authentication error nobody can trace back to here. Name the variable,
      // never its value.
      throw new WorkspaceError(
        `Environment variable ${key} was named on this ExecSpec but its value is undefined.`,
      );
    }

    const folded = key.toLowerCase();
    const existing = seen.get(folded);

    if (existing !== undefined && reserved.has(folded)) {
      // Covers both `HOME` and `Home`: on Windows they are the same variable,
      // so allowing the second spelling through would be a case-sensitive
      // bypass of a case-insensitive rule.
      throw new WorkspaceError(
        `Environment variable ${key} ${WORKSPACE_OWNED_REASON}`,
      );
    }

    if (existing !== undefined) {
      throw new WorkspaceError(
        `ExecSpec.env names ${existing} and ${key}, which are the same variable on Windows ` +
          '(environment keys are case-insensitive there, and Node passes only the first in ' +
          'lexicographic order). Name it once.',
      );
    }

    seen.set(folded, key);
    env[key] = value;
  }

  return env;
}
