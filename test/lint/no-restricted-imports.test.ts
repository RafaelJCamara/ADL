import * as path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import {
  ARCHITECTURE_RULE_IDS,
  FORBIDDEN_SPAWN_SPECIFIERS,
  FORGE_MERGE_MEMBERS,
  FORGE_MERGE_ROUTES,
  GATE_FORBIDDEN_IMPORT_GROUPS,
  GATE_FORBIDDEN_MEMBERS,
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
  // ── The worker entry cannot reach the database (03-04, D-01) ──────────────
  //
  // The structural guarantee ("the worker's dependency graph never gets
  // @adl/db") that used to hold by pnpm's strict node_modules alone stops
  // holding once the worker entry lives inside @adl/manager, which depends on
  // @adl/db for real. This fixture is the deliberate violation the new
  // `adl/worker-entry-no-db` rule set exists to catch.
  {
    file: 'test/lint/fixtures/worker-entry-imports-db.ts',
    ruleId: 'no-restricted-imports',
    mentions: '@adl/db',
  },
  // ── 04-01: the spawn ban reaches a new package outside packages/workspace ──
  //
  // `@adl/agent-claude-code` is deliberately absent from `WORKSPACE_EXEMPTION`
  // (04-RESEARCH.md § Pitfall 5) — an agent-adapter author shelling out to the
  // `claude` binary directly, instead of going through the `Workspace`
  // instance a caller passes in, is exactly the mistake this fixture shapes.
  {
    file: 'test/lint/fixtures/spawn-agent-backend.ts',
    ruleId: 'no-restricted-imports',
    mentions: 'execa',
  },
  // ── 05-12: ADL never merges (FORGE-10) ────────────────────────────────────
  //
  // The port half of this guard lives in @adl/core — `FORGE_ADAPTER_MEMBERS`
  // plus a compile-time exhaustiveness proof, asserted by
  // `packages/core/test/forge/never-merge.test.ts`. This fixture is the OTHER
  // half: a forge adapter holds a live forge client, so "the port declares no
  // merge method" does not by itself make a merge unreachable. The dedicated
  // describe block near the end of this file is where every banned verb and
  // route is checked individually.
  {
    file: 'test/lint/fixtures/forge-merge-call.ts',
    ruleId: 'no-restricted-syntax',
    mentions: 'FORGE-10',
  },
  // ── 05-17: a gate works from fresh context (ROLE-03) ──────────────────────
  //
  // The preferred guard here is the TYPE — `@adl/core/stage`'s `GateContext`
  // has no member naming the developer's session, transcript or rendered
  // prompt, and `GATE_CONTEXT_MEMBERS` proves that list complete at compile
  // time. This fixture is the other half: a parameter list cannot stop a gate
  // importing the transcript store directly and rebuilding the path from ids it
  // legitimately knows. Both rule ids fire on it, so both are listed — the
  // import layer and the member-read layer are independently escapable.
  {
    file: 'test/lint/fixtures/gate-reaches-past-context.ts',
    ruleId: 'no-restricted-imports',
    mentions: 'ROLE-03',
  },
  {
    file: 'test/lint/fixtures/gate-reaches-past-context.ts',
    ruleId: 'no-restricted-syntax',
    mentions: 'ROLE-03',
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
/** The one forge adapter that exists — where a live forge client is held. */
const FORGE_SOURCE = 'packages/forge-github/src/backend.ts';
/**
 * A forge adapter that does NOT exist yet (M14's GitLab adapter).
 *
 * `calculateConfigForFile` resolves by path, so this measures the property
 * that matters about `adl/no-forge-merge`'s glob: it names the package PREFIX,
 * not the one package written so far. D-27's argument, applied to FORGE-10 —
 * the rule that lands before the thing it would have prevented is the only
 * kind that ever prevents it. GitLab is also the forge whose merge verbs
 * (`accept`, `mergeWhenPipelineSucceeds`) read least like a merge, so it is
 * the adapter most likely to arrive at one by accident.
 */
const FUTURE_FORGE_SOURCE = 'packages/forge-gitlab/src/backend.ts';
/** The one gate implementation that exists — where fresh context must hold. */
const GATE_SOURCE = 'packages/manager/src/worker-entry/gates/command-gate.ts';
/**
 * A gate that does NOT exist yet (M07's reviewer).
 *
 * The same D-27 property `FUTURE_FORGE_SOURCE` measures, applied to ROLE-03:
 * `adl/gate-fresh-context` names the `gates/` DIRECTORY rather than the one
 * file in it, so the reviewer is governed on the day it is created. And the
 * reviewer is the gate ROLE-03 is literally about — the requirement's own
 * wording is *"Reviewer works from fresh context"* — so a guard that only
 * reached the command gate would be scoped to the one gate the requirement
 * does not name.
 */
const FUTURE_GATE_SOURCE = 'packages/manager/src/worker-entry/gates/review.ts';
/**
 * Worker-entry code that is NOT a gate — the narrowing point itself.
 *
 * `gate-context.ts` has to import `ipc/protocol.js` to narrow it, which is
 * exactly what the gate ban forbids. Measuring here proves the ban stops at the
 * `gates/` boundary rather than covering all of `worker-entry/`, which would
 * make the narrowing function unwritable and the whole design unbuildable.
 */
const NON_GATE_WORKER_SOURCE =
  'packages/manager/src/worker-entry/gate-context.ts';
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
    //
    // Deduplicated by PATH rather than counted off `FIXTURES.length`: a fixture
    // that trips two rule ids is listed once per rule id above, because each
    // needs its own "reports at error, and names what it banned" assertion —
    // but ESLint returns one result per file, so counting entries instead of
    // files would go red for a reason that has nothing to do with the control.
    // (05-17's gate fixture is the first: it violates both the import ban and
    // the member-read ban, which are independently escapable.)
    const fixtureFiles = [...new Set(FIXTURES.map((fixture) => fixture.file))];
    const results = await withoutArchitectureRules().lintFiles(
      fixtureFiles.map(absolute),
    );

    expect(results).toHaveLength(fixtureFiles.length);

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

  it('agent-claude-code is governed by the spawn ban, and the exemption still has exactly one entry (04-01, Pitfall 5)', async () => {
    // The positive half: `packages/agent-claude-code` is a new package
    // outside `packages/workspace`, and 04-RESEARCH.md § Pitfall 5 asks the
    // planner to VERIFY — not assume — that adding it did not require
    // widening `WORKSPACE_EXEMPTION`. Resolved from the real barrel path
    // rather than from the fixture, so this cannot pass merely because the
    // fixture happens to lint clean.
    const resolved = await realConfigLinter().calculateConfigForFile(
      absolute('packages/agent-claude-code/src/index.ts'),
    );
    expect(
      restrictedPathNames(resolved.rules ?? {}),
      'packages/agent-claude-code/src/index.ts must resolve the spawn ban on execa — the new package is not, and must not become, a second exemption',
    ).toContain('execa');

    // The negative half: the exemption array itself has not grown. A future
    // contributor adding `packages/agent-claude-code/**` (or any other
    // second glob) here would make this fail even though the assertion above
    // would still pass for THIS file, which is exactly why the count is
    // checked independently rather than inferred from one resolved path.
    expect(
      WORKSPACE_EXEMPTION,
      'the spawn-ban exemption must stay at exactly one glob entry — a second entry here silently widens success criterion 2 while every existing resolved-config assertion keeps passing',
    ).toHaveLength(1);
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
    // 05-12: `adl/no-forge-merge` overlaps `adl/no-direct-spawn` here, so this
    // row is where a merge ban that REPLACED the spawn selectors instead of
    // spreading them in would be caught.
    FORGE_SOURCE,
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

/* ────────────────────────────────────────────────────────────────────────────
 * The fork() seam (03-03): the settled question answered by measurement, not
 * by the comment in eslint.config.js that states the intent
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `eslint.config.js:21`/`:218` already state the intended resolution to "how
 * does the manager→worker `fork()` seam relate to `adl/no-direct-spawn`":
 * `forkWorker` lands as a named export of `packages/workspace`, and the
 * exemption count stays at one. The two assertions below are what turns that
 * sentence into something a later edit cannot silently falsify:
 *
 *  1. The real `packages/workspace/src/exec/fork.ts` — which imports a banned
 *     specifier (`node:child_process`) — lints clean. This is the POSITIVE
 *     half: it proves `WORKSPACE_EXEMPTION` already covers the new file with
 *     no config change, which `git diff eslint.config.js` also shows (at most
 *     a named export was added — see the `WORKSPACE_EXEMPTION` export's own
 *     docblock).
 *  2. Exactly one flat-config entry clears the spawn rules for
 *     `packages/workspace`, and its glob names it. This is the count
 *     `WORKSPACE_EXEMPTION`'s own docblock warned nothing was measuring: "a
 *     SECOND entry here makes success criterion 2 false while the rule still
 *     looks like it is enforcing something, which is strictly worse than
 *     having no rule at all." A future PR that reaches for `packages/manager`
 *     with its own `no-direct-spawn` carve-out — rather than importing
 *     `forkWorker` — now fails HERE instead of shipping unnoticed.
 */
describe('the fork() seam does not need — and did not receive — a second exemption', () => {
  const SPAWN_RULE_IDS = ['no-restricted-imports', 'no-restricted-syntax'];

  it('packages/workspace/src/exec/fork.ts lints clean under the spawn ban rule ids', async () => {
    const [result] = await realConfigLinter().lintFiles([
      absolute('packages/workspace/src/exec/fork.ts'),
    ]);

    expect(result).toBeDefined();
    const spawnMessages = (result!.messages ?? []).filter((message) =>
      SPAWN_RULE_IDS.includes(message.ruleId ?? ''),
    );
    expect(
      spawnMessages,
      `packages/workspace/src/exec/fork.ts imports node:child_process — a banned specifier — and must lint clean under ${SPAWN_RULE_IDS.join('/')} because WORKSPACE_EXEMPTION already covers it. Any reported message here means the exemption stopped covering this file, or fork.ts drifted outside packages/workspace.`,
    ).toEqual([]);
  });

  it('exactly one flat-config entry clears the spawn rules for packages/workspace, and its glob names it', () => {
    const workspaceGlob = WORKSPACE_EXEMPTION[0];
    expect(
      workspaceGlob,
      'WORKSPACE_EXEMPTION must not be empty',
    ).toBeDefined();
    expect(workspaceGlob).toContain('packages/workspace');

    // Every architectureConfigs entry whose OWN `ignores` array carves
    // `packages/workspace` out of a rule set it configures. `ignores` — not
    // `files` — is deliberately what is counted: `WORKSPACE_SRC`
    // (`adl/no-simple-git-in-workspace-src`'s `files:` glob) also names
    // `packages/workspace`, but that entry RE-BANS simple-git inside it
    // rather than clearing anything, so counting `files` globs would
    // over-count a carve-out as a second exemption when it is the opposite.
    const clearingEntries = architectureConfigs.filter((config) => {
      const ignores = (config as { readonly ignores?: readonly string[] })
        .ignores;
      return (ignores ?? []).some((glob) =>
        glob.includes('packages/workspace'),
      );
    });

    expect(
      clearingEntries,
      'exactly one architectureConfigs entry may clear the spawn rules for packages/workspace — a second one is the T-2-40/CR-01 failure mode this test exists to catch: the build stays green while the boundary is gone',
    ).toHaveLength(1);

    const [exemptionEntry] = clearingEntries;
    const ignores =
      (exemptionEntry as { readonly ignores?: readonly string[] }).ignores ??
      [];
    expect(
      ignores,
      'the one clearing entry must carve out WORKSPACE_EXEMPTION itself, not a differently-spelled glob that happens to also match packages/workspace',
    ).toContain(workspaceGlob);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The worker entry cannot reach the database (03-04, D-01) — scoped to
 * worker-entry, not the whole @adl/manager package
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the worker-entry @adl/db ban is scoped to worker-entry, not the whole package (03-04)', () => {
  it('packages/manager/src/api/app.ts — which legitimately reaches the database layer — lints clean under the new rule', async () => {
    const [result] = await realConfigLinter().lintFiles([
      absolute('packages/manager/src/api/app.ts'),
    ]);

    expect(result).toBeDefined();
    const dbMessages = (result!.messages ?? []).filter((message) =>
      message.message.includes('@adl/db'),
    );
    expect(
      dbMessages,
      'packages/manager/src/api/app.ts must be free to import @adl/db — the D-01 ban is scoped to the worker entry, not the whole @adl/manager package',
    ).toEqual([]);
  });

  it('the ban still resolves for a worker-entry path even though adl/no-direct-spawn also matches it (Pitfall 1)', async () => {
    const resolved = await realConfigLinter().calculateConfigForFile(
      absolute('packages/manager/src/worker-entry/index.ts'),
    );
    const paths = restrictedPathNames(resolved.rules ?? {});

    expect(
      paths,
      'the worker-entry glob must resolve the @adl/db ban',
    ).toContain('@adl/db');
    expect(
      paths,
      'merging @adl/db into the worker-entry rule set must not silently drop the spawn ban it overlaps with (02-RESEARCH.md § Pitfall 1)',
    ).toContain('execa');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * ADL never merges (FORGE-10, M05 step 5.12) — the adapter half
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `docs/plan/DECISIONS.md`: "Human approves and merges the PR. ADL never
 * merges." The milestone prefers *"the adapter has no merge method"* to *"we
 * don't call it"*, and that preferred guard is `@adl/core/forge`'s
 * `FORGE_ADAPTER_MEMBERS` — a frozen list of the port's own members, proven
 * exhaustive by a compile-time `Exclude<keyof ForgeAdapter, …> extends never`
 * assertion and read by `packages/core/test/forge/never-merge.test.ts`.
 *
 * This block is the half that guard structurally cannot reach. A forge adapter
 * does not merge by calling ADL's port — it merges by calling the FORGE, and
 * `packages/forge-github` holds a live `octokit` whose `rest.pulls.merge()`
 * exists no matter what ADL's interface declares. `getPushToken` is the
 * standing proof that a forge package legitimately reaches past the neutral
 * port when it has to, so the port's shape alone is not the property FORGE-10
 * asks for.
 *
 * Every assertion below is driven off the exported tuples rather than
 * hand-written per verb, for the reason the spawn suite already gives: a verb
 * added to the ban gains its assertions automatically, and a verb whose
 * selector is lost goes red without anyone remembering to add a case.
 */
describe('the never-merge guard (FORGE-10)', () => {
  /** Every merge selector the config resolves for a path, by shape. */
  async function mergeSelectorsFor(source: string): Promise<readonly string[]> {
    const resolved = await realConfigLinter().calculateConfigForFile(
      absolute(source),
    );
    return syntaxSelectors(resolved.rules ?? {});
  }

  it.each([FORGE_SOURCE, FUTURE_FORGE_SOURCE])(
    'resolves a selector for every banned merge verb and route at %s',
    async (source) => {
      const selectors = await mergeSelectorsFor(source);

      const uncovered: string[] = [];
      for (const member of FORGE_MERGE_MEMBERS) {
        // The MEMBER form, not the call form. `const m = octokit.rest.pulls.merge`
        // followed by `m({...})` is a call-expression selector's blind spot,
        // and an obvious way to arrive at a merge while refactoring.
        if (
          !selectors.includes(`MemberExpression[property.name='${member}']`)
        ) {
          uncovered.push(`${member}: no member-expression selector`);
        }
      }
      for (const [label, source_] of FORGE_MERGE_ROUTES) {
        if (!selectors.some((s) => s === `Literal[value=/${source_}/]`)) {
          uncovered.push(`${label}: no string-literal selector`);
        }
        if (
          !selectors.some(
            (s) => s === `TemplateElement[value.raw=/${source_}/]`,
          )
        ) {
          uncovered.push(`${label}: no template-literal selector`);
        }
      }

      expect(
        uncovered,
        `every merge verb and route must be banned at ${source}, in both the member and the string form — a forge reached as a raw route string or a GraphQL mutation name is invisible to an identifier ban, and vice versa`,
      ).toEqual([]);
    },
  );

  it('does not silently delete the spawn ban it overlaps with (Pitfall 1)', async () => {
    // `adl/no-forge-merge` configures `no-restricted-syntax` for a glob
    // `adl/no-direct-spawn` also matches, and flat config REPLACES rather than
    // merges per rule id. Without `...SPAWN_SYNTAX` spread into the merge rule
    // object, forge packages would become the one place in the repository
    // where `await import('execa')` lints clean — in a package whose own port
    // docblock says a forge adapter talks HTTP and never a subprocess.
    const resolved = await realConfigLinter().calculateConfigForFile(
      absolute(FORGE_SOURCE),
    );
    const rules = resolved.rules ?? {};

    const selectors = syntaxSelectors(rules);
    for (const specifier of FORBIDDEN_SPAWN_SPECIFIERS) {
      const pattern = anchoredPattern(specifier);
      expect(
        selectors.filter((selector) => selector.includes(pattern)),
        `${FORGE_SOURCE} lost the require()/import() ban on ${specifier} — the merge rule set replaced SPAWN_SYNTAX instead of spreading it in`,
      ).not.toHaveLength(0);
    }

    // And the static-import layer, which this entry deliberately does not
    // configure at all so that it keeps resolving from `adl/no-direct-spawn`.
    expect(
      restrictedPathNames(rules),
      `${FORGE_SOURCE} lost the static-import spawn ban — adl/no-forge-merge must not configure no-restricted-imports`,
    ).toContain('execa');
  });

  it('leaves the real GitHub adapter clean — the vocabulary is precise, not a search for "merge"', async () => {
    // The positive control, and the assertion most likely to catch an
    // over-broad tightening. `packages/forge-github/src/backend.ts` reads
    // `pr.merged_at`, compares against `'merged'` and `'MERGED'`, and sends a
    // `markPullRequestReadyForReview` GraphQL mutation. A ban on the substring
    // `merge` would flag all four — at which point the rule gets switched off,
    // which is how a guard stops guarding.
    const [result] = await realConfigLinter().lintFiles([
      absolute(FORGE_SOURCE),
    ]);

    expect(result).toBeDefined();
    const reported = (result!.messages ?? []).filter(
      (message) => message.ruleId === 'no-restricted-syntax',
    );
    expect(
      reported.map((m) => `line ${m.line}: ${m.message}`),
      `${FORGE_SOURCE} must lint clean under adl/no-forge-merge. Reading a merged state is not causing one — observing the outcome a human produced is exactly what listOpenChangeRequests is for.`,
    ).toEqual([]);
  });

  it('reports every banned verb and route on the fixture', async () => {
    // The other direction from the resolved-config assertions above: those
    // prove a selector EXISTS, this proves it FIRES. A selector that resolves
    // but matches nothing — a mis-escaped regex, an attribute path that moved
    // between parser versions — passes the first and fails here.
    const [result] = await realConfigLinter().lintFiles([
      absolute('test/lint/fixtures/forge-merge-call.ts'),
    ]);

    expect(result).toBeDefined();
    const combined = (result!.messages ?? [])
      .filter((message) => message.ruleId === 'no-restricted-syntax')
      .map((message) => message.message)
      .join('\n');

    const silent: string[] = [];
    for (const member of FORGE_MERGE_MEMBERS) {
      // The trailing colon disambiguates: `.merge:` is not a prefix of
      // `.mergePullRequest:`, so each verb is checked on its own.
      if (!combined.includes(`.${member}: `)) silent.push(`.${member}`);
    }
    for (const [label] of FORGE_MERGE_ROUTES) {
      if (!combined.includes(`${label}: `)) silent.push(label);
    }

    expect(
      silent,
      `these banned entries resolve a selector but never fired on the fixture: ${silent.join(', ')}. Either the selector matches nothing, or test/lint/fixtures/forge-merge-call.ts has no case for it — a banned entry nobody has watched fire is the Pitfall 8 shape this whole file exists to prevent.`,
    ).toEqual([]);
  });

  it('is configured by exactly one flat-config entry, and its glob names the forge packages', () => {
    // The count, for the same reason `WORKSPACE_EXEMPTION` has one: a second
    // entry configuring these selectors over a wider glob would look like it
    // was strengthening the ban while actually replacing this one, and every
    // resolved-config assertion above would keep passing at the paths it
    // happens to still cover.
    const configuring = architectureConfigs.filter((config) => {
      const entry = config.rules?.['no-restricted-syntax'];
      const options = Array.isArray(entry) ? entry.slice(1) : [];
      return options.some(
        (option) =>
          typeof option === 'object' &&
          option !== null &&
          typeof (option as SyntaxSelector).selector === 'string' &&
          (option as SyntaxSelector).selector ===
            `MemberExpression[property.name='merge']`,
      );
    });

    expect(
      configuring,
      'exactly one architectureConfigs entry may configure the merge ban — a second is the T-2-40/CR-01 failure mode: the build stays green while the boundary moves',
    ).toHaveLength(1);

    const files =
      (configuring[0] as { readonly files?: readonly string[] }).files ?? [];
    expect(
      files.some((glob) => glob.includes('packages/forge-*')),
      `the merge ban must be scoped by package PREFIX (packages/forge-*), not to the one adapter that exists — M14 adds two more, and GitLab's merge verbs are the ones that read least like a merge. Got: ${files.join(', ')}`,
    ).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Fresh-context gate isolation (ROLE-03, M05 step 5.17) — the residual half
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ROLE-03: *"Reviewer works from fresh context — it never inherits the
 * developer's session, transcript, or reasoning."* M05's AC3 fixes the
 * mechanism: gate context is assembled from spec, diff and repository **only**.
 *
 * The preferred guard is the type, and it exists: `@adl/core/stage`'s
 * `GateContext` has no member through which any of those can be named, proven
 * complete at compile time by `GATE_CONTEXT_MEMBERS`' `Exclude<>` assertion and
 * read by `packages/core/test/stage/gate-context.test.ts`.
 *
 * This block is the half that guard structurally cannot reach — the same shape,
 * and the same argument, as the never-merge block above. A gate does not have
 * to arrive at the developer's transcript through its parameters: it can import
 * `store/transcript-path.js` and build the path itself out of the round and
 * stage ids it legitimately knows. A parameter list cannot stop that; a module
 * boundary can.
 *
 * Every assertion is driven off the exported tuples rather than hand-written
 * per name, so a name added to the ban gains its assertions automatically and a
 * name whose selector is lost goes red without anyone remembering to add a case.
 */
describe('fresh-context gate isolation (ROLE-03)', () => {
  it.each([GATE_SOURCE, FUTURE_GATE_SOURCE])(
    'resolves all three selector shapes for every forbidden name at %s',
    async (source) => {
      const resolved = await realConfigLinter().calculateConfigForFile(
        absolute(source),
      );
      const selectors = syntaxSelectors(resolved.rules ?? {});

      const uncovered: string[] = [];
      for (const member of GATE_FORBIDDEN_MEMBERS) {
        if (
          !selectors.includes(`MemberExpression[property.name='${member}']`)
        ) {
          uncovered.push(`${member}: no member-expression selector`);
        }
        // The one a probe found missing on the first cut: `const { logsRoot } =
        // assign` lints clean under a member-expression ban alone, which is the
        // destructuring analogue of the aliasing blind spot the merge ban
        // documents.
        if (!selectors.includes(`Property[key.name='${member}']`)) {
          uncovered.push(`${member}: no destructuring/object-key selector`);
        }
        if (
          !selectors.includes(
            `MemberExpression[computed=true][property.value='${member}']`,
          )
        ) {
          uncovered.push(`${member}: no computed-access selector`);
        }
      }

      expect(
        uncovered,
        `every forbidden context field must be banned at ${source} in all three shapes — a member read, a destructuring, and a computed access are three independent ways to the same value, and a guard that catches one of them catches none of the other two`,
      ).toEqual([]);
    },
  );

  it.each([GATE_SOURCE, FUTURE_GATE_SOURCE])(
    'resolves every forbidden import group at %s',
    async (source) => {
      const resolved = await realConfigLinter().calculateConfigForFile(
        absolute(source),
      );
      const groups = restrictedPatternGroups(resolved.rules ?? {});

      const missing = GATE_FORBIDDEN_IMPORT_GROUPS.map(
        ([group]) => group,
      ).filter((group) => !groups.includes(group));

      expect(
        missing,
        `these module groups are not banned at ${source}: ${missing.join(', ')}. Each is a route to something a gate may not see — the transcript store, the prompt builder, the round loop, and the AssignMessage envelope that declares every one of the forbidden fields.`,
      ).toEqual([]);
    },
  );

  it('does not silently delete the two bans it overlaps with (Pitfall 1)', async () => {
    // `packages/manager/src/worker-entry/gates/**` is matched by
    // `adl/no-direct-spawn` (files: **/*) AND by `adl/worker-entry-no-db`
    // (files: worker-entry/**), and flat config REPLACES rather than merges per
    // rule id. Both merges are therefore mandatory, and the @adl/db one is the
    // dangerous one to forget: a gate that could open the database could read
    // `stage_attempts` and reach a transcript address that way — this rule's
    // own property defeated through the hole this rule opened.
    const resolved = await realConfigLinter().calculateConfigForFile(
      absolute(GATE_SOURCE),
    );
    const rules = resolved.rules ?? {};

    const paths = restrictedPathNames(rules);
    expect(
      paths,
      `${GATE_SOURCE} lost D-01's @adl/db ban — adl/gate-fresh-context replaced adl/worker-entry-no-db's options instead of re-merging them`,
    ).toContain('@adl/db');
    expect(
      paths,
      `${GATE_SOURCE} lost the static-import spawn ban — adl/gate-fresh-context must re-merge FORBIDDEN_SPAWN into its paths`,
    ).toContain('execa');

    expect(
      restrictedPatternGroups(rules),
      `${GATE_SOURCE} lost the @adl/db subpath ban`,
    ).toContain('@adl/db/*');

    const selectors = syntaxSelectors(rules);
    for (const specifier of FORBIDDEN_SPAWN_SPECIFIERS) {
      const pattern = anchoredPattern(specifier);
      expect(
        selectors.filter((selector) => selector.includes(pattern)),
        `${GATE_SOURCE} lost the require()/import() ban on ${specifier} — the gate rule set replaced SPAWN_SYNTAX instead of spreading it in`,
      ).not.toHaveLength(0);
    }
  });

  it('stops at the gates/ boundary — the narrowing function itself is free to import what it narrows', async () => {
    // The positive control that matters most for buildability. Something has to
    // turn an AssignMessage into a GateContext, and it necessarily imports the
    // AssignMessage. If the ban covered all of worker-entry/ this design could
    // not be written at all — and the temptation would be to weaken the ban
    // rather than to move the file, which is how a boundary becomes decorative.
    const groups = restrictedPatternGroups(
      (
        await realConfigLinter().calculateConfigForFile(
          absolute(NON_GATE_WORKER_SOURCE),
        )
      ).rules ?? {},
    );

    expect(
      groups,
      `${NON_GATE_WORKER_SOURCE} is the narrowing point, not a gate — it must be free to import ipc/protocol.js`,
    ).not.toContain('**/ipc/protocol.js');

    // …and it is still a worker-entry file, so D-01 still applies to it.
    const paths = restrictedPathNames(
      (
        await realConfigLinter().calculateConfigForFile(
          absolute(NON_GATE_WORKER_SOURCE),
        )
      ).rules ?? {},
    );
    expect(
      paths,
      `${NON_GATE_WORKER_SOURCE} must still carry D-01's @adl/db ban — moving the gate ban must not have moved that one`,
    ).toContain('@adl/db');
  });

  it('leaves the real command gate clean — the ban is precise, not a blanket', async () => {
    // The positive control. `gates/command-gate.ts` reads `gate.stageId`,
    // `gate.workspace`, `gate.onEvent`, `gate.signal`, `config.command` and
    // `config.path`, and imports `@adl/core/*` plus `../../ipc/stage-verdict.js`
    // — which lives directly beside the banned `ipc/protocol.js` and is exactly
    // what a gate must import, since it is the envelope its own answer travels
    // home in. A ban that took the whole `ipc/` directory would flag it, at
    // which point the rule gets switched off, which is how a guard stops
    // guarding.
    const [result] = await realConfigLinter().lintFiles([
      absolute(GATE_SOURCE),
    ]);

    expect(result).toBeDefined();
    const reported = (result!.messages ?? []).filter(
      (message) =>
        message.ruleId === 'no-restricted-syntax' ||
        message.ruleId === 'no-restricted-imports',
    );
    expect(
      reported.map((m) => `line ${m.line}: ${m.message}`),
      `${GATE_SOURCE} must lint clean under adl/gate-fresh-context`,
    ).toEqual([]);
  });

  it('reports every forbidden name and group on the fixture', async () => {
    // The other direction from the resolved-config assertions above: those
    // prove a selector EXISTS, this proves it FIRES. A selector that resolves
    // but matches nothing — an attribute path that moved between parser
    // versions, a group glob that does not match a relative specifier — passes
    // the first and fails here. The relative-specifier case is not
    // hypothetical: `no-restricted-imports`' documented examples only ever show
    // bare package names, and a gate's imports of these are all relative.
    const [result] = await realConfigLinter().lintFiles([
      absolute('test/lint/fixtures/gate-reaches-past-context.ts'),
    ]);

    expect(result).toBeDefined();
    const combined = (result!.messages ?? [])
      .map((message) => message.message)
      .join('\n');

    const silent: string[] = [];
    for (const member of GATE_FORBIDDEN_MEMBERS) {
      if (!combined.includes(member)) silent.push(member);
    }
    for (const [group] of GATE_FORBIDDEN_IMPORT_GROUPS) {
      // The group glob is not in the message; the specifier that matched it is.
      // `**\/store/*` → `.../store/transcript-path.js`, so the directory
      // segment is what identifies it.
      const segment = group.replace('**/', '').split('/')[0];
      if (segment !== undefined && !combined.includes(`/${segment}/`)) {
        silent.push(group);
      }
    }

    expect(
      silent,
      `these banned entries resolve but never fired on the fixture: ${silent.join(', ')}. Either the selector matches nothing, or test/lint/fixtures/gate-reaches-past-context.ts has no case for it — a banned entry nobody has watched fire is the Pitfall 8 shape this whole file exists to prevent.`,
    ).toEqual([]);
  });

  it('is configured by exactly one flat-config entry, scoped to the gates directory, and registered after the ban it overlaps', () => {
    const isGateEntry = (config: {
      readonly rules?: Readonly<Record<string, unknown>>;
    }): boolean => {
      const entry = config.rules?.['no-restricted-syntax'];
      const options = Array.isArray(entry) ? entry.slice(1) : [];
      return options.some(
        (option) =>
          typeof option === 'object' &&
          option !== null &&
          (option as SyntaxSelector).selector ===
            `MemberExpression[property.name='logsRoot']`,
      );
    };

    const configuring = architectureConfigs.filter(isGateEntry);
    expect(
      configuring,
      'exactly one architectureConfigs entry may configure the fresh-context ban — a second over a wider glob would look like it was strengthening the ban while actually replacing this one',
    ).toHaveLength(1);

    const files =
      (configuring[0] as { readonly files?: readonly string[] }).files ?? [];
    expect(
      files.some((glob) => glob.includes('worker-entry/gates/')),
      `the fresh-context ban must be scoped to the gates DIRECTORY — a place, not a filename convention, so M07's reviewer is governed the day it is written. Got: ${files.join(', ')}`,
    ).toBe(true);

    // ── The ordering property, and it is not stylistic ──────────────────────
    //
    // `worker-entry/gates/**` is a strict SUBSET of `adl/worker-entry-no-db`'s
    // glob, and flat config resolves per rule id by LAST match. Registered
    // before it, this entry would be silently overwritten for every gate file —
    // the rule would still be in the config, still look configured, and enforce
    // nothing. The resolved-config assertions above are what would actually go
    // red; this one names the cause so the next reader does not have to
    // rediscover it.
    const indexOfName = (name: string): number =>
      architectureConfigs.findIndex(
        (config) => (config as { readonly name?: string }).name === name,
      );

    const gateIndex = indexOfName('adl/gate-fresh-context');
    const dbIndex = indexOfName('adl/worker-entry-no-db');
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(dbIndex).toBeGreaterThanOrEqual(0);
    expect(
      gateIndex,
      'adl/gate-fresh-context must be registered AFTER adl/worker-entry-no-db: its glob is a strict subset, and flat config resolves per rule id by last match, so registering it earlier switches it off while leaving it looking configured',
    ).toBeGreaterThan(dbIndex);
  });
});
