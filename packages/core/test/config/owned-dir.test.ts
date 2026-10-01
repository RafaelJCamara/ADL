import { describe, expect, it } from 'vitest';
import { AdlYmlSchema } from '../../src/config/adl-yml.js';
import { EffectiveConfigSchema } from '../../src/config/effective-config.js';
import {
  directoriesOverlap,
  isOwnedDir,
  isWithinDirectory,
  visiblePathsCoverDirectory,
} from '../../src/config/owned-dir.js';
import { resolvePipeline } from '../../src/config/pipeline.js';

/**
 * `owned_dir` (ROLE-09, M08 step 8.6) — the directory a gate owns, whose
 * contents ADL commits and the developer may never change.
 */

const BASE = {
  version: 1,
  commands: {
    build: { argv: ['true'] },
    start: { argv: ['true'] },
    test: { argv: ['true'] },
    teardown: { argv: ['true'] },
  },
};

function issuesFor(pipeline: readonly unknown[], extra: object = {}): string {
  const parsed = AdlYmlSchema.safeParse({ ...BASE, ...extra, pipeline });
  return parsed.success
    ? ''
    : parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('\n');
}

describe('isOwnedDir — one directory, never a glob', () => {
  it('accepts plain nested directories', () => {
    for (const ok of [
      'tests',
      'tests/behaviour',
      'spec/e2e/adl-tests',
      'a b',
    ]) {
      expect(isOwnedDir(ok), ok).toBe(true);
    }
  });

  it('refuses every shape that would make "the directory" ambiguous or unsafe', () => {
    for (const bad of [
      '',
      '.',
      './tests', // a `./` path never matches a diff name — an always-on protection must not inherit that
      'tests/./behaviour',
      'tests/../src',
      'tests/', // trailing slash
      'tests//behaviour',
      '/tests', // absolute
      'tests\\behaviour', // backslash
      'tests/**',
      'tests/*.mjs',
      'tests/b?',
      'tests/[ab]',
      'tests/{a,b}',
      '.git',
      '.git/hooks',
      'sub/.git/hooks',
      '.adl',
      '.adl/scratch',
      'C:/tests', // a drive letter, which RepoRelativePathSchema refuses too
      'tests/a:b', // an NTFS alternate data stream
    ]) {
      expect(isOwnedDir(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('the directory relations', () => {
  it('is segment-wise, so a shared prefix is not containment', () => {
    expect(isWithinDirectory('tests/behaviour/a.mjs', 'tests/behaviour')).toBe(
      true,
    );
    expect(isWithinDirectory('tests/behaviour', 'tests/behaviour')).toBe(true);
    expect(isWithinDirectory('tests/behaviour-old/a', 'tests/behaviour')).toBe(
      false,
    );
    expect(directoriesOverlap('features', 'features/x')).toBe(true);
    expect(directoriesOverlap('features/x', 'features')).toBe(true);
    expect(directoriesOverlap('features', 'feature')).toBe(false);
    // Every spelling RepoRelativePathSchema admits for features_dir is the same
    // directory, and on Windows and macOS case does not tell two folders apart.
    for (const spelling of [
      './features',
      'features/',
      'features//',
      'Features',
      'features\\',
    ]) {
      expect(directoriesOverlap('features/tests', spelling), spelling).toBe(
        true,
      );
    }
    // The repository root contains everything.
    expect(directoriesOverlap('tests', '.')).toBe(true);
  });

  it('counts only a pattern that copies the WHOLE directory as covering it', () => {
    const dir = 'tests/behaviour';
    expect(visiblePathsCoverDirectory(['tests/behaviour/**'], dir)).toBe(true);
    expect(visiblePathsCoverDirectory(['tests/**'], dir)).toBe(true);
    expect(visiblePathsCoverDirectory(['**'], dir)).toBe(true);
    // Narrower patterns leave files out of the next round's copy, and the
    // carry-back mirror would then delete them from the branch.
    expect(visiblePathsCoverDirectory(['tests/behaviour/*.mjs'], dir)).toBe(
      false,
    );
    expect(visiblePathsCoverDirectory(['tests/behaviour'], dir)).toBe(false);
    expect(visiblePathsCoverDirectory(['tests/behaviour/x/**'], dir)).toBe(
      false,
    );
    expect(visiblePathsCoverDirectory(['tests/behaviour-old/**'], dir)).toBe(
      false,
    );
  });
});

describe('the adl.yml schema', () => {
  it('accepts an owned_dir its own visible_paths cover', () => {
    expect(
      issuesFor([
        'develop',
        {
          harness: 'behaviour',
          visible_paths: ['tests/behaviour/**'],
          owned_dir: 'tests/behaviour',
        },
      ]),
    ).toBe('');
  });

  it('refuses an owned_dir on an entry with no visible_paths — there is no copy to carry back from', () => {
    expect(
      issuesFor(['develop', { harness: 'lint', owned_dir: 'tests/lint' }]),
    ).toContain('owned_dir requires visible_paths');
  });

  it('refuses visible_paths that would leave part of the directory out of the next round', () => {
    expect(
      issuesFor([
        'develop',
        {
          harness: 'behaviour',
          visible_paths: ['tests/behaviour/*.mjs'],
          owned_dir: 'tests/behaviour',
        },
      ]),
    ).toContain('visible_paths must copy every file under owned_dir');
  });

  it('refuses an owned_dir overlapping features_dir, in either direction', () => {
    for (const [ownedDir, featuresDir] of [
      ['features/tests', 'features'],
      ['features', 'features'],
      ['specs', 'specs/features'],
    ] as const) {
      expect(
        issuesFor(
          [
            'develop',
            {
              harness: 'behaviour',
              visible_paths: ['**'],
              owned_dir: ownedDir,
            },
          ],
          { features_dir: featuresDir },
        ),
        `${ownedDir} against ${featuresDir}`,
      ).toContain('overlaps features_dir');
    }
  });

  it('refuses two entries owning overlapping directories', () => {
    expect(
      issuesFor([
        'develop',
        {
          harness: 'behaviour',
          visible_paths: ['tests/**'],
          owned_dir: 'tests',
        },
        {
          harness: 'contract',
          visible_paths: ['tests/**'],
          owned_dir: 'tests/contract',
        },
      ]),
    ).toContain("overlaps pipeline entry 1's owned_dir");
  });

  it('refuses a glob or a reserved directory as owned_dir', () => {
    for (const bad of ['tests/**', '.adl/tests', './tests']) {
      expect(
        issuesFor([
          'develop',
          { harness: 'behaviour', visible_paths: ['**'], owned_dir: bad },
        ]),
        bad,
      ).toContain('owned_dir must be one repo-relative directory');
    }
  });

  it('survives into the EffectiveConfig schema unchanged', () => {
    const parsed = AdlYmlSchema.parse({
      ...BASE,
      pipeline: [
        'develop',
        {
          harness: 'behaviour',
          visible_paths: ['tests/behaviour/**'],
          owned_dir: 'tests/behaviour',
        },
      ],
    });
    const entry = EffectiveConfigSchema.shape.pipeline.parse(parsed.pipeline);
    expect(entry[1]).toMatchObject({ owned_dir: 'tests/behaviour' });
  });
});

describe('owned_dir reaches ResolvedStage', () => {
  it('is carried onto the resolved stage when declared', () => {
    const [, stage] = resolvePipeline([
      'develop',
      {
        harness: 'behaviour',
        visible_paths: ['tests/behaviour/**'],
        owned_dir: 'tests/behaviour',
      },
    ]);
    expect(stage?.ownedDir).toBe('tests/behaviour');
  });

  it('is absent — not undefined-valued — when the entry does not declare it', () => {
    const [plain, entry] = resolvePipeline(['develop', { harness: 'review' }]);
    expect('ownedDir' in (plain ?? {})).toBe(false);
    expect('ownedDir' in (entry ?? {})).toBe(false);
  });
});
