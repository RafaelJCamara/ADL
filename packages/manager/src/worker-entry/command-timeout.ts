/**
 * The wall-clock ceiling one `adl.yml` command runs under.
 *
 * Extracted from `gates/command-gate.ts` when M08 step 8.2 became a second
 * consumer — `commands.build`, `commands.start` and `commands.teardown` need the
 * identical answer `commands.test` already had. Convention 8: a transcribed copy
 * of this in a second file is exactly the mistake that lets one path grow a
 * configured default while the other keeps the placeholder.
 */
import { parseDuration, type CommandSpec } from '@adl/core/config';

/**
 * The ceiling applied when a command declares no `timeout` of its own.
 *
 * The same constant and the same reasoning as `stage-runner.ts`'s
 * `DEFAULT_MAX_WALL_CLOCK_MS`: `EffectiveConfig.limits` has no per-invocation
 * wall-clock field, so this is a conservative placeholder rather than an
 * unbounded run. `CommandSpecSchema.timeout` is how an operator overrides it
 * today.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The timeout to enforce, in milliseconds.
 *
 * `command.timeout` reached the worker process as a field on a JSON blob that
 * `stage-runner.ts` casts rather than validates, so a value `DurationSchema`
 * would have rejected can arrive here even though `adl.yml` parsing could never
 * have produced one. `parseDuration` throws on those; falling back to the
 * default is the right answer rather than failing the stage, because a malformed
 * ceiling is a configuration problem and running under a conservative one is
 * strictly better than not running.
 */
export function timeoutMsFor(command: CommandSpec): number {
  if (command.timeout === undefined) return DEFAULT_COMMAND_TIMEOUT_MS;
  try {
    return parseDuration(command.timeout);
  } catch {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
}

/**
 * The same answer, or **no ceiling at all** when the command declared none.
 *
 * This is `commands.start`'s reading and it is deliberately not
 * {@link timeoutMsFor}'s. `commands.start` launches a process that is *supposed*
 * to outlive its own invocation, and `CommandSpecSchema.timeout` describes
 * *"how long this command may run before ADL kills it"* — so a declared
 * `timeout: 2m` is a ceiling on the **app's whole lifetime**, and an absent one
 * means ADL kills it when the round is done and not before.
 *
 * Applying {@link timeoutMsFor}'s ten-minute placeholder here would silently kill
 * every app under test after ten minutes mid-suite, which is a failure the
 * operator never configured and could not see in their own file. `undefined`
 * means `ExecSpec.timeoutMs` is omitted, which `exec/run.ts` maps to execa's
 * "no timeout".
 *
 * ⚠ A declared `start.timeout` shorter than the suite it has to survive kills the
 * app mid-run, and `adl-yml.ts`'s own worked example declares `start: 2m` beside
 * `test: 15m`. That is `DEBT.md`'s **D-8-02-2**, owner step 8.3, which owns the
 * failure-mode map this belongs in.
 */
export function startTimeoutMsFor(command: CommandSpec): number | undefined {
  if (command.timeout === undefined) return undefined;
  try {
    return parseDuration(command.timeout);
  } catch {
    return undefined;
  }
}
