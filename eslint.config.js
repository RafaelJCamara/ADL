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

/**
 * Every extension a TypeScript module in this repository may carry.
 *
 * ── Why this exists, and why it is one constant rather than four literals ──
 *
 * Every entry below used to be registered with `files: ['**\/*.ts']`. That glob
 * does NOT match `.mts`, `.cts` or `.tsx` — minimatch's `*.ts` is an exact
 * suffix, not a prefix of the extension — so a module outside
 * `packages/workspace` could `import { execa } from 'execa'` from a `.mts` file
 * and `pnpm lint` stayed green. 02-VERIFICATION.md demonstrated it rather than
 * inferring it: a probe at `packages/db/src/probe.mts` reported ZERO
 * architecture errors while `@typescript-eslint/no-unused-vars` fired on the
 * same file, proving ESLint had processed it and the rule had simply never
 * matched. Reproduced again at the start of this fix, byte for byte.
 *
 * The runtime property was true anyway, because the repository happens to
 * contain only `.ts`. That is precisely what made it dangerous: success
 * criterion 2's rule is described three paragraphs up as "a BUILD property, not
 * a review property", and a build property that holds because of a file-naming
 * coincidence is a review property wearing the rule's clothes. The FIRST `.mts`
 * anybody adds — and `execa@10` being ESM-only makes that likelier here than in
 * most repositories — silently leaves the boundary.
 *
 * So the extension set is named ONCE. A fifth TypeScript extension is one edit,
 * and it cannot reach the ban without also reaching the exemption and the
 * carve-outs — which is the failure this constant is really guarding against,
 * because a widened ban with an un-widened exemption would make
 * `packages/workspace/src/exec/run.ts`'s sibling `.mts` a lint error rather than
 * a hole, and a widened exemption with an un-widened carve-out would reopen
 * CR-01 for one extension.
 *
 * This tuple is the TYPESCRIPT half of {@link MODULE_SOURCE_EXTENSIONS}, which
 * is what the globs are actually built from. It stays a separate named constant
 * rather than growing three JavaScript entries because `.mjs` is not a spelling
 * of TypeScript, and a constant called `TS_SOURCE_EXTENSIONS` that contained
 * `mjs` would be the same category of quiet lie this file exists to remove.
 *
 * Exported so the lint suite can name the same set independently.
 * `test/lint/no-restricted-imports.test.ts` deliberately restates the
 * extensions as a literal instead of importing this, for the reason that file's
 * `anchoredPattern` already gives: the assertions have to be able to DISAGREE
 * with the config. Driving them off this tuple would mean deleting an extension
 * here also deleted its own proof.
 */
export const TS_SOURCE_EXTENSIONS = Object.freeze(['ts', 'tsx', 'mts', 'cts']);

/**
 * Every extension a JavaScript module in this repository may carry.
 *
 * ── Why the architecture rules reach JavaScript at all ────────────────────
 *
 * The set above closed the `.mts`/`.cts`/`.tsx` gap and left an exactly
 * analogous one behind: 02-VERIFICATION.md demonstrated at `84d1d16` that
 * `packages/db/src/probe.mjs` containing `import { execa } from 'execa'`
 * reported ZERO architecture errors. The verifier declined to score that as a
 * failure of success criterion 2, and the reasoning was sound as far as it went
 * — no tsconfig compiles a `.mjs`, the only two JavaScript files in the
 * repository are `eslint.config.js` itself and one test helper already inside
 * the workspace exemption, and unlike the gap it replaced the scope was NAMED
 * rather than an invisible coincidence spread over six literals.
 *
 * It is fixed anyway, because the argument written twenty lines above applies
 * verbatim and the verifier said so: a build property that holds because of a
 * file-naming coincidence is a review property wearing the rule's clothes. "No
 * `.mjs` exists yet" is a fact about today's `git ls-files`, not a property of
 * the boundary. `execa@10` is ESM-only and every agent backend in the ROADMAP
 * is a subprocess, so the file that finally reaches for it has more than one
 * plausible extension. A `.mjs` that spawns a process bypasses the zero-inherit
 * environment, the scratch HOME, the privilege drop and the git-config
 * neutralisation exactly as thoroughly as a `.ts` that spawns one; the OS
 * process table does not ask what the file was called.
 *
 * `.jsx` is deliberately absent. Nothing in the repository or the ROADMAP emits
 * it — the dashboard is `.tsx` — and an extension listed here that no toolchain
 * produces is a glob nobody can ever watch fail.
 */
export const JS_SOURCE_EXTENSIONS = Object.freeze(['js', 'mjs', 'cjs']);

