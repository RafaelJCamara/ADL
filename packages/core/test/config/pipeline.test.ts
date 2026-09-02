import { describe, expect, it } from 'vitest';

import { GROUP_SYNTAX_REJECTION } from '../../src/config/adl-yml.js';
import {
  BUILT_IN_STAGE_IDS,
  HarnessResolutionError,
  resolvePipeline,
  type HarnessRegistry,
} from '../../src/config/pipeline.js';

function registry(overrides: Partial<HarnessRegistry> = {}): HarnessRegistry {
  return {
    builtIns: new Set(BUILT_IN_STAGE_IDS),
    npmPackages: new Set(),
    repoPaths: new Set(),
    ...overrides,
  };
}

describe('resolvePipeline — built-in bare strings', () => {
  it('resolves a pipeline of bare built-in names to a same-length, same-order stage list', () => {
    const result = resolvePipeline(['develop', 'review', 'test'], registry());
    expect(result.map((s) => s.id)).toEqual(['develop', 'review', 'test']);
    expect(result.every((s) => s.source === 'built-in')).toBe(true);
  });

  it('an unknown bare name fails at resolution, naming the id', () => {
    expect(() => resolvePipeline(['not-a-real-stage'], registry())).toThrow(
      HarnessResolutionError,
    );
    try {
      resolvePipeline(['not-a-real-stage'], registry());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessResolutionError);
      expect((error as HarnessResolutionError).message).toMatch(
        /not-a-real-stage/,
      );
      expect((error as HarnessResolutionError).harnessId).toBe(
        'not-a-real-stage',
      );
    }
  });
});

describe('resolvePipeline — harness resolution order (D-23)', () => {
  it('prefers the built-in registry when the same id is available in every tier', () => {
    const reg = registry({
      builtIns: new Set(['security']),
      npmPackages: new Set(['security']),
      repoPaths: new Set(['security']),
    });
    const [stage] = resolvePipeline([{ harness: 'security' }], reg);
    expect(stage?.source).toBe('built-in');
  });

  it('prefers an npm package over a repo-relative path when both are available', () => {
    const reg = registry({
      builtIns: new Set(),
      npmPackages: new Set(['security']),
      repoPaths: new Set(['security']),
    });
    const [stage] = resolvePipeline([{ harness: 'security' }], reg);
    expect(stage?.source).toBe('npm');
  });

  it('falls back to a repo-relative path when neither built-in nor npm has the id', () => {
    const reg = registry({ repoPaths: new Set(['security']) });
    const [stage] = resolvePipeline([{ harness: 'security' }], reg);
    expect(stage?.source).toBe('repo-path');
  });

  it('an id unknown to every tier fails at resolution, naming the id', () => {
    expect(() =>
      resolvePipeline([{ harness: 'ghost-harness' }], registry()),
    ).toThrow(HarnessResolutionError);
    try {
      resolvePipeline([{ harness: 'ghost-harness' }], registry());
      expect.unreachable();
    } catch (error) {
      expect((error as HarnessResolutionError).harnessId).toBe('ghost-harness');
    }
  });
});

describe('resolvePipeline — the path guard runs before any tier is consulted', () => {
  it('rejects a repo-relative harness path containing a parent-directory segment', () => {
    const reg = registry({ repoPaths: new Set(['../etc/passwd']) });
    expect(() => resolvePipeline([{ harness: '../etc/passwd' }], reg)).toThrow(
      HarnessResolutionError,
    );
  });

  it('rejects an absolute harness path even if it is present in a registry tier', () => {
    const reg = registry({ repoPaths: new Set(['/etc/passwd']) });
    expect(() => resolvePipeline([{ harness: '/etc/passwd' }], reg)).toThrow(
      HarnessResolutionError,
    );
  });
});

describe('resolvePipeline — duplicate stage ids', () => {
  it('two entries resolving to the same stage id fail with a duplicate-id message', () => {
    expect(() => resolvePipeline(['develop', 'develop'], registry())).toThrow(
      /duplicate/i,
    );
  });

  it('a bare built-in id colliding with a harness id also fails as a duplicate', () => {
    const reg = registry({ npmPackages: new Set(['review']) });
    expect(() =>
      resolvePipeline(['review', { harness: 'review' }], reg),
    ).toThrow(/duplicate/i);
  });
});

describe('resolvePipeline — the group: syntax is parsed and rejected', () => {
  it('resolves a group entry to a rejection naming it a future capability, not a stage', () => {
    expect(() =>
      resolvePipeline([{ group: [{ harness: 'security' }] }], registry()),
    ).toThrow(GROUP_SYNTAX_REJECTION);
  });
});

