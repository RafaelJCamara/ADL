import tseslint from 'typescript-eslint';

/**
 * ADL lint configuration.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ARCHITECTURE RULE SET
 * ══════════════════════════════════════════════════════════════════════════
 *
 * These are not style rules. Each one carries a structural guarantee that the
 * project has committed to, and each one ships at `error` severity because a
 * rule that only warns does not fail CI and therefore does not enforce
 * anything.
 *
 * | Rule                       | Implements | Extended by |
 * |----------------------------|------------|-------------|
 * | `no-restricted-imports`    | D-27 — the dependency-graph rule lands WITH the workspace, before any adapter exists to break it. `@adl/core` sits at the bottom of the graph and imports no sibling workspace package, so a third-party harness author can depend on it without dragging in a database driver. | Phase 2's no-direct-spawn rule; Phase 11's ban on backend-name comparisons outside the adapters directory |
 * | `no-restricted-imports` (builtins) | 01-RESEARCH.md § Architectural Responsibility Map — `@adl/core` is pure and I/O-free. Enforcing that by lint costs one config block now; discovering a stray `readFileSync` in Phase 5 costs a refactor. It is also what keeps core's suite inside 01-VALIDATION.md's five-second quick-run budget. | Phase 2, when the filesystem finally gets an owner |
 * | `no-restricted-properties` | 01-RESEARCH.md § Pitfall 10, threat T-1-12 — stops plan 01-08's `${ADL_PORT}` interpolator growing into a read primitive over the daemon's environment, which per WORK-06 is where credentials live. | Phase 8, when the config surface grows |
 * | `no-restricted-syntax`     | 01-RESEARCH.md § Pitfall 1, threat T-1-06 — `z.toJSONSchema()` discards `.refine()` with no error and no warning, so a refined verdict schema publishes a contract strictly WEAKER than the one `parse()` enforces. A third-party command gate would validate its own output as good and then have it rejected as malformed down the CORE-06 infrastructure-failure path. | Phase 13, when the published schema meets a genuinely third-party harness |
 *
 * `dependency-cruiser` was evaluated and not adopted — 01-RESEARCH.md
 * § Package Legitimacy Audit records the verdict; D-27 specifies this
 * mechanism, and one dependency fewer is the right trade for four rules.
 *
 * ── Why the rules are constants applied to two globs ──────────────────────
 *
 * Each rule set below is defined ONCE and registered against two `files`
 * globs: the real source it governs, and the deliberate-violation fixtures
 * under `test/lint/fixtures/`. The fixtures therefore exercise the very same
 * rule objects the real source is linted with, rather than a parallel copy
 * that can silently drift out of agreement with it. That is the whole point of
 * 01-RESEARCH.md § Pitfall 8: a rule nobody has watched fail is a rule that
 * ships mis-scoped.
 */

/** Every rule id in the architecture set. The test asserts this is exhaustive. */
export const ARCHITECTURE_RULE_IDS = Object.freeze([
  'no-restricted-imports',
  'no-restricted-properties',
  'no-restricted-syntax',
]);

const PURITY_MESSAGE =
  'is not available inside @adl/core. Core is pure and I/O-free — the caller owns the filesystem and the process table (01-RESEARCH.md § Architectural Responsibility Map). Take the file CONTENTS as a string instead.';

/**
 * Banned inside `@adl/core`. Both the `node:`-prefixed and the bare specifier
 * are listed: they resolve to the same builtin, and banning only one leaves the
 * rule trivially bypassable by dropping four characters.
 */
const FORBIDDEN_CORE_BUILTINS = [
  'node:fs',
  'fs',
  'node:fs/promises',
  'fs/promises',
  'node:child_process',
  'child_process',
  'node:process',
  'process',
].map((name) => ({ name, message: `${name} ${PURITY_MESSAGE}` }));

/**
 * `@adl/core` imports no sibling workspace package. This is D-27's rule — the
 * one whose entire argument is that it exists before the thing it would have
 * prevented. `@adl/core` itself is exempted so the negation is explicit rather
 * than implied by the glob.
 */
const FORBIDDEN_CORE_SIBLINGS = [
  {
    group: ['@adl/*', '!@adl/core', '!@adl/core/*'],
    message:
      'is a sibling workspace package, and @adl/core sits at the bottom of the dependency graph (D-27). A third-party harness author depends on @adl/core; making it reach sideways would drag a database driver into their install.',
  },
];