/**
 * The union, and the set every architecture glob in this file is built from.
 *
 * Every entry below takes THIS set, not one half of it. That is a decision per
 * rule rather than a blanket, and the reasoning differs:
 *
 * - **the spawn ban** and **the workspace exemption** — the union, because the
 *   harm is a process reaching the OS, which is extension-blind. These two also
 *   MUST move together in both directions: a ban wider than its exemption makes
 *   a `.mjs` beside `run.ts` a lint error, and an exemption wider than its ban
 *   is a second exemption in disguise.
 * - **`adl/no-simple-git-in-workspace-src`** (the CR-01 carve-out) — the union.
 *   A `.mjs` under `src/` building a `simpleGit` handle spawns git with the
 *   daemon's entire environment and no neutralisation, which is the whole of
 *   CR-02 regardless of spelling. It must move with the exemption too, or a
 *   widened exemption reopens CR-01 for the extensions it just gained.
 * - **`adl/core-purity`** — the union, and here the coupling is decisive rather
 *   than merely tidy. The purity entry's glob and the spawn ban's `ignores` for
 *   the same glob are the same boundary seen from two sides. Widening the ban
 *   while leaving purity on TypeScript would leave a `packages/core/src/*.mjs`
 *   ignored by the ban AND unmatched by purity — governed by nothing at all,
 *   which is strictly worse than the hole being fixed.
 * - **`adl/verdict-schema`** — the union, on the merits rather than on coupling.
 *   The coupling argument is weaker here (a narrow verdict entry would leave a
 *   `.mjs` under `verdict/` holding core's rules, which is a missing refinement
 *   ban rather than an unguarded file), but the harm the rule prevents — a
 *   published JSON Schema strictly weaker than the one `parse()` enforces — does
 *   not care what the module was named either.
 * - **the four `*-fixtures` entries and `adl/spawn-fixture-require-form`** — the
 *   union, so a JavaScript fixture is governed by the same rule objects as real
 *   source. That is the entire point of the fixture arrangement described at the
 *   top of this file.
 *
 * The result is that no architecture rule in this repository is scoped to a
 * narrower extension set than any other, so none of them can drift apart.
 */
export const MODULE_SOURCE_EXTENSIONS = Object.freeze([
  ...TS_SOURCE_EXTENSIONS,
  ...JS_SOURCE_EXTENSIONS,
]);

/** The brace expansion the globs below are built from. */
const MODULE = `{${MODULE_SOURCE_EXTENSIONS.join(',')}}`;

/**
 * Attach the extension set to a glob stem.
 *
 * `mod('packages/core/src/[star][star]/[star]')` yields
 * `packages/core/src/[star][star]/[star].{ts,tsx,mts,cts,js,mjs,cjs}`, and
 * `mod('test/lint/fixtures/spawn-[star]')` yields
 * `test/lint/fixtures/spawn-[star].{ts,tsx,mts,cts,js,mjs,cjs}` — so directory
 * globs and filename-prefix globs are built the same way and cannot drift apart.
 *
 * There is deliberately NO TypeScript-only counterpart to this helper. One
 * existing would be an invitation to scope a future rule to half the set, which
 * is the defect this whole section is the fix for.
 */
function mod(stem) {
  return `${stem}.${MODULE}`;
}

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
 * 03-04 / D-01: the worker never opens the database — the manager is the
 * only writer, which `schema.ts`'s header comment states and this rule keeps
 * literally true. A second writer into the SQLite file would invalidate the
 * single-writer reasoning the lease-table-instead-of-Redis choice rests on
 * (`.claude/CLAUDE.md` § "No Redis. No Postgres."). Send state to the
 * manager over the `fork()` IPC channel instead (`packages/manager/src/ipc/protocol.ts`).
 */
const WORKER_ENTRY_DB_BAN_MESSAGE =
  "@adl/db is banned inside packages/manager/src/worker-entry (D-01): the manager is the only writer to the database, and this ban is what keeps that literally true now that the worker lives inside @adl/manager, which depends on @adl/db as a real dependency (D-21's two-package split means pnpm's strict node_modules can no longer enforce this structurally on its own). A second writer into the SQLite file invalidates the single-writer reasoning the lease-table-instead-of-Redis choice rests on. Report state to the manager over the fork() IPC channel (packages/manager/src/ipc/protocol.ts) instead.";

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

