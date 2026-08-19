import * as path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import {
  ARCHITECTURE_RULE_IDS,
  FORBIDDEN_SPAWN_SPECIFIERS,
  WORKSPACE_EXEMPTION,
  architectureConfigs,
  baseConfigs,
} from '../../eslint.config.js';

/**
 * The point of this file is 01-RESEARCH.md § Pitfall 8: a `no-restricted-*`
 * rule that nobody has watched fail is a rule that ships mis-scoped, and Phase 2
 * discovers it was decorative all along. Every architecture rule this repository
 * registers is therefore exercised here against a committed fixture that
 * deliberately violates it.
 *
 * Three things are asserted, and all three are load-bearing:
 *
 *  1. Each fixture, linted with the repository's REAL `eslint.config.js`,
 *     reports at least one message at severity 2 from the expected rule.
 *  2. The negative control — the same four fixtures linted with the
 *     architecture rule set removed — reports zero errors. Without this, a
 *     fixture that failed for an unrelated reason (a typo, an unused variable)
 *     would make assertion 1 pass while proving nothing at all.
 *  3. Every architecture rule resolves to severity `error`, read out of the
 *     resolved config rather than string-matched from the config file. A rule at
 *     `warn` does not fail CI and therefore does not enforce anything.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CONFIG_FILE = path.join(REPO_ROOT, 'eslint.config.js');

interface FixtureCase {
  /** Repository-relative path, so failures name something greppable. */
  readonly file: string;
  /** The architecture rule this fixture exists to trip. */
  readonly ruleId: string;
  /** A substring the report must mention, proving the right thing was caught. */
  readonly mentions: string;
}

const FIXTURES: readonly FixtureCase[] = [
  {
    file: 'test/lint/fixtures/core-fs-import.ts',
    ruleId: 'no-restricted-imports',
    mentions: 'node:fs',
  },
  {
    file: 'test/lint/fixtures/core-env-read.ts',
    ruleId: 'no-restricted-properties',
    mentions: 'process.env',
  },
  {
    file: 'test/lint/fixtures/verdict-refine.ts',
    ruleId: 'no-restricted-syntax',
    mentions: 'refine',
  },
  {
    file: 'test/lint/fixtures/core-imports-db.ts',
    ruleId: 'no-restricted-imports',
    mentions: '@adl/db',
  },
  {
    file: 'test/lint/fixtures/spawn-direct-import.ts',
    ruleId: 'no-restricted-imports',
    mentions: 'node:child_process',
  },
  {
    file: 'test/lint/fixtures/spawn-require.ts',
    ruleId: 'no-restricted-syntax',
    mentions: 'child_process',
  },
  {
    file: 'test/lint/fixtures/spawn-dynamic-import.ts',
    ruleId: 'no-restricted-syntax',
    mentions: 'node:child_process',
  },
  {
    // The `mentions` here is the whole point of this row: a single catch-all
    // selector would report SOMETHING on this file, but only the per-specifier
    // derivation can name `execa` in the message.
    file: 'test/lint/fixtures/spawn-dynamic-execa.ts',
    ruleId: 'no-restricted-syntax',
    mentions: 'execa',
  },
  // ── The three rows below watch the GLOB rather than the rule ──────────────
  //
  // Every architecture entry used to be registered with `files: ['**/*.ts']`,
  // which does not match `.mts`, `.cts` or `.tsx`. The four rows above are all
  // `.ts` and therefore could not see it: 02-VERIFICATION.md demonstrated a
  // `.mts` outside `packages/workspace` importing `execa` reporting ZERO
  // architecture errors while the base rules fired on the same file. These are
  // the regression guard for the widened globs — one per extension, and one per
  // import form, so a fix that widened the static-import layer and forgot the
  // syntax layer is still red.
  {
    file: 'test/lint/fixtures/spawn-esm-extension.mts',
    ruleId: 'no-restricted-imports',
    mentions: 'execa',
  },
  {
    file: 'test/lint/fixtures/spawn-cjs-extension.cts',
    ruleId: 'no-restricted-syntax',
    mentions: 'node:child_process',
  },
  {
    file: 'test/lint/fixtures/spawn-jsx-extension.tsx',
    ruleId: 'no-restricted-syntax',
    mentions: 'execa',
  },
  // ── And the three rows below watch the OTHER half of the glob ─────────────
  //
  // Closing `.mts`/`.cts`/`.tsx` left an exactly analogous gap behind, which
  // 02-VERIFICATION.md recorded as a warning rather than a failure:
  // `packages/db/src/probe.mjs` importing `execa` reported ZERO architecture
  // errors at `84d1d16`. The reasoning for not scoring it was sound (nothing
  // compiles a `.mjs`, and the scope was at least NAMED this time) but it rests
  // on which files happen to exist, and the constant's own docblock says a
  // build property that holds by file-naming coincidence is a review property
  // wearing the rule's clothes. One fixture per JavaScript extension and one
  // per import form, so a fix that widened the static-import layer and forgot
  // the syntax layer is still red.
  {
    file: 'test/lint/fixtures/spawn-esm-javascript.mjs',
    ruleId: 'no-restricted-imports',
    mentions: 'execa',
  },
  {
    file: 'test/lint/fixtures/spawn-cjs-javascript.cjs',
    ruleId: 'no-restricted-syntax',
    mentions: 'node:child_process',
  },
  {
    file: 'test/lint/fixtures/spawn-dynamic-javascript.js',
    ruleId: 'no-restricted-syntax',
    mentions: 'execa',
  },
  // ── The manager→worker fork() seam (03-03) ─────────────────────────────
  //
  // This fixture is not one of the "watch the glob" rows above — it exists to
  // show the spawn ban applies to a `fork`-shaped import specifically, the
  // exact form a manager author would reach for if they bypassed
  // `forkWorker` (`@adl/workspace`) and imported `node:child_process`
  // directly instead. See the "the fork() seam..." describe block below for
  // the other half of this proof: the real `fork.ts` source lints clean, and
  // the exemption that lets it stays at exactly one entry.
  {
    file: 'test/lint/fixtures/manager-fork-direct.ts',
    ruleId: 'no-restricted-imports',
    mentions: 'node:child_process',
  },
];