describe('resolvePipeline — adding a harness yields exactly one more stage', () => {
  it('a four-entry pipeline built from a three-entry one is one longer, with all ids unique', () => {
    const three = resolvePipeline(['develop', 'review', 'test'], registry());
    const four = resolvePipeline(
      ['develop', 'review', { harness: 'security' }, 'test'],
      registry({ repoPaths: new Set(['security']) }),
    );

    expect(four).toHaveLength(three.length + 1);
    expect(new Set(four.map((s) => s.id)).size).toBe(four.length);
  });
});

describe('resolvePipeline — with and on_send_back pass through', () => {
  it('carries harness-specific config and the send-back policy on the resolved stage', () => {
    const reg = registry({ repoPaths: new Set(['security']) });
    const [stage] = resolvePipeline(
      [
        {
          harness: 'security',
          with: { level: 'strict' },
          on_send_back: 'stop',
        },
      ],
      reg,
    );
    expect(stage?.with).toEqual({ level: 'strict' });
    expect(stage?.onSendBack).toBe('stop');
  });
});

/**
 * The plain-command gate (HARN-02, M07 step 7.3).
 *
 * The property under test is that a gate carrying its own program needs **no
 * registry entry at all**. D-23's three tiers each answer "where is the
 * module?"; a command gate has no module, so it has no tier — and that is what
 * makes it the extension point available before M13's loader exists.
 */
describe('resolvePipeline — a gate that carries its own command', () => {
  it('resolves an id the registry has never heard of, because the entry names its own program', () => {
    // An empty registry: not a built-in, not an npm package, not a repo path.
    // This exact entry throws `unknown harness id` without the `with.command`
    // block, which is the assertion below.
    const [stage] = resolvePipeline(
      [
        {
          harness: 'lint',
          with: { command: { argv: ['npm', 'run', 'lint'] } },
        },
      ],
      { builtIns: new Set(), npmPackages: new Set(), repoPaths: new Set() },
    );

    expect(stage?.id).toBe('lint');
    expect(stage?.source).toBe('command');
  });

  it('still refuses the same id when it declares no command — the bypass is the command, not the id', () => {
    expect(() =>
      resolvePipeline([{ harness: 'lint' }], {
        builtIns: new Set(),
        npmPackages: new Set(),
        repoPaths: new Set(),
      }),
    ).toThrow(HarnessResolutionError);
  });

  it('still runs the path guard, because the id still becomes a stage id', () => {
    // A command gate skips the REGISTRY, never the guard. The id is what
    // verdicts, `stage_attempts` and coverage rows join on, and one that could
    // be read as a filesystem path is exactly as dangerous here as anywhere.
    expect(() =>
      resolvePipeline(
        [
          {
            harness: '../escape',
            with: { command: { argv: ['true'] } },
          },
        ],
        registry(),
      ),
    ).toThrow(HarnessResolutionError);
  });

  it('still refuses a duplicate id', () => {
    expect(() =>
      resolvePipeline(
        [
          { harness: 'lint', with: { command: { argv: ['a'] } } },
          { harness: 'lint', with: { command: { argv: ['b'] } } },
        ],
        registry(),
      ),
    ).toThrow(HarnessResolutionError);
  });

  it('does not treat a non-object `command` as a command declaration', () => {
    // Structural recognition has to be narrow: a `with: { command: "lint" }`
    // typo must fall through to the registry and be refused by name, not
    // resolve to a command gate that then cannot find a program to run.
    expect(() =>
      resolvePipeline(
        [{ harness: 'lint', with: { command: 'npm run lint' } }],
        {
          builtIns: new Set(),
          npmPackages: new Set(),
          repoPaths: new Set(),
        },
      ),
    ).toThrow(HarnessResolutionError);
  });

  it('lets a built-in id keep its built-in source even if it also names a command', () => {
    // Order matters for `costClassOf`, which prices `built-in` differently.
    // A `with.command` on a built-in id is a maintainer overriding what the
    // built-in runs, not a new third-party gate — so the source stays
    // `command` and the *price* falls back to the conservative default, which
    // is the honest answer for a program ADL did not supply.
    const [stage] = resolvePipeline(
      [{ harness: 'test', with: { command: { argv: ['npm', 'test'] } } }],
      registry(),
    );
    expect(stage?.source).toBe('command');
  });
});