/* ══════════════════════════════════════════════════════════════════════════
 * `adl/no-forge-merge` — FORGE-10, M05 step 5.12
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `docs/plan/DECISIONS.md`: **"Human approves and merges the PR. ADL never
 * merges."** Also listed under "Explicitly out of scope for v1". The milestone
 * sets the standard: *prefer "the adapter has no merge method" over "we don't
 * call it"* — and `@adl/core/forge`'s `FORGE_ADAPTER_MEMBERS` is that
 * preferred guard, with a compile-time exhaustiveness proof behind it.
 *
 * This rule closes the residual that guard structurally cannot reach. A forge
 * adapter does not merge by calling the port — it merges by calling the FORGE,
 * and `packages/forge-github` holds a live `octokit` whose
 * `rest.pulls.merge()` exists no matter what ADL's own interface declares.
 * `getPushToken` is the standing proof that a forge package legitimately
 * reaches past the neutral port when it has to, so "the port has no merge
 * method" is not, by itself, the property FORGE-10 asks for.
 *
 * ── Why a vocabulary list rather than a search for "merge" ────────────────
 *
 * GitLab's client spells this operation `accept` and
 * `mergeWhenPipelineSucceeds`; neither reads as a merge in a diff. And the
 * inverse matters just as much: `ChangeRequestState` legitimately contains
 * `'merged'`, `packages/forge-github/src/backend.ts` reads `pr.merged_at` and
 * compares against `'MERGED'`, and a blanket ban on the substring would either
 * flag all three or be switched off. Every selector below was verified
 * empirically against this repository's own eslint before it was written —
 * each of the eight real merge shapes fires, and `merged_at` / `'merged'` /
 * `'MERGED'` / `markPullRequestReadyForReview` fire on none of them.
 *
 * Scoped to `packages/forge-*` because that is where a forge client lives.
 * The glob names a package prefix rather than the one package that exists
 * today, so `packages/forge-gitlab` and `packages/forge-gitea` (M14) are
 * governed on the day they are created — the D-27 property of landing the
 * rule before the thing it would have prevented.
 */

/**
 * Method names that merge a change request, across every forge in scope.
 *
 * Banned as MEMBER EXPRESSIONS rather than call expressions, deliberately:
 * `const m = octokit.rest.pulls.merge; await m({...})` is a call-expression
 * selector's blind spot and an obvious way to arrive at a merge by accident
 * while refactoring. Taking the reference is banned, so there is nothing to
 * call later.
 *
 * `accept` is GitLab's spelling and is here for that reason alone. It is the
 * broadest entry in the list, and that is the intended trade: a forge adapter
 * with a non-merge method named `accept` is rare, a forge adapter that merges
 * through one is FORGE-10 being violated, and the ban failing loudly on the
 * rare case is the safe direction for a guard.
 *
 * Exported so `test/lint/no-restricted-imports.test.ts` can iterate it — a
 * verb added here gains its resolved-config assertion automatically, and a
 * verb whose selector is lost goes red without anyone remembering to add a
 * case.
 */
export const FORGE_MERGE_MEMBERS = Object.freeze([
  'merge',
  'mergePullRequest',
  'enablePullRequestAutoMerge',
  'mergeWhenPipelineSucceeds',
  'accept',
]);

/**
 * The same operation reached as a STRING rather than as a method — the two
 * forms a member-name ban cannot see.
 *
 * `octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge')`
 * names the REST route directly, and `octokit.graphql(...)` carries the
 * mutation name inside a template literal or a plain string, where it is
 * opaque to every AST selector that looks at identifiers. Each pattern is
 * anchored precisely — `\/merge$` matches a route suffix and not the word
 * `merged`, and the two mutation names are `\b`-bounded — because an
 * over-broad string ban here is the one that gets switched off.
 *
 * Each entry is `[label, regexSource]`: the label is what a message names, so
 * a report says which merge route was reached rather than printing a regex.
 */
export const FORGE_MERGE_ROUTES = Object.freeze([
  ['a REST merge route', '\\/merge$'],
  ['the mergePullRequest GraphQL mutation', '\\bmergePullRequest\\b'],
  [
    'the enablePullRequestAutoMerge GraphQL mutation',
    '\\benablePullRequestAutoMerge\\b',
  ],
]);

const FORGE_MERGE_MESSAGE =
  'ADL never merges (FORGE-10, docs/plan/DECISIONS.md: "Human approves and merges the PR"). A human approves and merges the change request; an unattended loop with write access to the target branch is not acceptable in v1, and it is the one failure a team cannot undo by closing a pull request. The neutral port declares no merge method either (@adl/core/forge\'s FORGE_ADAPTER_MEMBERS, proven exhaustive at compile time) — this rule is what stops an adapter reaching around it through the forge client it already holds. Promote the draft to ready with promoteToReady() and stop there.';