/**
 * Every extension a module here may carry, restated as a literal.
 *
 * Deliberately NOT imported from `eslint.config.js`'s
 * `MODULE_SOURCE_EXTENSIONS`, for the reason {@link anchoredPattern} already
 * gives below: these assertions have to be able to DISAGREE with the config.
 * Driving them off the config's own tuple would mean that deleting `mts` from it
 * deleted the assertion that would have caught the deletion — which is the exact
 * shape of the defect being fixed, a guard that is green because it stopped
 * looking.
 *
 * The four TypeScript spellings come first and the three JavaScript ones after,
 * matching the two halves the config names separately. They are one list here
 * because the property under test is identical for all seven: a process reaching
 * the OS process table is not made safer by the extension of the file that
 * started it, so a boundary that reaches six of these and not the seventh is a
 * boundary a file rename walks through.
 */
const MODULE_EXTENSIONS = [
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'mjs',
  'cjs',
] as const;

/**
 * `ignore: false` is what lets these runs see the fixtures at all.
 *
 * The fixtures are globally ignored by `eslint.config.js` so that `pnpm lint`
 * — and therefore CI — is not permanently red from files that exist to be
 * reported. Bypassing the ignore here is the only difference between this run
 * and CI's: the config file, and so the rule objects, are identical.
 */
const SEE_IGNORED_FIXTURES = { ignore: false } as const;

/** ESLint loading the repository's real flat config, exactly as CI does. */
function realConfigLinter(): ESLint {
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: CONFIG_FILE,
    ...SEE_IGNORED_FIXTURES,
  });
}

/** The negative control: everything except the architecture rule set. */
function withoutArchitectureRules(): ESLint {
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    baseConfig: baseConfigs,
    ...SEE_IGNORED_FIXTURES,
  });
}

function absolute(fixture: string): string {
  return path.join(REPO_ROOT, fixture);
}

