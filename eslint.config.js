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
 * | `no-restricted-imports`    | D-27 — the dependency-graph rule lands WITH the workspace, before any adapter exists to break it. `@adl/core` sits at the bottom of the graph and imports no sibling workspace package, so a third-party harness author can depend on it without dragging in a database driver. | Phase 11's ban on backend-name comparisons outside the adapters directory |
 * | `no-restricted-imports` (builtins) | 01-RESEARCH.md § Architectural Responsibility Map — `@adl/core` is pure and I/O-free. Enforcing that by lint costs one config block now; discovering a stray `readFileSync` in Phase 5 costs a refactor. It is also what keeps core's suite inside 01-VALIDATION.md's five-second quick-run budget. | Phase 2, when the filesystem finally gets an owner |
 * | `no-restricted-properties` | 01-RESEARCH.md § Pitfall 10, threat T-1-12 — stops plan 01-08's `${ADL_PORT}` interpolator growing into a read primitive over the daemon's environment, which per WORK-06 is where credentials live. | Phase 8, when the config surface grows |
 * | `no-restricted-syntax`     | 01-RESEARCH.md § Pitfall 1, threat T-1-06 — `z.toJSONSchema()` discards `.refine()` with no error and no warning, so a refined verdict schema publishes a contract strictly WEAKER than the one `parse()` enforces. A third-party command gate would validate its own output as good and then have it rejected as malformed down the CORE-06 infrastructure-failure path. | Phase 13, when the published schema meets a genuinely third-party harness |
 * | `no-restricted-imports` + `no-restricted-syntax` (the spawn ban, `adl/no-direct-spawn`) | WORK-02 and Phase 2 success criterion 2 — every process ADL starts goes through `Workspace.exec()`, so the container backend in v2 is a registry entry rather than a repository-wide call-site sweep. This is a BUILD property, not a review property: a direct `spawn` reaching the OS process table bypasses the zero-inherit environment, the scratch `HOME`, the privilege drop, and the git-config neutralisation all at once. Composed against 02-RESEARCH.md § Pitfall 1 (overlapping flat-config entries REPLACE rather than merge, so a careless glob silently deletes the two bans above) and § Pitfall 2 (`no-restricted-imports` is blind to `require()` and dynamic `import()`, so the ban is otherwise bypassable by changing the import form). | Phase 3, when the manager→worker `fork()` seam lands as a named export of `packages/workspace` rather than as a second exemption |
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

const SPAWN_MESSAGE =
  'Direct process launch is banned outside packages/workspace (WORK-02). Every process ADL starts — including the agent CLIs — goes through Workspace.exec(), which is what makes the container backend in v2 a registry entry rather than a repository-wide call-site sweep. The Phase 3 manager→worker seam is not an exception: fork() lands as a named export of packages/workspace too, so the exemption count stays at one. If you need to run something, take the Workspace instance the caller already has.';

/**
 * The banned specifiers, listed EXACTLY ONCE in this file.
 *
 * Both `no-restricted-imports` (the static-import layer) and
 * `no-restricted-syntax` (the `require()` / dynamic-`import()` layer) are
 * derived from `FORBIDDEN_SPAWN_SPECIFIERS` below, and that derivation is the
 * whole mechanism by which the two layers cannot come to cover different sets.
 * An earlier draft hand-wrote the syntax selectors against `child_process`
 * alone; `await import('execa')` outside the workspace then passed BOTH layers
 * while `pnpm lint` stayed green. `execa@10` is ESM-only, so reaching it
 * through a dynamic `import()` is the idiomatic form rather than an exotic
 * bypass — which made two of the four specifiers unreachable by accident.
 *
 * The prefixed and the bare spelling of the builtin are separate entries for
 * the reason `FORBIDDEN_CORE_BUILTINS` already gives: they resolve to the same
 * module, and banning one leaves the rule bypassable by dropping five
 * characters. `execa` and `simple-git` are here because each spawns a process
 * internally; `simple-git` in particular is why D-17 exists — ADL's own git
 * client routes through its own Workspace instance rather than earning a
 * second exemption.
 *
 * Exported so the lint suite can iterate it. ESLint loads only the default
 * export, so a named export beside it changes nothing about resolution.
 */
export const FORBIDDEN_SPAWN_SPECIFIERS = Object.freeze([
  'node:child_process',
  'child_process',
  'execa',
  'simple-git',
]);

/** The static-import layer, derived from the tuple. */
const FORBIDDEN_SPAWN = FORBIDDEN_SPAWN_SPECIFIERS.map((name) => ({
  name,
  message: `${name}: ${SPAWN_MESSAGE}`,
}));

/**
 * Anchor a specifier at both ends and escape every regex metacharacter in it,
 * so a specifier added to the tuple later cannot yield a selector matching more
 * than it names. `-` is deliberately NOT escaped: `\-` is an error under the
 * `u` flag and means nothing outside a character class anyway.
 */
function specifierPattern(specifier) {
  return `/^${specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$/`;
}

