import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isWithinRoot } from '@adl/workspace';
import {
  logsRootFor,
  TRANSCRIPT_EXTENSION,
  transcriptPathFor,
  TranscriptAddressError,
  type TranscriptAddress,
} from '../../src/index.js';

/**
 * Phase 4 Plan 05, Task 1: `transcriptPathFor` is a pure function of a
 * resolved `TranscriptAddress` — `logs/<feature>/<round>/<stage>/<attempt>
 * .ndjson` (`ARCHITECTURE.md` §4) — and refuses a hostile component rather
 * than sanitising it.
 */

const ROOT = process.platform === 'win32' ? 'C:\\adl\\logs' : '/adl/logs';

function address(
  overrides: Partial<TranscriptAddress> = {},
): TranscriptAddress {
  return {
    featureId: 'feat-01HXA',
    roundId: 'round-01HXB',
    stageId: 'develop',
    stageIndex: 0,
    attempt: 1,
    ...overrides,
  };
}

describe('transcriptPathFor', () => {
  it('produces a path under root with one directory level per address component and the attempt number as the filename stem', () => {
    const path = transcriptPathFor(ROOT, address());

    expect(path).toBe(
      [
        ROOT,
        'feat-01HXA',
        'round-01HXB',
        'develop',
        `1${TRANSCRIPT_EXTENSION}`,
      ].join(sep),
    );
  });

  it('the same address twice produces the identical path string', () => {
    const first = transcriptPathFor(ROOT, address());
    const second = transcriptPathFor(ROOT, address());
    expect(first).toBe(second);
  });

  it('two attempts of the same stage differing only in attempt number produce different paths', () => {
    const first = transcriptPathFor(ROOT, address({ attempt: 1 }));
    const second = transcriptPathFor(ROOT, address({ attempt: 2 }));
    expect(first).not.toBe(second);
  });

  it('every path produced for a set of valid addresses satisfies the workspace package containment check against the logs root', () => {
    const addresses = [
      address(),
      address({ attempt: 7 }),
      address({ featureId: 'feat-02', roundId: 'round-02', stageId: 'review' }),
      address({ stageId: 'stage_with-Mixed.Chars123' }),
    ];

    for (const a of addresses) {
      const path = transcriptPathFor(ROOT, a);
      expect(isWithinRoot(ROOT, path)).toBe(true);
    }
  });

  describe('refuses a hostile component rather than sanitising it', () => {
    it('a feature id containing a parent-directory reference throws a named error', () => {
      expect(() =>
        transcriptPathFor(ROOT, address({ featureId: '../escape' })),
      ).toThrow(TranscriptAddressError);
    });

    it('a stage id equal to ".." throws a named error', () => {
      expect(() => transcriptPathFor(ROOT, address({ stageId: '..' }))).toThrow(
        TranscriptAddressError,
      );
    });

    it('a round id containing a path separator throws a named error', () => {
      expect(() =>
        transcriptPathFor(ROOT, address({ roundId: 'a/b' })),
      ).toThrow(TranscriptAddressError);
      expect(() =>
        transcriptPathFor(ROOT, address({ roundId: 'a\\b' })),
      ).toThrow(TranscriptAddressError);
    });

    it('a component carrying a NUL byte throws a named error', () => {
      expect(() =>
        transcriptPathFor(ROOT, address({ featureId: 'feat\0evil' })),
      ).toThrow(TranscriptAddressError);
    });

    it('a component carrying a drive-letter prefix throws a named error', () => {
      expect(() =>
        transcriptPathFor(ROOT, address({ stageId: 'C:evil' })),
      ).toThrow(TranscriptAddressError);
    });

    it('an empty component throws a named error', () => {
      expect(() => transcriptPathFor(ROOT, address({ featureId: '' }))).toThrow(
        TranscriptAddressError,
      );
    });

    it('a non-positive-integer attempt throws a named error', () => {
      expect(() => transcriptPathFor(ROOT, address({ attempt: 0 }))).toThrow(
        TranscriptAddressError,
      );
      expect(() => transcriptPathFor(ROOT, address({ attempt: 1.5 }))).toThrow(
        TranscriptAddressError,
      );
    });

    it('the thrown error names the offending component', () => {
      try {
        transcriptPathFor(ROOT, address({ stageId: '../x' }));
        expect.unreachable('expected transcriptPathFor to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(TranscriptAddressError);
        expect((error as TranscriptAddressError).component).toBe('stageId');
      }
    });
  });

  it('the builder accepts only the resolved address type, never a bare string id', () => {
    expect(() => {
      // @ts-expect-error — transcriptPathFor requires a resolved
      // TranscriptAddress; a bare string id must be a type error, not a
      // runtime one (see the module docblock's "pure function of a
      // resolved attempt address"). Wrapped in `expect(...).toThrow()`
      // because the compiler's rejection does not stop this line from
      // actually executing at runtime under `vitest` — only `tsc` reads
      // the `@ts-expect-error` comment; the call underneath it still runs.
      transcriptPathFor(ROOT, 'feat-01HXA');
    }).toThrow();
  });
});

describe('logsRootFor', () => {
  it('derives the logs root as a "logs" directory beside the database file, mirroring scratchRoot', () => {
    const dbFilePath =
      process.platform === 'win32'
        ? 'C:\\adl\\state\\adl.db'
        : '/adl/state/adl.db';
    const root = logsRootFor(dbFilePath);
    expect(root).toBe(
      (process.platform === 'win32' ? 'C:\\adl\\state' : '/adl/state') +
        sep +
        'logs',
    );
  });

  it('two calls with the same database file path produce the identical root', () => {
    const dbFilePath =
      process.platform === 'win32'
        ? 'C:\\adl\\state\\adl.db'
        : '/adl/state/adl.db';
    expect(logsRootFor(dbFilePath)).toBe(logsRootFor(dbFilePath));
  });
});