/**
 * ── Reading the RESOLVED options, not the config source ───────────────────
 *
 * Everything below reads what ESLint actually decided to apply to a path.
 * 02-RESEARCH.md § Pitfall 1's failure mode is a later flat-config entry
 * REPLACING an earlier one's options for the same rule id — reproduced against
 * this repository's own eslint, with every pre-existing lint test still green,
 * because those tests only ever asserted that a rule was *registered at error*.
 * A source-level assertion cannot see that, so these helpers deliberately do
 * not look at `architectureConfigs`.
 */

interface RestrictedPath {
  readonly name: string;
}

interface RestrictedPattern {
  readonly group?: readonly string[];
}

interface RestrictedImportsOptions {
  readonly paths?: readonly RestrictedPath[];
  readonly patterns?: readonly RestrictedPattern[];
}

interface SyntaxSelector {
  readonly selector: string;
}

type ResolvedRules = Readonly<Record<string, unknown>>;

/** The options an already-resolved rule carries, with the severity dropped. */
function ruleOptions(rules: ResolvedRules, ruleId: string): readonly unknown[] {
  const entry = rules[ruleId];
  return Array.isArray(entry) ? entry.slice(1) : [];
}

function restrictedPathNames(rules: ResolvedRules): readonly string[] {
  return (
    ruleOptions(rules, 'no-restricted-imports') as RestrictedImportsOptions[]
  ).flatMap((options) => (options.paths ?? []).map((entry) => entry.name));
}

function restrictedPatternGroups(rules: ResolvedRules): readonly string[] {
  return (
    ruleOptions(rules, 'no-restricted-imports') as RestrictedImportsOptions[]
  ).flatMap((options) =>
    (options.patterns ?? []).flatMap((pattern) => pattern.group ?? []),
  );
}

function syntaxSelectors(rules: ResolvedRules): readonly string[] {
  return (ruleOptions(rules, 'no-restricted-syntax') as SyntaxSelector[]).map(
    (entry) => entry.selector,
  );
}

/**
 * The anchored pattern the config derives for one specifier.
 *
 * Duplicating the anchoring — rather than importing a helper — is deliberate:
 * the assertions must be able to disagree with the config. None of the current
 * specifiers contain a regex metacharacter, so this stays exact; one that did
 * would turn this test red, which is the safe direction for a guard.
 */
function anchoredPattern(specifier: string): string {
  return `/^${specifier}$/`;
}

/** A real, non-exempt source path — the baseline the ban must apply to. */
const NON_EXEMPT_SOURCE = 'packages/db/src/index.ts';
/** Inside the one exemption. Need not exist: resolution is by path. */
const EXEMPT_SOURCE = 'packages/workspace/src/exec/run.ts';
/** Inside the exemption's one carve-out — workspace SOURCE, not workspace tests. */
const WORKSPACE_SRC_SOURCE = 'packages/workspace/src/worktree/lifecycle.ts';

/**
 * Inside the exemption and outside the carve-out — and therefore the ONLY path
 * at which the exemption is observable in a resolved config.
 *
 * ── Why the exemption cannot be measured under `src/` ─────────────────────
 *
 * `adl/no-simple-git-in-workspace-src` is registered AFTER `adl/no-direct-spawn`
 * and configures the same two rule ids for `packages/workspace/src/**`. Flat
 * config REPLACES rather than merges (02-RESEARCH.md § Pitfall 1), so every path
 * under `src/` resolves the carve-out's options — `paths: [simple-git]` — no
 * matter what the entry above it decided. Removing the exemption entirely does
 * not change one byte of the resolved config for `src/exec/run.ts`: the ban is
 * applied and then immediately overwritten.
 *
 * 02-VERIFICATION.md § Mutation Testing found this the way it has to be found —
 * by breaking the config and watching nothing happen. Narrowing
 * `WORKSPACE_EXEMPTION` back to `['packages/workspace/**\/*.ts']` while leaving
 * the ban wide left the whole root suite at 40 passed, because the two
 * assertions that claimed to watch the exemption both measured at
 * `src/exec/run.{ext}`. Probing under that same mutation showed where the real
 * breakage lands: `packages/workspace/src/exec/probe-run.mts` came back CLEAN
 * (masked by the carve-out) while `packages/workspace/test/tmpprobe/probe.mts`
 * picked up the full ban — a lint error on a file the exemption is supposed to
 * cover.
 *
 * So the measurement lives here. The `src/` assertions are kept below because
 * they state something true and worth stating, but each one now carries a note
 * saying it cannot fail alone, and is paired with an assertion from this path
 * that can. An assertion whose green is unconditional is worse than no
 * assertion: it occupies the slot a real guard would have taken.
 */