/**
 * The `require()` / dynamic-`import()` layer — two selectors per specifier,
 * derived from the same tuple as `FORBIDDEN_SPAWN`.
 *
 * 02-RESEARCH.md § Pitfall 2 reproduced, against this repository's own eslint
 * 10.8.1, that `no-restricted-imports` reports the static form and reports
 * NEITHER of the other two. The attribute paths below (`callee.name`,
 * `arguments.0.value`, `source.value`) are the shapes that pitfall verified
 * working; only the pattern each carries is computed here.
 */
const SPAWN_SYNTAX = FORBIDDEN_SPAWN_SPECIFIERS.flatMap((specifier) => {
  const pattern = specifierPattern(specifier);
  return [
    {
      selector: `CallExpression[callee.name='require'][arguments.0.value=${pattern}]`,
      message: `require('${specifier}'): ${SPAWN_MESSAGE}`,
    },
    {
      selector: `ImportExpression[source.value=${pattern}]`,
      message: `import('${specifier}'): ${SPAWN_MESSAGE}`,
    },
  ];
});

/**
 * The one and only exemption from the spawn ban.
 *
 * It covers the whole package rather than just `src/` because the package's own
 * test suite has to stand up a temp git repository and exercise the exec path
 * to prove any of this works, and success criterion 2's wording is "outside the
 * workspace module" — not "outside the workspace module's source directory".
 *
 * A SECOND entry here makes success criterion 2 false while the rule still
 * looks like it is enforcing something, which is strictly worse than having no
 * rule at all: the build stays green and the boundary is gone.
 */
const WORKSPACE_EXEMPTION = ['packages/workspace/**/*.ts'];

/**
 * The exemption's one carve-out: `simple-git` is banned again inside the
 * workspace package's SOURCE.
 *
 * 02-REVIEW.md CR-01/CR-02 is what this is made of. The package-wide exemption
 * above is correct for `execa` — `packages/workspace/src/exec/run.ts` is the
 * one process launch, and the package's own suite has to stand up temp
 * repositories and exercise it. It was NOT correct for `simple-git`: three
 * modules under `src/` built `simpleGit(...)` handles that spawned `git` with
 * no configuration neutralisation (CR-01) and with the daemon's entire
 * environment, credentials included (CR-02, `simple-git@3.36.0` passes
 * `env: this.env`, which is `undefined` unless `.env()` was called, and
 * `spawn` with `env: undefined` inherits `process.env` in full). Every one of
 * those commands reads `<mainRepo>/.git/config` — the file an agent inside a
 * linked worktree can write.
 *
 * `packages/workspace/src/git/adl-git.ts` is now the only way `src/` reaches
 * `git`, and it goes through `run()` like everything else. This entry is what
 * makes a fourth `simpleGit(...)` in `src/` a red build rather than a review
 * finding.
 *
 * Scoped to `src/` and not the whole package on purpose. `test/helpers/temp-repo.ts`
 * and `test/git/*.test.ts` legitimately hold `simple-git` handles: the fixture
 * needs a git handle that is NOT the subject, and the CR-01/CR-02 control cases
 * exist specifically to show what a bare `simpleGit` child does. A ban that
 * covered the tests would delete the control that proves the ban is worth
 * having.
 *
 * `test/contract/workspace-contract.test.ts` asserts the same property by
 * reading the source tree, so the boundary survives an edit to this file — the
 * same belt-and-braces the registry's sole-construction-site rule already has.
 */
const WORKSPACE_SRC = ['packages/workspace/src/**/*.ts'];

const SIMPLE_GIT_IN_SRC_MESSAGE =
  'simple-git is banned inside packages/workspace/src (02-REVIEW.md CR-01, CR-02). It spawns git with no configuration neutralisation and — because it passes `env: undefined` to spawn unless `.env()` was called — with the daemon\'s ENTIRE environment, forge token and model key included. Every git command ADL runs reads <mainRepo>/.git/config, which is the file an agent inside a linked worktree can write, and git config names programs git executes. Use `adlGit()` from src/git/adl-git.ts: it carries NEUTRALISE_ARGS, the zero-inherit child environment, a forced C locale, and an exit code.';

const WORKSPACE_SRC_RULES = {
  'no-restricted-imports': [
    'error',
    { paths: [{ name: 'simple-git', message: SIMPLE_GIT_IN_SRC_MESSAGE }] },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: `CallExpression[callee.name='require'][arguments.0.value=${specifierPattern('simple-git')}]`,
      message: `require('simple-git'): ${SIMPLE_GIT_IN_SRC_MESSAGE}`,
    },
    {
      selector: `ImportExpression[source.value=${specifierPattern('simple-git')}]`,
      message: `import('simple-git'): ${SIMPLE_GIT_IN_SRC_MESSAGE}`,
    },
  ],
};

/**
 * The complete rule object for every file that is neither `@adl/core` source
 * nor exempt. Core and verdict sources get the same bans merged into THEIR
 * objects below, because a rule may be configured only once per file.
 */
const SPAWN_BAN_RULES = {
  'no-restricted-imports': ['error', { paths: FORBIDDEN_SPAWN }],
  'no-restricted-syntax': ['error', ...SPAWN_SYNTAX],
};