/**
 * Two selector families derived from the two tuples above, so the member layer
 * and the string layer cannot come to cover different vocabularies — the same
 * derivation, for the same reason, as `SPAWN_SYNTAX` above.
 *
 * `enablePullRequestAutoMerge` is worth one extra sentence: it is a merge that
 * happens AFTER this process exits, so nothing in ADL's own logs, transcripts
 * or accounting would record the moment the branch landed. A guard that caught
 * the immediate form and not the deferred one would be worse than none, since
 * the deferred one is the version somebody reaches for when the immediate one
 * is refused.
 */
const FORGE_MERGE_SYNTAX = [
  ...FORGE_MERGE_MEMBERS.map((member) => ({
    selector: `MemberExpression[property.name='${member}']`,
    message: `.${member}: ${FORGE_MERGE_MESSAGE}`,
  })),
  ...FORGE_MERGE_ROUTES.flatMap(([label, source]) => [
    {
      selector: `Literal[value=/${source}/]`,
      message: `${label}: ${FORGE_MERGE_MESSAGE}`,
    },
    {
      selector: `TemplateElement[value.raw=/${source}/]`,
      message: `${label}: ${FORGE_MERGE_MESSAGE}`,
    },
  ]),
];

/**
 * Forge adapter packages — the glob, and the only place a forge client lives.
 * The whole package rather than `src/`, because a test that merges is a test
 * that merged a real change request on somebody's repository.
 */
const FORGE_PACKAGES = [mod('packages/forge-*/**/*')];

/**
 * The rule object, with `SPAWN_SYNTAX` spread in FIRST — mandatory, not tidy.
 *
 * `adl/no-direct-spawn` matches `packages/forge-*` too (it is registered for
 * `**\/*` and does not ignore them), and flat config REPLACES rather than merges
 * per rule id for an overlapping glob (02-RESEARCH.md § Pitfall 1). Without
 * this line, adding the merge ban would silently delete the spawn ban's
 * `require()` / dynamic-`import()` layer from every forge package — a package
 * that talks HTTP and must never talk to a subprocess (WORK-02, and `forge.ts`'s
 * own docblock says so explicitly). `no-restricted-imports` is deliberately
 * NOT configured here, so the static-import half keeps resolving from
 * `adl/no-direct-spawn`; `test/lint/no-restricted-imports.test.ts` asserts both
 * halves survive at a real forge source path.
 */
const FORGE_MERGE_RULES = {
  'no-restricted-syntax': ['error', ...SPAWN_SYNTAX, ...FORGE_MERGE_SYNTAX],
};

/* ══════════════════════════════════════════════════════════════════════════
 * `adl/gate-fresh-context` — ROLE-03, M05 step 5.17
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ROLE-03: *"Reviewer works from fresh context — it never inherits the
 * developer's session, transcript, or reasoning."* M05's AC3 fixes the
 * mechanism: *"Gate context is assembled from spec, diff and repository only;
 * the developer's session and transcript are structurally unreachable."*
 *
 * The **preferred** guard is the type, and it exists:
 * `@adl/core/stage`'s `GateContext` has no member through which a session, a
 * transcript, a transcript root, a rendered prompt, or a send-back brief can be
 * named, and `GATE_CONTEXT_MEMBERS` proves that list complete at compile time
 * with `packages/core/test/stage/gate-context.test.ts` rejecting a forbidden
 * name in it. `packages/manager/src/worker-entry/gate-context.ts` is the single
 * place an `AssignMessage` — which carries every one of those — is narrowed
 * down to that type.
 *
 * This rule closes the residual that guard structurally cannot reach, and it is
 * the same residual, in the same shape, that `adl/no-forge-merge` exists for
 * (5.12): a gate does not have to arrive at the developer's transcript through
 * its parameters. It can `import { transcriptPathFor } from
 * '../../store/transcript-path.js'` and build the path itself out of ids it
 * legitimately knows. A parameter list cannot stop that; a module boundary can.
 *
 * ── Scoped to a DIRECTORY, not a filename convention ──────────────────────
 *
 * `packages/manager/src/worker-entry/gates/**` — a gate is a file in that
 * directory, which is a place rather than a name, so a future reviewer gate
 * that happens not to be called `*-gate.ts` is still governed. It names the
 * directory rather than the one file in it today for D-27's reason, the same
 * one `packages/forge-*`'s package prefix rests on: the rule that lands before
 * the thing it would have prevented is the only kind that prevents it. M07's
 * reviewer and M08's behaviour tester are the things.
 *
 * ── Verified empirically before it was written (convention 15) ────────────
 *
 * A throwaway probe against this repository's own eslint confirmed each of the
 * following, and two of them changed what got written:
 *
 * 1. `no-restricted-imports`' `patterns` **does** match RELATIVE specifiers —
 *    `'../../store/transcript-path.js'` is reported by the group `**\/store/*`.
 *    The documented examples only ever show bare package names, so this was not
 *    safe to assume.
 * 2. `MemberExpression[property.name=…]` alone is **not enough**:
 *    `const { logsRoot } = assign` lints clean under it. That is the same class
 *    of blind spot `adl/no-forge-merge` documents for call expressions, and it
 *    is why {@link GATE_FRESH_CONTEXT_SYNTAX} bans `Property[key.name=…]` too.
 * 3. `a['logsRoot']` is clean under both, so the computed form is banned
 *    separately.
 * 4. `@adl/core/loop`, `@adl/core/stage`, `../../ipc/stage-verdict.js` and
 *    `./sibling.js` are clean under every pattern here — the ban is precise,
 *    not a blanket on relative imports.
 *
 * **The one residual this rule cannot reach** is a fully dynamic property name
 * (`a[k]` where `k` is a variable), which no static selector can see. Stated
 * rather than left for a reader to discover: the type is the primary guard and
 * this is defence in depth, not the other way round.
 */

