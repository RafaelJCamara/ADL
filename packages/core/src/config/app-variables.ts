/**
 * The interpolation values the app lifecycle supplies, and the two places it
 * substitutes them (ROLE-07, M08 step 8.2).
 *
 * `interpolate()` and {@link ADL_VARIABLES} have existed since M01 and, until
 * this step, had **zero production callers** — which is the state M08's
 * pre-implementation audit found them in (finding 4). This module is the caller,
 * and it is deliberately the *only* one: `interpolate()`'s contract is that the
 * `values` argument's own key set is the closed allowlist for that call, so a
 * second call site supplying a different set would make "which variables may a
 * command reference?" a question with two answers depending on which code path
 * reached it.
 *
 * ## Two substitution sites, and why not a third
 *
 * `adl-yml.ts`'s promise 2 and `interpolate.ts`'s own docblock agree on the
 * pair: **a command's `env` values** and **the `http` readiness probe's `url`**.
 * Both are in here and nothing else is:
 *
 * - **Not `argv`.** `CommandSpecSchema.argv` is the injection-sensitive surface
 *   the no-shell rule exists to protect (threat T-1-01), and an app that needs
 *   to be told its port can be told through its environment. Widening the
 *   substitution to argv would be additive and irreversible, and nothing needs
 *   it.
 * - **Not the `tcp` probe's `port`.** `TcpReadyProbeSchema.port` is `z.int()`,
 *   so `${ADL_PORT}` is not even expressible there. That is a real gap rather
 *   than a decision — `DEBT.md`'s **D-8-02-1** records it with a reproduction —
 *   and inventing a string form for the field here would be a schema change
 *   made from an interpolation module.
 *
 * ## Why the variable list is derived rather than written out
 *
 * {@link APP_LIFECYCLE_VARIABLES} carries a `satisfies` clause against
 * {@link AdlVariableName}, so a name that is not one of ADL's documented
 * variables fails the **build** rather than resolving at runtime into a value
 * `adl.yml`'s reference documentation never promised (convention 7).
 *
 * Two of the four documented variables are deliberately **absent** from the set
 * this module supplies, and their absence is the useful behaviour rather than an
 * omission: `interpolate()` raises a `LoadError` naming any variable outside the
 * supplied keys, so a repository referencing `${ADL_ROUND}` in `commands.start`
 * gets an error saying so instead of a silently wrong value.
 *
 * - **`ADL_ROUND`** is not on the worker's wire. An `AssignMessage` carries the
 *   round *id*, not the round *number* — `gate-context.ts` records the same fact
 *   about why `FeatureView`'s round number was not absorbed into `GateContext`.
 * - **`ADL_VERDICT_FILE`** belongs to the command-gate verdict contract
 *   (HARN-02), not to the app lifecycle, and supplying it from here would put
 *   one variable's meaning in two modules.
 */
import type { CommandSpec, ReadyProbe } from './adl-yml.js';
import { interpolate, type AdlVariableName } from './interpolate.js';

/**
 * Every ADL variable the app lifecycle supplies a value for.
 *
 * The `satisfies` clause is the point: a typo, or a name that was never one of
 * ADL's variables, is a compile error here rather than a substitution nothing
 * documented.
 */
export const APP_LIFECYCLE_VARIABLES = Object.freeze([
  'ADL_PORT',
  'ADL_FEATURE_ID',
] as const) satisfies readonly AdlVariableName[];

export type AppLifecycleVariable = (typeof APP_LIFECYCLE_VARIABLES)[number];

/** What ADL knows at the moment it starts an app, and nothing more. */
export interface AppVariableInputs {
  /** The port ADL allocated for this app. */
  readonly port: number;
  /** The feature's folder name under `features_dir`. */
  readonly featureId: string;
}

/** The closed `values` record `interpolate()` is called with. */
export type AppVariableValues = Readonly<Record<AppLifecycleVariable, string>>;

/**
 * The values, as the closed allowlist for every substitution below.
 *
 * The return **type** is the whole record, so a variable listed in
 * {@link APP_LIFECYCLE_VARIABLES} and not produced here fails the build — the
 * other half of convention 7's pairing, and the reason this is a function with
 * an annotated return type rather than an object literal built at each call
 * site.
 */
export function appVariables(inputs: AppVariableInputs): AppVariableValues {
  return {
    ADL_PORT: String(inputs.port),
    ADL_FEATURE_ID: inputs.featureId,
  };
}

/**
 * Substitute into a command's `env` values, leaving every other field alone.
 *
 * Generic over the command shape so a `StartCommandSpec` keeps its `ready` and
 * `ready_timeout` rather than being widened to a bare {@link CommandSpec} on the
 * way through. A command with no `env` is returned **by identity**, which is
 * what makes this safe to apply unconditionally to every command the lifecycle
 * touches.
 *
 * @throws {LoadError} naming the first unrecognised variable, from
 *   `interpolate()`. A command referencing a variable ADL does not supply is a
 *   configuration error, and the caller classifies it — never an empty string.
 */
export function interpolateCommandEnv<T extends CommandSpec>(
  command: T,
  values: AppVariableValues,
): T {
  const { env } = command;
  if (env === undefined) return command;

  const substituted: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    substituted[name] = interpolate(value, values);
  }
  return { ...command, env: substituted };
}

/**
 * Substitute into the one probe field the schema documents as interpolatable.
 *
 * The `http` probe's `url` is the site `adl-yml.ts` names in promise 2 and the
 * reason `InterpolatableUrlSchema` exists at all (it deliberately does not use
 * `z.url()`, which rejects `${ADL_PORT}` as an invalid host). Every other kind
 * is returned by identity rather than by a default branch, so adding a fifth
 * probe kind cannot silently acquire interpolation it was never given.
 *
 * @throws {LoadError} naming the first unrecognised variable.
 */
export function interpolateReadyProbe(
  probe: ReadyProbe,
  values: AppVariableValues,
): ReadyProbe {
  if (probe.kind !== 'http') return probe;
  return { ...probe, url: interpolate(probe.url, values) };
}