const WORKSPACE_TEST_SOURCE = 'packages/workspace/test/helpers/temp-repo.ts';

/** The same path, in an arbitrary spelling, for the per-extension cases. */
function exemptionMeasurementPoint(extension: string): string {
  return `packages/workspace/test/helpers/temp-repo.${extension}`;
}
/** Matched by BOTH the core entry and the verdict entry — the merge target. */
const DOUBLY_MATCHED_SOURCE = 'packages/core/src/verdict/verdict.ts';

describe('architecture rules fail on deliberate violations', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.file} is reported by ${fixture.ruleId}`, async () => {
      const [result] = await realConfigLinter().lintFiles([
        absolute(fixture.file),
      ]);

      expect(result).toBeDefined();
      expect(result!.errorCount).toBeGreaterThanOrEqual(1);

      const offending = result!.messages.filter(
        (message) => message.ruleId === fixture.ruleId,
      );
      expect(
        offending.length,
        `expected ${fixture.ruleId} to report on ${fixture.file}, got ${JSON.stringify(
          result!.messages.map((m) => m.ruleId),
        )}`,
      ).toBeGreaterThanOrEqual(1);

      // Severity 2 is `error`. A rule reporting at severity 1 does not fail CI.
      expect(offending.every((message) => message.severity === 2)).toBe(true);

      // The report must name the thing that was banned, not merely fire. A rule
      // whose message is generic cannot tell a contributor what to do instead.
      const combined = offending.map((message) => message.message).join('\n');
      expect(combined).toContain(fixture.mentions);
    });
  }

  it('reports every fixture only because of the architecture rules', async () => {
    // The negative control. If this ever reports a non-zero count, the
    // assertions above are measuring something other than the rules under test.
    const results = await withoutArchitectureRules().lintFiles(
      FIXTURES.map((fixture) => absolute(fixture.file)),
    );

    expect(results).toHaveLength(FIXTURES.length);

    const offenders = results
      .filter((result) => result.errorCount > 0)
      .map((result) => ({
        file: path.relative(REPO_ROOT, result.filePath),
        messages: result.messages.map((m) => `${m.ruleId}: ${m.message}`),
      }));

    expect(
      offenders,
      'fixtures must be clean apart from the architecture rules',
    ).toEqual([]);
  });
});

describe('architecture rule severity', () => {
  it('registers every architecture rule at error, never warn', async () => {
    // Resolved from a REAL source path — the verdict schemas are the file set
    // all four rules apply to at once, and the one the refinement ban protects.
    const resolved = await realConfigLinter().calculateConfigForFile(
      path.join(REPO_ROOT, 'packages', 'core', 'src', 'verdict', 'verdict.ts'),
    );

    for (const ruleId of ARCHITECTURE_RULE_IDS) {
      const entry = resolved.rules?.[ruleId];
      expect(
        entry,
        `${ruleId} must be registered for core verdict sources`,
      ).toBeDefined();
      // ESLint normalises severity to 0 | 1 | 2 in the resolved config.
      expect(
        Array.isArray(entry) ? entry[0] : entry,
        `${ruleId} must resolve to error (2)`,
      ).toBe(2);
    }
  });

  it('declares no architecture rule at anything other than error', () => {
    // A static read of the exported config objects, so a future edit that
    // downgrades a rule to `warn` fails here even before it is resolved.
    const severities: string[] = [];
    for (const config of architectureConfigs) {
      for (const [ruleId, entry] of Object.entries(config.rules ?? {})) {
        const severity = Array.isArray(entry) ? entry[0] : entry;
        if (severity !== 'error' && severity !== 2) {
          severities.push(`${ruleId} -> ${String(severity)}`);
        }
      }
    }
    expect(
      severities,
      'architecture rules must ship at error severity',
    ).toEqual([]);
  });

  it('exercises every rule id the architecture config registers', () => {
    // Guards against a rule being added to the config and never gaining a
    // fixture — the exact shape of Pitfall 8.
    const registered = new Set<string>();
    for (const config of architectureConfigs) {
      for (const ruleId of Object.keys(config.rules ?? {})) {
        registered.add(ruleId);
      }
    }
    const exercised = new Set(FIXTURES.map((fixture) => fixture.ruleId));
    expect([...registered].sort()).toEqual([...exercised].sort());
    expect([...registered].sort()).toEqual([...ARCHITECTURE_RULE_IDS].sort());
  });
});

describe('the spawn boundary (WORK-02)', () => {
  it('did not delete the bans Phase 1 registered', async () => {
    // 02-RESEARCH.md § Pitfall 1's "verification step for the plan", verbatim.
    // The verdict sources are the file set every architecture rule applies to
    // at once, so they are where an overlapping entry does the most damage —
    // and the damage is SILENT, which is why each expectation below carries its
    // own message. A bare `toContain` failure would say "expected array to
    // contain X" without saying that the @adl/core purity ban had vanished.
    const resolved = await realConfigLinter().calculateConfigForFile(
      absolute(DOUBLY_MATCHED_SOURCE),
    );
    const rules = resolved.rules ?? {};

    const paths = restrictedPathNames(rules);
    expect(
      paths,
      `the @adl/core purity ban on node:fs no longer resolves for ${DOUBLY_MATCHED_SOURCE} — an overlapping no-restricted-imports entry has replaced CORE_PURITY_RULES (Pitfall 1)`,
    ).toContain('node:fs');
    expect(
      paths,
      `the spawn ban on execa no longer resolves for ${DOUBLY_MATCHED_SOURCE} — the spawn entries were not merged into CORE_PURITY_RULES`,
    ).toContain('execa');

    expect(
      restrictedPatternGroups(rules),
      `D-27's @adl/* sibling ban no longer resolves for ${DOUBLY_MATCHED_SOURCE} — the patterns list was dropped when paths were merged`,
    ).toContain('@adl/*');

    const selectors = syntaxSelectors(rules);
    expect(
      // Lowercased because the pair is `refine` and `superRefine`; both must
      // survive, so the expected count is 2 rather than "at least one".
      selectors.filter((selector) => selector.toLowerCase().includes('refine')),
      `the verdict refine()/superRefine() ban no longer resolves for ${DOUBLY_MATCHED_SOURCE} — the spawn selectors replaced VERDICT_SCHEMA_RULES instead of being spread into it`,
    ).toHaveLength(2);
    expect(
      selectors.filter((selector) => selector.includes('require')),
      `the spawn require() selectors no longer resolve for ${DOUBLY_MATCHED_SOURCE} — VERDICT_SCHEMA_RULES replaced them instead of spreading them in`,
    ).not.toHaveLength(0);
  });

  it.each([NON_EXEMPT_SOURCE, DOUBLY_MATCHED_SOURCE])(
    'covers every banned specifier in all three import forms for %s',
    async (source) => {
      // Driven off the exported tuple rather than four hand-written cases: a
      // specifier added to the ban gains its assertions automatically, and a
      // specifier whose selectors are lost goes red without anyone having to
      // remember to add a case. That is the defect this guard exists for — the
      // first draft's hand-written selectors named child_process only, leaving
      // execa and simple-git reachable by `await import()` with lint green.
      const resolved = await realConfigLinter().calculateConfigForFile(
        absolute(source),
      );
      const rules = resolved.rules ?? {};

      const paths = restrictedPathNames(rules);
      const selectors = syntaxSelectors(rules);

      const uncovered: string[] = [];
      for (const specifier of FORBIDDEN_SPAWN_SPECIFIERS) {
        const pattern = anchoredPattern(specifier);
        if (!paths.includes(specifier)) {
          uncovered.push(`${specifier}: no restricted import path`);
        }
        if (
          !selectors.some(
            (selector) =>
              selector.includes(pattern) &&
              selector.startsWith('CallExpression'),
          )
        ) {
          uncovered.push(`${specifier}: no require() selector`);
        }
        if (
          !selectors.some(
            (selector) =>
              selector.includes(pattern) &&
              selector.startsWith('ImportExpression'),
          )
        ) {
          uncovered.push(`${specifier}: no dynamic import() selector`);
        }
      }

      expect(
        uncovered,
        `every banned specifier must be covered in all three import forms for ${source}`,
      ).toEqual([]);
    },
  );

  it('exempts packages/workspace, and nothing else', async () => {
    // Two assertions on the same rule from two paths is what makes "exactly one
    // exemption" checkable rather than merely asserted. The exempt path need
    // not exist — calculateConfigForFile resolves by path — so this stays valid
    // in Wave 1 and stays valid once plan 02-03 creates the file.
    const exempt = await realConfigLinter().calculateConfigForFile(
      absolute(EXEMPT_SOURCE),
    );
    // TRUE, but it CANNOT FAIL on its own — see WORKSPACE_TEST_SOURCE's docblock.
    // The src carve-out overwrites this rule for every path under src/, so this
    // line reads the carve-out's options whether the exemption exists or not.
    // Kept because it states the property the exemption is FOR; the assertion
    // immediately below is the one that goes red when the exemption is narrowed.
    expect(
      restrictedPathNames(exempt.rules ?? {}),
      `${EXEMPT_SOURCE} is inside the one exemption and must be free to launch processes`,
    ).not.toContain('execa');

    const observable = await realConfigLinter().calculateConfigForFile(
      absolute(WORKSPACE_TEST_SOURCE),
    );
    expect(
      restrictedPathNames(observable.rules ?? {}),
      `${WORKSPACE_TEST_SOURCE} is inside the one exemption and outside the src carve-out, so the spawn ban must not reach it — this is the only path at which narrowing WORKSPACE_EXEMPTION is visible at all`,
    ).not.toContain('execa');
    expect(
      syntaxSelectors(observable.rules ?? {}).filter((selector) =>
        selector.includes(anchoredPattern('execa')),
      ),
      `${WORKSPACE_TEST_SOURCE} resolves a require()/import() selector for execa, so the exemption covers the static-import layer but not the syntax layer — the package's own suite could not exercise the exec path through a dynamic import`,
    ).toHaveLength(0);

    const governed = await realConfigLinter().calculateConfigForFile(
      absolute(NON_EXEMPT_SOURCE),
    );
    expect(
      restrictedPathNames(governed.rules ?? {}),
      `${NON_EXEMPT_SOURCE} is outside the exemption, so the identical import must be banned — otherwise the exemption has quietly widened`,
    ).toContain('execa');
  });

  it.each(MODULE_EXTENSIONS)(
    'reaches .%s files, so the ban is not scoped to one spelling of a module',
    async (extension) => {
      // 02-VERIFICATION.md's one gap and its follow-on warning, as one
      // resolved-config assertion per extension.
      //
      // `files: ['**/*.ts']` matches the extension EXACTLY — `.mts`, `.cts` and
      // `.tsx` are outside it — so the repository's headline enforcement
      // mechanism was a build property only for files that happened to be named
      // `.ts`. The outcome it protects was true anyway, because the repository
      // contains only `.ts` today. That is what made it worth fixing rather than
      // noting: the control was green for a reason that does not generalise, and
      // the first `.mts` anybody adds would have left the boundary silently.
      //
      // The same sentence held for `.js`/`.mjs`/`.cjs` after that fix, which is
      // why they are in this list too. The re-verification pass demonstrated
      // `packages/db/src/probe.mjs` importing `execa` reporting zero
      // architecture errors, and declined to score it only because the scope was
      // by then explicit. Explicit and wrong is still wrong.
      //
      // Asserted from BOTH sides for each extension, because "the ban reaches
      // .mts" and "the exemption reaches .mts" are independent and a fix that
      // widened one without the other is a different defect rather than none: a
      // widened ban over an un-widened exemption would make a `.mts` beside
      // `src/exec/run.ts` a lint error, and the reverse would reopen CR-01 for
      // one extension.
      //
      // The paths need not exist — `calculateConfigForFile` resolves by path —
      // which is what lets this cover extensions the repository does not use
      // yet. That is the whole point: the guard has to exist BEFORE the first
      // such file does, or it is a review property again.
      const governed = await realConfigLinter().calculateConfigForFile(
        absolute(`packages/db/src/index.${extension}`),
      );
      expect(
        restrictedPathNames(governed.rules ?? {}),
        `packages/db/src/index.${extension} is outside packages/workspace, so the spawn ban must reach it — an architecture glob that names one extension is a boundary a file rename walks through (WR-11)`,
      ).toContain('execa');

      const selectors = syntaxSelectors(governed.rules ?? {});
      expect(
        selectors.filter((selector) =>
          selector.includes(anchoredPattern('execa')),
        ),
        `packages/db/src/index.${extension} resolves no require()/import() selector for execa, so the ban is bypassable on this extension by changing the import form (02-RESEARCH.md § Pitfall 2)`,
      ).not.toHaveLength(0);

      // ── The exemption half, measured where it is observable ───────────────
      //
      // NOT at `packages/workspace/src/exec/run.${extension}`, which is where
      // this assertion used to live and where it could not fail: the src
      // carve-out replaces `no-restricted-imports` for every path under `src/`,
      // so the resolved options are the carve-out's whether the exemption
      // reaches this extension or not. 02-VERIFICATION.md proved it — narrowing
      // WORKSPACE_EXEMPTION to `.ts` alone left the suite at 40 passed.
      // See WORKSPACE_TEST_SOURCE's docblock for the full mechanism.
      const exemptionPoint = exemptionMeasurementPoint(extension);
      const exemptElsewhere = await realConfigLinter().calculateConfigForFile(
        absolute(exemptionPoint),
      );
      expect(
        restrictedPathNames(exemptElsewhere.rules ?? {}),
        `the one exemption must cover .${extension} too — a ban wider than its exemption makes ${exemptionPoint} a lint error for importing the one exec primitive the package exists to own`,
      ).not.toContain('execa');
      expect(
        syntaxSelectors(exemptElsewhere.rules ?? {}).filter((selector) =>
          selector.includes(anchoredPattern('execa')),
        ),
        `the exemption reaches ${exemptionPoint} for static imports but not for require()/import() — the two layers are separate rules and a half-widened exemption bans the exec path in one import form only`,
      ).toHaveLength(0);

      const exempt = await realConfigLinter().calculateConfigForFile(
        absolute(`packages/workspace/src/exec/run.${extension}`),
      );
      // Retained, and true, but structurally unfailable for the reason above —
      // it is a statement of intent about the exec primitive, not a guard. The
      // guard is the pair of expectations directly above this one.
      expect(
        restrictedPathNames(exempt.rules ?? {}),
        `the one exemption must cover .${extension} too — a ban wider than its exemption makes the one exec primitive unwritable in that spelling`,
      ).not.toContain('execa');

      // And the carve-out INSIDE the exemption, which is the half a widened
      // exemption would quietly reopen (CR-01/CR-02). This one CAN fail: the
      // carve-out is the entry that wins under `src/`, so narrowing its glob
      // leaves nothing configuring `no-restricted-imports` here at all.
      expect(
        restrictedPathNames(exempt.rules ?? {}),
        `packages/workspace/src must not be free to import simple-git in a .${extension} file — the exemption exists for execa and the one exec primitive, not for a second git spawner`,
      ).toContain('simple-git');
    },
  );

  it('bans simple-git inside packages/workspace/src, in all three import forms', async () => {
    // 02-REVIEW.md CR-01/CR-02. The package-wide exemption is right for `execa`
    // — `src/exec/run.ts` is the one process launch — and was wrong for
    // `simple-git`: three modules under `src/` built handles that spawned git
    // with no configuration neutralisation and with the daemon's whole
    // environment, and every one of those commands reads a file an agent can
    // write. Asserted on the RESOLVED options rather than on the config source,
    // for the reason the section header above gives: a later entry overlapping
    // this glob would silently replace it and every source-level check would
    // stay green.
    const resolved = await realConfigLinter().calculateConfigForFile(
      absolute(WORKSPACE_SRC_SOURCE),
    );
    const rules = resolved.rules ?? {};

    expect(
      restrictedPathNames(rules),
      `${WORKSPACE_SRC_SOURCE} must not be free to import simple-git — the workspace exemption exists for execa and the one exec primitive, not for a second git spawner (CR-01, CR-02)`,
    ).toContain('simple-git');

    const pattern = anchoredPattern('simple-git');
    const selectors = syntaxSelectors(rules);
    expect(
      selectors.filter(
        (selector) =>
          selector.includes(pattern) && selector.startsWith('CallExpression'),
      ),
      `${WORKSPACE_SRC_SOURCE} has no require('simple-git') selector — the ban is bypassable by changing the import form (02-RESEARCH.md § Pitfall 2)`,
    ).not.toHaveLength(0);
    expect(
      selectors.filter(
        (selector) =>
          selector.includes(pattern) && selector.startsWith('ImportExpression'),
      ),
      `${WORKSPACE_SRC_SOURCE} has no dynamic import('simple-git') selector — same bypass`,
    ).not.toHaveLength(0);

    // And NOT the rest of the spawn ban: `src/exec/run.ts` still has to be able
    // to import execa, so this must be a carve-out for one specifier rather
    // than the exemption quietly closing.
    expect(
      restrictedPathNames(rules),
      'the workspace source carve-out must cover simple-git ONLY — banning execa here would break the one exec primitive',
    ).not.toContain('execa');
  });

  it('leaves the workspace TESTS free to hold a simple-git handle', async () => {
    // Deliberate, and the carve-out would be worse without it. The fixture in
    // `temp-repo.ts` needs a git handle that is NOT the subject, and
    // `test/git/adl-git.test.ts`'s CONTROL case exists specifically to show
    // what a bare `simpleGit` child does with the daemon's environment. A ban
    // that covered the tests would delete the evidence that the ban is worth
    // having.
    const resolved = await realConfigLinter().calculateConfigForFile(
      absolute(WORKSPACE_TEST_SOURCE),
    );

    expect(
      restrictedPathNames(resolved.rules ?? {}),
      `${WORKSPACE_TEST_SOURCE} is inside the exemption and outside the src carve-out`,
    ).not.toContain('simple-git');
  });

  it.each([
    DOUBLY_MATCHED_SOURCE,
    'packages/core/src/stage/stage.ts',
    NON_EXEMPT_SOURCE,
    'packages/plugin-sdk/src/index.ts',
    WORKSPACE_SRC_SOURCE,
  ])(
    'resolves exactly one architecture configuration for %s',
    async (source) => {
      // Encodes the flat-config replacement semantics the whole composition is
      // built around, so a future entry that overlaps a glob fails HERE rather
      // than in production by silently deleting a ban.
      const resolved = await realConfigLinter().calculateConfigForFile(
        absolute(source),
      );
      const rules = resolved.rules ?? {};

      expect(
        ruleOptions(rules, 'no-restricted-imports'),
        `${source} must resolve exactly one no-restricted-imports options object — more than one is impossible, none means the ban does not apply`,
      ).toHaveLength(1);

      const selectors = syntaxSelectors(rules);
      expect(
        selectors.length,
        `${source} must resolve a no-restricted-syntax configuration`,
      ).toBeGreaterThan(0);
      expect(
        [...new Set(selectors)],
        `${source} resolved duplicate no-restricted-syntax selectors — a rule set was spread into itself`,
      ).toHaveLength(selectors.length);
    },
  );
});