/**
 * How the developer's session, transcript, or reasoning is spelled in this
 * codebase — every name a gate could read one through.
 *
 * Each entry is a real field on a real type a worker holds, not a hypothetical:
 *
 * | Name | Declared on | What reading it would give a gate |
 * |---|---|---|
 * | `logsRoot` | `AssignMessage` | the root every transcript is addressed under — plus `roundId`/`stageId`, which a gate legitimately knows, that is a path |
 * | `sessionRef` | `AgentTask`, `AgentRunResult`, `AgentStartedEvent` | the backend's opaque resumable session — the developer's conversation, verbatim |
 * | `sendBackBriefJson` | `AssignMessage` | a prior round's findings: not spec, not diff, not repository |
 * | `stageAttemptId` | `AssignMessage` | the transcript's own join key |
 * | `systemPrompt` / `instructions` | `AgentTask` | what the developer was asked — its reasoning's input |
 *
 * `roundId` is deliberately **absent**: a gate needs to know which round it is
 * in for its own fingerprinting and logging, and banning it would flag the
 * legitimate use while the transcript still needs `logsRoot` — which is banned
 * — to be reachable at all. Banning the field that is never legitimate beats
 * banning the field that usually is.
 *
 * Exported so `test/lint/no-restricted-imports.test.ts` can iterate it: a name
 * added here gains its resolved-config assertion automatically, and a name
 * whose selector is lost goes red without anyone remembering to add a case.
 */
export const GATE_FORBIDDEN_MEMBERS = Object.freeze([
  'logsRoot',
  'sessionRef',
  'sendBackBriefJson',
  'stageAttemptId',
]);

/**
 * Names a gate may **compose** but must never **read** (M07 step 7.4).
 *
 * These two were in the list above until the reviewer needed to exist, and the
 * distinction they now sit on is real rather than a concession. `systemPrompt`
 * and `instructions` are the two required fields of `AgentTask` — and M07 step
 * 7.1 put `agents: AgentRunner` on `GateContext`, so an agent-backed gate
 * cannot invoke a model at all without writing an object literal carrying
 * both. A ban that made the reviewer impossible would not be enforcing
 * ROLE-03; it would be enforcing "there is no reviewer".
 *
 * What ROLE-03 actually forbids is a gate arriving at the **developer's**
 * rendered prompt, and that is always a *read*: `task.systemPrompt`,
 * `const { instructions } = x`, `x['systemPrompt']`. Every one of those stays
 * banned below. Building your own is a write, and a gate composing its own
 * instructions has learned nothing about anyone else's.
 *
 * **The two forms are distinguishable, and that was verified before this was
 * written** (convention 15): a throwaway eslint probe confirmed
 * `ObjectExpression > Property[key.name=…]` reports an object literal while
 * `ObjectPattern > Property[key.name=…]` reports destructuring, with
 * `MemberExpression` and its computed form covering the remaining two reads.
 * The bare `Property[key.name=…]` the list above uses matches both, which is
 * exactly why these names could not stay in it.
 */
export const GATE_COMPOSE_ONLY_MEMBERS = Object.freeze([
  'systemPrompt',
  'instructions',
]);

