import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * The single hardest constraint in the stack, asserted rather than commented.
 *
 * npm `latest` for TypeScript is 7.0.2. `typescript-eslint@8.67.0` peers
 * `>=4.8.4 <6.1.0`. An install that silently picks up TypeScript 7 therefore
 * breaks linting in a way that reads as a lint bug rather than a version bug,
 * and the person debugging it will start in entirely the wrong place.
 *
 * Two properties matter here, and only one of them is a pin:
 *
 *  - The resolved TypeScript version is EXACTLY 6.0.3 (C-1). Hardcoded on
 *    purpose — catching drift from the pin is the whole job.
 *  - That version falls inside the peer range typescript-eslint ACTUALLY
 *    declares, read from its installed manifest. Hardcoding the range string
 *    would mean a dependency bump silently invalidated the assertion: the test
 *    would keep checking a range nobody enforces any more.
 */

const require = createRequire(import.meta.url);

const PINNED_TYPESCRIPT = '6.0.3';
const PINNED_PACKAGE_MANAGER = 'pnpm@11.22.0';

interface Manifest {
  readonly version: string;
  readonly packageManager?: string;
  readonly peerDependencies?: Record<string, string>;
}

function manifest(specifier: string): Manifest {
  return require(specifier) as Manifest;
}

// ── A minimal semver range evaluator ──────────────────────────────────────
//
// `semver` is not a dependency of this workspace and adding one to assert a
// version pin would be its own small irony. This handles the comparator and
// `||` forms, and THROWS on anything it does not understand rather than
// quietly returning true — an unparseable range must fail loudly, because a
// range evaluator that guesses is worse than no assertion at all.

interface Comparator {
  readonly op: '>=' | '<=' | '>' | '<' | '=';
  readonly parts: readonly number[];
}

function parseVersion(version: string): readonly number[] {
  const core = version.split('+')[0]!.split('-')[0]!;
  const parts = core.split('.').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
    throw new Error(`Unparseable version: ${version}`);
  }
  return parts;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

function parseComparator(raw: string): Comparator {
  const match = /^(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+\S*)$/.exec(raw);
  if (!match) {
    throw new Error(
      `Unsupported range comparator "${raw}". The evaluator understands >=, <=, >, <, = and bare versions; extend it deliberately rather than loosening this assertion.`,
    );
  }
  return {
    op: (match[1] ?? '=') as Comparator['op'],
    parts: parseVersion(match[2]!),
  };
}

function satisfies(version: string, range: string): boolean {
  const actual = parseVersion(version);
  // `||` is OR across clauses; whitespace within a clause is AND.
  return range.split('||').some((clause) => {
    const comparators = clause.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0)
      throw new Error(`Empty range clause in "${range}"`);
    return comparators.every((raw) => {
      const { op, parts } = parseComparator(raw);
      const order = compare(actual, parts);
      switch (op) {
        case '>=':
          return order >= 0;
        case '<=':
          return order <= 0;
        case '>':
          return order > 0;
        case '<':
          return order < 0;
        case '=':
          return order === 0;
      }
    });
  });
}

describe('the range evaluator has teeth', () => {
  // Without these, `satisfies()` could return true unconditionally and every
  // assertion below would pass while proving nothing. Fabricated versions,
  // permanently — rather than a scratch edit somebody has to remember to revert.
  it.each([
    ['6.0.3', '>=4.8.4 <6.1.0', true],
    ['7.0.2', '>=4.8.4 <6.1.0', false], // the trap this whole test exists for
    ['6.1.0', '>=4.8.4 <6.1.0', false], // exclusive upper bound
    ['4.8.4', '>=4.8.4 <6.1.0', true], // inclusive lower bound
    ['4.8.3', '>=4.8.4 <6.1.0', false],
    ['9.0.0', '>=4.8.4 <6.1.0 || >=9.0.0', true],
  ])('%s against %s is %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it('throws rather than guessing on a range form it does not understand', () => {
    expect(() => satisfies('6.0.3', '^6.0.0')).toThrow(/Unsupported range/);
  });
});

describe('toolchain pins', () => {
  it('resolves TypeScript at exactly the pinned version', () => {
    expect(manifest('typescript/package.json').version).toBe(PINNED_TYPESCRIPT);
  });

  it('keeps TypeScript inside the peer range typescript-eslint declares', () => {
    const tseslint = manifest('typescript-eslint/package.json');
    const range = tseslint.peerDependencies?.typescript;

    expect(
      range,
      'typescript-eslint must declare a typescript peer range for this assertion to mean anything',
    ).toBeDefined();

    const resolved = manifest('typescript/package.json').version;
    expect(
      satisfies(resolved, range!),
      `typescript@${resolved} falls outside typescript-eslint@${tseslint.version}'s declared peer range "${range}"`,
    ).toBe(true);
  });

  it('pins pnpm through the packageManager field', () => {
    // Read from the manifest rather than from the running process: this is what
    // corepack reads, and therefore what a contributor's install actually
    // matches (C-3).
    const root = manifest('../package.json');
    expect(root.packageManager).toBe(PINNED_PACKAGE_MANAGER);
  });
});
