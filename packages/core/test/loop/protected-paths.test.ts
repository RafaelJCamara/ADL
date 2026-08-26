import { describe, expect, it } from 'vitest';

import {
  GATE_CONFIG_PATH,
  matchesGlob,
  violatedProtectedPaths,
} from '../../src/loop/protected-paths.js';

describe('matchesGlob', () => {
  it('matches a literal segment with no wildcard', () => {
    expect(matchesGlob('adl.yml', 'adl.yml')).toBe(true);
    expect(matchesGlob('adl.yml', 'adl.yaml')).toBe(false);
  });

  it('matches `*` within one segment, never across `/`', () => {
    expect(matchesGlob('tests/*.spec.ts', 'tests/foo.spec.ts')).toBe(true);
    expect(matchesGlob('tests/*.spec.ts', 'tests/nested/foo.spec.ts')).toBe(
      false,
    );
  });

  it('matches `**` as zero or more whole segments', () => {
    // Zero segments: `**` also matches the prefix itself.
    expect(matchesGlob('tests/**', 'tests')).toBe(true);
    expect(matchesGlob('tests/**', 'tests/foo.ts')).toBe(true);
    expect(matchesGlob('tests/**', 'tests/nested/deep/foo.ts')).toBe(true);
    expect(matchesGlob('tests/**', 'src/foo.ts')).toBe(false);
  });

  it('matches `**` in the middle of a pattern', () => {
    expect(matchesGlob('src/**/*.spec.ts', 'src/foo.spec.ts')).toBe(true);
    expect(matchesGlob('src/**/*.spec.ts', 'src/a/b/foo.spec.ts')).toBe(true);
    expect(matchesGlob('src/**/*.spec.ts', 'src/a/b/foo.ts')).toBe(false);
  });

  it('escapes regex metacharacters in a literal segment', () => {
    expect(matchesGlob('a+b.ts', 'a+b.ts')).toBe(true);
    expect(matchesGlob('a+b.ts', 'aab.ts')).toBe(false);
  });

  it('does not blow up on a pathological multi-** pattern against a long path', () => {
    const pattern = Array.from({ length: 20 }, () => '**').join('/');
    const path = Array.from({ length: 200 }, (_, i) => `seg${String(i)}`).join(
      '/',
    );
    const start = performance.now();
    expect(matchesGlob(pattern, path)).toBe(true);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

describe('violatedProtectedPaths', () => {
  const featurePath = 'features/export-widgets';

  it('is empty when nothing changed touches a protected path', () => {
    expect(
      violatedProtectedPaths({
        changedPaths: ['src/widgets.ts', 'README.md'],
        featurePath,
        protectedGlobs: [],
      }),
    ).toEqual([]);
  });

  it(`always protects ${GATE_CONFIG_PATH}, with no configured globs at all`, () => {
    expect(
      violatedProtectedPaths({
        changedPaths: ['src/widgets.ts', GATE_CONFIG_PATH],
        featurePath,
        protectedGlobs: [],
      }),
    ).toEqual([GATE_CONFIG_PATH]);
  });

  it('always protects the feature’s own spec folder, every file inside it', () => {
    expect(
      violatedProtectedPaths({
        changedPaths: [
          `${featurePath}/spec.md`,
          `${featurePath}/nested/notes.md`,
          'src/widgets.ts',
        ],
        featurePath,
        protectedGlobs: [],
      }),
    ).toEqual([`${featurePath}/spec.md`, `${featurePath}/nested/notes.md`]);
  });

  it('does not treat a sibling folder that merely shares a prefix as protected', () => {
    expect(
      violatedProtectedPaths({
        changedPaths: ['features/export-widgets-v2/spec.md'],
        featurePath,
        protectedGlobs: [],
      }),
    ).toEqual([]);
  });

  it('protects a configured glob, and lets everything else through', () => {
    expect(
      violatedProtectedPaths({
        changedPaths: ['tests/widgets.spec.ts', 'src/widgets.ts'],
        featurePath,
        protectedGlobs: ['tests/**'],
      }),
    ).toEqual(['tests/widgets.spec.ts']);
  });

  it('combines all three protections in one pass', () => {
    expect(
      violatedProtectedPaths({
        changedPaths: [
          'src/widgets.ts',
          GATE_CONFIG_PATH,
          `${featurePath}/spec.md`,
          'tests/widgets.spec.ts',
        ],
        featurePath,
        protectedGlobs: ['tests/**'],
      }),
    ).toEqual([
      GATE_CONFIG_PATH,
      `${featurePath}/spec.md`,
      'tests/widgets.spec.ts',
    ]);
  });
});
