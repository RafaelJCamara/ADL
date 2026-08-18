/**
 * The child environment builder (D-09, D-10, WORK-06).
 *
 * Every variable a child of a workspace receives is constructed here, from
 * nothing. `process.env` is never read: the worker's own environment is where a
 * forge token and a model API key both live, and the whole point of D-10 is that
 * a child sees neither unless a caller named it on that specific `ExecSpec`.
 *
 * **Do not add a "just pass the `GIT_*` prefix through" convenience.** It looks
 * harmless and it is not: `GIT_CONFIG_COUNT` with `GIT_CONFIG_KEY_0` /
 * `GIT_CONFIG_VALUE_0` sets arbitrary git config, and arbitrary git config
 * (`core.hooksPath`, `core.pager`, any `*.sshCommand`) is arbitrary code
 * execution. Verified: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name
 * GIT_CONFIG_VALUE_0=injected git config --get user.name` prints `injected`
 * (02-RESEARCH.md § Pitfall 10).
 *
 * **This function must never log, and must never put a value in an error
 * message.** It is the one place in ADL where a forge token and a model key are
 * simultaneously in scope as plain strings (threat T-2-08). Errors below name
 * the offending variable's *name* only.
 *
 * `scratchHome` is a second parameter rather than a field on `ExecSpec` because
 * it belongs to the `Workspace` instance (D-07). A caller cannot opt a child out
 * of it or point it somewhere else.
 *
 * Scope note: this ships the zero-inherit default and the `undefined` rejection.
 * The full neutraliser set (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`,
 * `npm_config_*`, `XDG_*`) and Windows key-case normalisation land in plan
 * `02-05`.
 */
import type { ExecSpec } from '@adl/core/stage';
import { WorkspaceError } from '../errors.js';

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
  };

  // D-09: the caller's explicit allowlist, and the only other way anything
  // reaches the child. Declared as possibly-undefined values on purpose — the
  // static type forbids them, but the common caller shape is
  // `{ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }`, which produces one
  // at runtime whenever the variable is unset.
  const supplied: Readonly<Record<string, string | undefined>> = spec.env ?? {};

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
    env[key] = value;
  }

  return env;
}