/**
 * The modules a gate may not import, as `no-restricted-imports` pattern groups.
 *
 * Relative globs, because a gate's imports of these are relative — see probe
 * finding 1 above. Each group is the *directory* rather than the file, so a
 * second transcript reader or a second prompt renderer added later is covered
 * on the day it lands rather than on the day someone remembers this list.
 *
 * `ipc/protocol.js` is named as a single file on purpose: `ipc/stage-verdict.js`
 * lives beside it and is exactly what a gate must import — it is the envelope a
 * gate's own answer travels home in. A directory ban would take both.
 */
export const GATE_FORBIDDEN_IMPORT_GROUPS = Object.freeze([
  ['**/store/*', 'the transcript store'],
  ['**/prompt/*', 'the prompt builder and its artifact writer'],
  ['**/loop/*', "the manager's own round-loop modules"],
  ['**/ipc/protocol.js', 'the AssignMessage envelope'],
]);

const GATE_FRESH_CONTEXT_MESSAGE =
  "is not gate context (ROLE-03, M05 AC3: gate context is assembled from spec, diff and repository ONLY). A gate works from fresh context and never inherits the developer's session, transcript, or reasoning — `docs/plan/DECISIONS.md` records the measured reason: models exploit conflicting tests up to 76% of the time, and a reviewer handed the developer's own argument for why a test is wrong is a reviewer handed the argument for agreeing with it. Everything a gate may see is on @adl/core/stage's GateContext, which packages/manager/src/worker-entry/gate-context.ts builds by narrowing the assign message. If a gate needs something new, ask which of spec, diff or repository it comes from — and if the answer is none of them, it does not belong to a gate.";

/**
 * Three selector families per forbidden name, derived from the one tuple so
 * they cannot come to cover different vocabularies — the same derivation, for
 * the same reason, as `SPAWN_SYNTAX` and `FORGE_MERGE_SYNTAX` above.
 *
 * `Property[key.name=…]` is the one that is easy to leave out and the one probe
 * finding 2 says is load-bearing: it catches `const { logsRoot } = x`,
 * `function f({ logsRoot })`, `const { logsRoot: root } = x`, and building an
 * object literal with that key. All four are ways to arrive at the value
 * without ever writing a member expression.
 */
const GATE_FRESH_CONTEXT_SYNTAX = [
  ...GATE_FORBIDDEN_MEMBERS.flatMap((member) => [
    {
      selector: `MemberExpression[property.name='${member}']`,
      message: `.${member} ${GATE_FRESH_CONTEXT_MESSAGE}`,
    },
    {
      selector: `Property[key.name='${member}']`,
      message: `${member} (destructured or as an object key) ${GATE_FRESH_CONTEXT_MESSAGE}`,
    },
    {
      selector: `MemberExpression[computed=true][property.value='${member}']`,
      message: `['${member}'] ${GATE_FRESH_CONTEXT_MESSAGE}`,
    },
  ]),
  // Read-banned, compose-allowed. Same three read forms as above, minus the
  // bare `Property[key.name=…]` — replaced by `ObjectPattern > Property`, which
  // is destructuring only, so an `ObjectExpression` building an `AgentTask`
  // passes. See GATE_COMPOSE_ONLY_MEMBERS for why the split exists and for the
  // probe that established the two are distinguishable.
  ...GATE_COMPOSE_ONLY_MEMBERS.flatMap((member) => [
    {
      selector: `MemberExpression[property.name='${member}']`,
      message: `.${member} ${GATE_FRESH_CONTEXT_MESSAGE}`,
    },
    {
      selector: `ObjectPattern > Property[key.name='${member}']`,
      message: `${member} (destructured off something else) ${GATE_FRESH_CONTEXT_MESSAGE} A gate may BUILD its own ${member} — that is an object literal, and it is allowed — but never read one.`,
    },
    {
      selector: `MemberExpression[computed=true][property.value='${member}']`,
      message: `['${member}'] ${GATE_FRESH_CONTEXT_MESSAGE}`,
    },
  ]),
];

/** Where a gate implementation lives. See the block comment above for why a directory. */
const GATE_PACKAGES = [
  mod('packages/manager/src/worker-entry/gates/**/*'),
  mod('test/lint/fixtures/gate-*'),
];

