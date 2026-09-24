import { describe, expect, it } from 'vitest';
import { selectVisiblePaths } from '../../src/stage/visible-paths.js';
import { resolvePipeline } from '../../src/config/pipeline.js';
import { AdlYmlSchema } from '../../src/config/adl-yml.js';

const TREE = [
  'src/server.ts',
  'src/deep/nested/impl.ts',
  'tests/greet.test.mjs',
  'tests/helpers/fixture.mjs',
  'package.json',
  'package-lock.json',
  'vitest.config.ts',
  'README.md',
];

describe('selectVisiblePaths', () => {
  it('splits a listing into both halves, and the halves partition it', () => {
    const { visible, hidden } = selectVisiblePaths(TREE, [
      'tests/**',
      'package.json',
    ]);

    expect(visible).toEqual([
      'tests/greet.test.mjs',
      'tests/helpers/fixture.mjs',
      'package.json',
    ]);
    expect(hidden).toContain('src/server.ts');
    expect(hidden).toContain('src/deep/nested/impl.ts');

    // The property that makes `hidden` usable as evidence: nothing is dropped
    // and nothing is counted twice, so "the implementation was withheld" can be
    // read off the result rather than re-derived by subtracting two listings.
    expect([...visible, ...hidden].sort()).toEqual([...TREE].sort());
  });

  it('matches nothing when the allowlist matches nothing, rather than everything', () => {
    // The failure mode worth naming: a "no patterns matched, so allow all"
    // fallback would turn a typo in `visible_paths` into a fully sighted
    // tester, and ROLE-06 would be false with a green build.
    const { visible, hidden } = selectVisiblePaths(TREE, ['spec/**']);
    expect(visible).toEqual([]);
    expect(hidden).toEqual(TREE);
  });

  it('is the same matcher protected_paths uses, including `**` across segments', () => {
    const { visible } = selectVisiblePaths(TREE, ['**']);
    expect(visible).toEqual(TREE);

    // A single `*` stops at a separator — the distinction the shared matcher
    // already makes, asserted here so a second matcher cannot be introduced
    // quietly for this feature.
    const shallow = selectVisiblePaths(TREE, ['tests/*']);
    expect(shallow.visible).toEqual(['tests/greet.test.mjs']);
    expect(shallow.hidden).toContain('tests/helpers/fixture.mjs');
  });

  it('preserves the order it was given, so a report reads like the tree', () => {
    const { visible } = selectVisiblePaths(TREE, ['**']);
    expect(visible).toEqual(TREE);
  });
});

describe('visible_paths reaches ResolvedStage', () => {
  it('is carried onto the resolved stage when declared', () => {
    const [stage] = resolvePipeline([
      { harness: 'test', visible_paths: ['tests/**'] },
    ]);
    expect(stage?.visiblePaths).toEqual(['tests/**']);
  });

  it('is absent — not empty — when the entry does not declare it', () => {
    // Absent and empty mean opposite things: absent is "attach to the
    // workspace the previous stage left", which is every gate's pre-M08
    // behaviour. Defaulting to `[]` here would silently compose an empty
    // workspace for every existing pipeline in every existing repository.
    const [plain] = resolvePipeline(['test']);
    expect(plain?.visiblePaths).toBeUndefined();
    expect('visiblePaths' in (plain ?? {})).toBe(false);

    const [entry] = resolvePipeline([{ harness: 'review' }]);
    expect(entry?.visiblePaths).toBeUndefined();
  });
});

describe('the adl.yml schema', () => {
  const base = {
    version: 1,
    commands: {
      build: { argv: ['true'] },
      start: { argv: ['true'] },
      test: { argv: ['true'] },
      teardown: { argv: ['true'] },
    },
  };

  it('accepts a declared allowlist', () => {
    const parsed = AdlYmlSchema.safeParse({
      ...base,
      pipeline: ['develop', { harness: 'test', visible_paths: ['tests/**'] }],
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses an empty allowlist rather than guessing which extreme was meant', () => {
    const parsed = AdlYmlSchema.safeParse({
      ...base,
      pipeline: ['develop', { harness: 'test', visible_paths: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a pattern that escapes the repository', () => {
    // The same guard `protected_paths` and `harness` are held to. A gate
    // declaring `../../etc/**` is asking ADL to copy the operator's filesystem
    // into a directory it then hands to a model.
    for (const bad of ['../secrets/**', '/etc/passwd']) {
      const parsed = AdlYmlSchema.safeParse({
        ...base,
        pipeline: ['develop', { harness: 'test', visible_paths: [bad] }],
      });
      expect(parsed.success, `${bad} must be refused`).toBe(false);
    }
  });
});
