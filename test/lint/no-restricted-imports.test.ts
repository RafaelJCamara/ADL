import * as path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import {
  ARCHITECTURE_RULE_IDS,
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
];

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