/**
 * The rule object — and BOTH merges below are mandatory rather than tidy.
 *
 * This glob is matched by two entries that already configure these rule ids,
 * and flat config REPLACES rather than merges per rule id for an overlapping
 * glob (02-RESEARCH.md § Pitfall 1):
 *
 * - `adl/no-direct-spawn` (`files: ['**\/*']`) configures BOTH
 *   `no-restricted-imports` (via `FORBIDDEN_SPAWN`) and `no-restricted-syntax`
 *   (via `SPAWN_SYNTAX`). Omitting either would make `worker-entry/gates/` the
 *   one place in the repository a direct `execa` import lints clean.
 * - `adl/worker-entry-no-db` (`files: ['packages/manager/src/worker-entry/**\/*']`)
 *   configures `no-restricted-imports` with the `@adl/db` ban. `gates/` is
 *   *inside* that directory, so omitting this would lift D-01's database ban for
 *   exactly the files it matters most on — a gate that could open the database
 *   could read `stage_attempts` and reach a transcript address that way, which
 *   is this rule's own property defeated through the hole this rule opened.
 *
 * `test/lint/no-restricted-imports.test.ts` asserts all three layers survive at
 * a real gate source path, by reading the RESOLVED config rather than this
 * source — flat-config rule replacement is invisible to a source-level read.
 */
const GATE_FRESH_CONTEXT_RULES = {
  'no-restricted-imports': [
    'error',
    {
      paths: [
        ...FORBIDDEN_SPAWN,
        { name: '@adl/db', message: WORKER_ENTRY_DB_BAN_MESSAGE },
      ],
      patterns: [
        { group: ['@adl/db/*'], message: WORKER_ENTRY_DB_BAN_MESSAGE },
        ...GATE_FORBIDDEN_IMPORT_GROUPS.map(([group, label]) => ({
          group: [group],
          message: `${label} ${GATE_FRESH_CONTEXT_MESSAGE}`,
        })),
      ],
    },
  ],
  'no-restricted-syntax': [
    'error',
    ...SPAWN_SYNTAX,
    ...GATE_FRESH_CONTEXT_SYNTAX,
  ],
};

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
 *
 * The extension set is {@link MODULE_SOURCE_EXTENSIONS} — the FULL union, the
 * same one the ban above takes — for the reason recorded there: an exemption
 * narrower than the ban would make a `.mts` or a `.mjs` inside this package a
 * lint error, and one wider would be a second exemption in disguise. The two
 * move together or not at all.
 *
 * This is also where the exemption is actually OBSERVABLE, which is not where
 * you would look. `adl/no-simple-git-in-workspace-src` is registered after the
 * ban and reconfigures the same two rule ids for everything under `src/`, and
 * flat config replaces rather than merges — so under `src/` the exemption's
 * effect is overwritten and invisible. `packages/workspace/test/**` is the only
 * place a narrowed exemption shows up at all, and it is where
 * `test/lint/no-restricted-imports.test.ts` measures it. See that file's
 * `WORKSPACE_TEST_SOURCE` docblock.
 */
/**
 * Exported (03-03) so `test/lint/no-restricted-imports.test.ts` can count the
 * flat-config entries that clear the spawn rules by VALUE rather than by a
 * hand-copied glob string that could silently drift from this one. ESLint
 * itself loads only the default export at the bottom of this file, so this
 * changes nothing about resolution — the same reasoning
 * `FORBIDDEN_SPAWN_SPECIFIERS`'s own export comment already gives.
 */
export const WORKSPACE_EXEMPTION = [mod('packages/workspace/**/*')];

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
 * That walker takes {@link MODULE_SOURCE_EXTENSIONS} too, and must: a backstop
 * that exists BECAUSE this file can be edited is worthless on the one extension
 * this file governs and it does not, since the combination "someone edits the
 * lint config" plus "a `.mjs` under src/" would then leave no evidence at all.
 */
const WORKSPACE_SRC = [mod('packages/workspace/src/**/*')];