/**
 * The `@adl/core` purity and dependency-graph rules.
 *
 * `no-restricted-imports` carries both the builtin ban and the sibling-package
 * ban in ONE entry, deliberately: ESLint allows a single configuration per rule
 * per file, so registering them as two entries would mean the second silently
 * replaced the first — precisely the kind of decorative rule this plan exists
 * to prevent.
 */
const CORE_PURITY_RULES = {
  'no-restricted-imports': [
    'error',
    { paths: FORBIDDEN_CORE_BUILTINS, patterns: FORBIDDEN_CORE_SIBLINGS },
  ],
  'no-restricted-properties': [
    'error',
    {
      object: 'process',
      property: 'env',
      message:
        'Reading process.env inside @adl/core turns adl.yml into a read primitive over the daemon environment, where credentials live (Pitfall 10, T-1-12). Interpolate against the closed allowlist passed in by the caller.',
    },
  ],
};

/**
 * The verdict-schema refinement ban.
 *
 * Scoped to `verdict/` rather than all of core because this is specifically
 * about the schemas that get PUBLISHED as JSON Schema (D-26). Elsewhere — the
 * `adl.yml` config schema, for instance — a `.superRefine()` is safe precisely
 * because that schema is never emitted.
 */
const VERDICT_SCHEMA_RULES = {
  'no-restricted-syntax': [
    'error',
    {
      selector:
        "CallExpression[callee.type='MemberExpression'][callee.property.name='refine']",
      message:
        'refine() is banned under packages/core/src/verdict/. z.toJSONSchema() drops refinements with no error and no warning, so the published contract would be strictly weaker than the one parse() enforces (Pitfall 1, T-1-06). Express the constraint structurally — z.literal, z.enum, .min(), .length(), .regex() all survive emission.',
    },
    {
      selector:
        "CallExpression[callee.type='MemberExpression'][callee.property.name='superRefine']",
      message:
        'superRefine() is banned under packages/core/src/verdict/ for the same reason refine() is: it does not survive z.toJSONSchema(), so it would weaken the published contract silently (Pitfall 1, T-1-06).',
    },
  ],
};

/**
 * Everything EXCEPT the architecture rules.
 *
 * Exported so the fixture test can build the negative control: the same four
 * fixtures linted with this and nothing else must report zero errors. Without
 * that control, a fixture failing for an unrelated reason would make the
 * positive assertions pass while proving nothing.
 */
export const baseConfigs = [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.planning/**',
      '.claude/**',
      '.gsd/**',
      // Emitted JSON Schema (D-26) — a build artifact that is committed and
      // diffed, not source anyone edits.
      'packages/core/schema/**',
      // The deliberate-violation fixtures. These files EXIST to be reported,
      // so a plain `eslint .` — the `lint` script, and therefore CI — must not
      // count them; otherwise the build is permanently red by construction.
      // They are still governed by the architecture rules below (see the
      // `adl/*-fixtures` entries), and `test/lint/no-restricted-imports.test.ts`
      // lints them through this same config file with `ignore: false`. The rule
      // objects it exercises are literally the ones real source is linted with.
      'test/lint/fixtures/**',
    ],
  },
  ...tseslint.configs.recommended,
];

/**
 * The architecture rule set, registered against real source and against the
 * fixtures that prove each rule fires.
 */
export const architectureConfigs = [
  {
    name: 'adl/core-purity',
    files: ['packages/core/src/**/*.ts'],
    rules: CORE_PURITY_RULES,
  },
  {
    name: 'adl/core-purity-fixtures',
    files: ['test/lint/fixtures/core-*.ts'],
    rules: CORE_PURITY_RULES,
  },
  {
    name: 'adl/verdict-schema',
    files: ['packages/core/src/verdict/**/*.ts'],
    rules: VERDICT_SCHEMA_RULES,
  },
  {
    name: 'adl/verdict-schema-fixtures',
    files: ['test/lint/fixtures/verdict-*.ts'],
    rules: VERDICT_SCHEMA_RULES,
  },
];

export default [...baseConfigs, ...architectureConfigs];
