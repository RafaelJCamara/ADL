import { LoadError } from '../errors.js';

/**
 * ADL's own restricted `${VAR}` interpolation (D-21) — deliberately not
 * general shell expansion.
 *
 * `adl.yml` allocates no port itself; ADL does, and exports it as
 * `ADL_PORT`. `adl.yml` references it explicitly in a command's `env` block
 * and in the `http` readiness probe's `url`
 * (`http://127.0.0.1:${ADL_PORT}/health`) — the two interpolation sites
 * `adl-yml.ts`'s module header documents as promise 2. `ADL_FEATURE_ID`,
 * `ADL_ROUND`, and `ADL_VERDICT_FILE` cover the remaining values a command
 * gate legitimately needs to know about itself.
 *
 * This is deliberately **not general shell expansion**: a permissive
 * variable-reference pattern, or a fallback that reads `process.env` for an
 * unrecognised name, is how repository-supplied configuration gains a new
 * execution surface — 01-RESEARCH.md § Pitfall 10 is this exact
 * degradation, and it names the negative test this module is built against:
 * a variable naming a system search path (`PATH`) and a variable naming a
 * model API key (`ANTHROPIC_API_KEY`) must both fail validation, not
 * resolve to an empty string or — far worse — to the daemon's own
 * environment. **This module never reads `process.env`.** Plan 01-03's
 * `no-restricted-imports`-style lint rule makes that a build failure; this
 * is the specific reason the rule exists.
 *
 * The closed allowlist is not hardcoded inside {@link interpolate} itself —
 * it is the key set of the `values` argument, supplied by the caller at
 * every call site. A template referencing a name absent from `values` is a
 * validation error naming that name, never an empty-string substitution,
 * whether the name is a plausible-looking ADL variable the caller simply
 * did not supply this time, or something that was never one of ADL's
 * variables at all.
 */

/**
 * Every variable ADL itself may substitute, and what each one carries.
 *
 * A frozen record rather than a plain string array so each entry can carry
 * its own documentation; {@link AdlVariableName} is derived from its keys so
 * the type and the runtime list cannot drift apart.
 */
export const ADL_VARIABLES = Object.freeze({
  ADL_PORT: 'The port ADL allocated for the app under test.',
  ADL_FEATURE_ID: "The feature's id — its folder name under features_dir.",
  ADL_ROUND: 'The current round number, 1-based.',
  ADL_VERDICT_FILE: 'The path a command gate writes its structured verdict to.',
} as const);

export type AdlVariableName = keyof typeof ADL_VARIABLES;

/**
 * Matches `${name}`, where `name` is a bare identifier: a letter or
 * underscore, then letters, digits, or underscores. No nested quantifiers
 * and no wildcard inside the reference form, so matching is linear — a
 * permissive pattern here is exactly how a general expander gets built one
 * small change at a time (threat T-1-11).
 */
const VARIABLE_REF_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Substitute every `${name}` reference in `template` with `values[name]`.
 *
 * `values`'s own key set **is** the closed allowlist for this call — not
 * `ADL_VARIABLES` directly, so a caller that (correctly) supplies only the
 * variables relevant to one call site gets a validation error for any
 * other name, including one that is a legitimate ADL variable it simply
 * did not pass this time. A template with no `${...}` references is
 * returned unchanged. The same variable referenced twice substitutes both
 * occurrences.
 *
 * @throws {LoadError} naming the first unrecognised variable found.
 */
export function interpolate<const Values extends Readonly<Record<string, string>>>(
  template: string,
  values: Values,
): string {
  return template.replace(VARIABLE_REF_PATTERN, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      throw new LoadError(
        `Unknown interpolation variable \${${name}}. ADL only substitutes a closed, ` +
          'documented set of its own variables — never the process environment.',
      );
    }
    return (values as Record<string, string>)[name] as string;
  });
}