/**
 * The spawn entries `@adl/core` does not already ban. `child_process` in both
 * spellings is on the purity list already, so appending blindly would give core
 * a duplicated restricted path.
 */
const CORE_SPAWN_ADDITIONS = FORBIDDEN_SPAWN.filter(
  (entry) =>
    !FORBIDDEN_CORE_BUILTINS.some((existing) => existing.name === entry.name),
);

/**
 * The `@adl/core` purity and dependency-graph rules.
 *
 * `no-restricted-imports` carries both the builtin ban and the sibling-package
 * ban in ONE entry, deliberately: ESLint allows a single configuration per rule
 * per file, so registering them as two entries would mean the second silently
 * replaced the first — precisely the kind of decorative rule this plan exists
 * to prevent.
 *
 * Phase 2 extends this object rather than registering a second entry over the
 * same glob, for exactly that reason: 02-RESEARCH.md § Pitfall 1 reproduced an
 * overlapping spawn entry silently erasing the `node:fs` ban here, with every
 * existing lint test still passing.
 */
const CORE_PURITY_RULES = {
  'no-restricted-imports': [
    'error',
    {
      paths: [...FORBIDDEN_CORE_BUILTINS, ...CORE_SPAWN_ADDITIONS],
      patterns: FORBIDDEN_CORE_SIBLINGS,
    },
  ],
  'no-restricted-syntax': ['error', ...SPAWN_SYNTAX],
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
 *
 * The spawn selectors are spread in FIRST, and that merge is mandatory rather
 * than tidy: `packages/core/src/verdict/**` is matched by the core entry AND by
 * the verdict entry, and whichever one configures `no-restricted-syntax` last
 * replaces the other outright. Without this line the verdict directory would be
 * the one place in the repository where a dynamic `import('execa')` lints clean.
 */
const VERDICT_SCHEMA_RULES = {
  'no-restricted-syntax': [
    'error',
    ...SPAWN_SYNTAX,
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
  {
    rules: {
      // `const { x: _dropped, ...rest } = obj` is the standard way to
      // produce a copy of `obj` without one field; `_dropped` being
      // "unused" is the point, not an oversight. `ignoreRestSiblings` is
      // typescript-eslint's own documented option for exactly this pattern
      // — it does not weaken detection of genuinely dead variables, params,
      // or imports elsewhere.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true },
      ],
    },
  },
  {
    // `@typescript-eslint/no-require-imports` (from the recommended set) reports
    // `test/lint/fixtures/spawn-require.ts`, whose entire reason for existing is
    // to carry the `require()` call that `no-restricted-syntax` is supposed to
    // ban. Left on, it breaks the negative control — the assertion that each
    // fixture is clean APART FROM the architecture rules — and the control is
    // the only thing proving the positive assertions measure the rules under
    // test rather than an incidental style violation.
    //
    // Turned off for the spawn fixtures ONLY, and for this one rule only. Not
    // globally (real source should keep the rule), and not via an inline
    // disable comment (which could also silence the architecture rule this
    // fixture exists to trip, making the fixture pass while proving nothing).
    name: 'adl/spawn-fixture-require-form',
    files: ['test/lint/fixtures/spawn-*.ts'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
];

/**
 * The architecture rule set, registered against real source and against the
 * fixtures that prove each rule fires.
 */
export const architectureConfigs = [
  {
    // Registered FIRST, and its `ignores` carve out every glob that a later
    // entry configures the same two rules for.
    //
    // Of those two, the CARVE-OUTS are what actually protect Phase 1's bans —
    // confirmed during execution by moving this entry to the end of the array
    // with the ignores intact, which changed nothing, and then dropping the
    // `packages/core/src/**` carve-out, which deleted the `node:fs` purity ban
    // from the verdict sources while `pnpm lint` stayed green (02-RESEARCH.md
    // § Pitfall 1). The regression guard in the lint suite is the only thing
    // that caught it. Keeping the entry first is therefore about reading order,
    // not enforcement: do not treat the position as the safety mechanism.
    name: 'adl/no-direct-spawn',
    files: ['**/*.ts'],
    ignores: [
      ...WORKSPACE_EXEMPTION,
      'packages/core/src/**/*.ts',
      'test/lint/fixtures/core-*.ts',
      'test/lint/fixtures/verdict-*.ts',
    ],
    rules: SPAWN_BAN_RULES,
  },
  {
    // The carve-out inside the one exemption. No other entry configures either
    // of these two rules for this glob — `adl/no-direct-spawn` above ignores
    // the whole workspace package — so this adds a configuration rather than
    // replacing one, which is the distinction 02-RESEARCH.md § Pitfall 1 is
    // about. `test/lint/no-restricted-imports.test.ts` asserts the RESOLVED
    // options for a real source path under it, so that stays true by
    // measurement rather than by reading.
    name: 'adl/no-simple-git-in-workspace-src',
    files: WORKSPACE_SRC,
    rules: WORKSPACE_SRC_RULES,
  },
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
  {
    name: 'adl/no-direct-spawn-fixtures',
    files: ['test/lint/fixtures/spawn-*.ts'],
    rules: SPAWN_BAN_RULES,
  },
];

export default [...baseConfigs, ...architectureConfigs];