const SIMPLE_GIT_IN_SRC_MESSAGE =
  "simple-git is banned inside packages/workspace/src (02-REVIEW.md CR-01, CR-02). It spawns git with no configuration neutralisation and — because it passes `env: undefined` to spawn unless `.env()` was called — with the daemon's ENTIRE environment, forge token and model key included. Every git command ADL runs reads <mainRepo>/.git/config, which is the file an agent inside a linked worktree can write, and git config names programs git executes. Use `adlGit()` from src/git/adl-git.ts: it carries NEUTRALISE_ARGS, the zero-inherit child environment, a forced C locale, and an exit code.";

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
    files: [mod('test/lint/fixtures/spawn-*')],
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
    files: [mod('**/*')],
    ignores: [
      ...WORKSPACE_EXEMPTION,
      mod('packages/core/src/**/*'),
      mod('test/lint/fixtures/core-*'),
      mod('test/lint/fixtures/verdict-*'),
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
    files: [mod('packages/core/src/**/*')],
    rules: CORE_PURITY_RULES,
  },
  {
    name: 'adl/core-purity-fixtures',
    files: [mod('test/lint/fixtures/core-*')],
    rules: CORE_PURITY_RULES,
  },
  {
    name: 'adl/verdict-schema',
    files: [mod('packages/core/src/verdict/**/*')],
    rules: VERDICT_SCHEMA_RULES,
  },
  {
    name: 'adl/verdict-schema-fixtures',
    files: [mod('test/lint/fixtures/verdict-*')],
    rules: VERDICT_SCHEMA_RULES,
  },
  {
    name: 'adl/no-direct-spawn-fixtures',
    files: [mod('test/lint/fixtures/spawn-*')],
    rules: SPAWN_BAN_RULES,
  },
  {
    // FORGE-10 / 5.12 — see FORGE_MERGE_MEMBERS above for the full reasoning.
    // Registered against the forge packages and against the fixture that
    // proves each selector fires, exactly like every other rule in this file:
    // the fixture exercises the same rule OBJECT the real adapters are linted
    // with, rather than a parallel copy that can drift out of agreement.
    name: 'adl/no-forge-merge',
    files: [...FORGE_PACKAGES, mod('test/lint/fixtures/forge-*')],
    rules: FORGE_MERGE_RULES,
  },
  {
    // D-01 / 03-04: the worker never opens the database — the manager is the
    // only writer, and `@adl/db` staying out of the worker's dependency graph
    // is what `schema.ts`'s header comment claims literally rather than
    // aspirationally. That used to be enforced structurally by pnpm's strict
    // `node_modules`, the way `adl/core-purity`'s sibling ban still is for
    // `@adl/core` — but D-21 fixes the package count at two and
    // `03-PATTERNS.md` places the worker entry INSIDE `@adl/manager`, which
    // depends on `@adl/db` as a real production dependency. The module
    // resolves from anywhere in the package once that dependency exists, so
    // the guarantee needs a rule of its own, "in the spirit of D-27"
    // (03-CONTEXT.md's own words for this gap).
    //
    // `paths` merges in `FORBIDDEN_SPAWN` rather than naming only `@adl/db`:
    // this entry configures `no-restricted-imports` for a glob
    // `adl/no-direct-spawn` above ALSO matches (`packages/manager/src` is not
    // in that rule's `ignores`), and flat config REPLACES rather than merges
    // per rule id for an overlapping glob (02-RESEARCH.md § Pitfall 1). Not
    // merging the spawn paths in here would silently lift the spawn ban for
    // worker-entry's static imports the moment this entry landed — exactly
    // the failure mode `adl/core-purity` already guards against for
    // `@adl/core`. `no-restricted-syntax` (the require()/dynamic-import
    // layer) is untouched by this entry, so it keeps resolving from
    // `adl/no-direct-spawn` above.
    name: 'adl/worker-entry-no-db',
    files: [
      mod('packages/manager/src/worker-entry/**/*'),
      mod('test/lint/fixtures/worker-entry-*'),
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...FORBIDDEN_SPAWN,
            {
              name: '@adl/db',
              message: WORKER_ENTRY_DB_BAN_MESSAGE,
            },
          ],
          patterns: [
            { group: ['@adl/db/*'], message: WORKER_ENTRY_DB_BAN_MESSAGE },
          ],
        },
      ],
    },
  },
  {
    // ROLE-03 / 5.17 — see GATE_FORBIDDEN_MEMBERS above for the full reasoning.
    //
    // Registered LAST, and that position IS the enforcement here, unlike
    // `adl/no-direct-spawn`'s (whose own comment says its position is about
    // reading order). `packages/manager/src/worker-entry/gates/**` is a strict
    // subset of `adl/worker-entry-no-db`'s glob, and flat config resolves per
    // rule id by LAST match — so this entry has to come after it to take
    // effect at all, and `GATE_FRESH_CONTEXT_RULES` has to re-merge that
    // entry's `@adl/db` ban because winning means replacing it. Moving this
    // above `adl/worker-entry-no-db` would silently switch the whole rule off
    // while leaving it looking configured; `test/lint/no-restricted-imports.test.ts`
    // measures the resolved options rather than reading this file, which is
    // what makes that observable instead of arguable.
    name: 'adl/gate-fresh-context',
    files: GATE_PACKAGES,
    rules: GATE_FRESH_CONTEXT_RULES,
  },
];

export default [...baseConfigs, ...architectureConfigs];
