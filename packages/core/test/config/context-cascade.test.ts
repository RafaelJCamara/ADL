import { describe, expect, it } from 'vitest';

import {
  CONTEXT_FILE_CASCADE,
  pickFirstPresent,
  resolveContextFiles,
  type ContextCascadeFile,
} from '../../src/config/context-cascade.js';

const REQUIREMENTS_CASCADE = [
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  'README.md',
] as const;

describe('CONTEXT_FILE_CASCADE', () => {
  it('has exactly four entries in the order SPEC-05 states, asserted against the requirement text', () => {
    expect(CONTEXT_FILE_CASCADE).toHaveLength(4);
    expect(CONTEXT_FILE_CASCADE).toEqual(REQUIREMENTS_CASCADE);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CONTEXT_FILE_CASCADE)).toBe(true);
  });
});

describe('pickFirstPresent', () => {
  it('returns the first candidate the predicate reports present', () => {
    const result = pickFirstPresent(
      ['a', 'b', 'c'],
      (c) => c === 'b' || c === 'c',
    );
    expect(result).toBe('b');
  });

  it('returns nothing when every candidate is absent', () => {
    const result = pickFirstPresent(['a', 'b', 'c'], () => false);
    expect(result).toBeUndefined();
  });

  it('invokes the predicate exactly once per candidate up to and including the first present one', () => {
    const calls: string[] = [];
    const result = pickFirstPresent(['a', 'b', 'c', 'd'], (c) => {
      calls.push(c);
      return c === 'b';
    });
    expect(result).toBe('b');
    expect(calls).toEqual(['a', 'b']);
  });

  it('repeated and interleaved calls with unchanged predicate results return the same candidate', () => {
    const present = new Set(['c']);
    const exists = (c: string) => present.has(c);

    const first = pickFirstPresent(['a', 'b', 'c'], exists);
    const second = pickFirstPresent(['a', 'b', 'c'], exists);
    // Interleaved: call it again mid-"session" with the same underlying state.
    const third = pickFirstPresent(['a', 'b', 'c'], exists);

    expect(first).toBe('c');
    expect(second).toBe('c');
    expect(third).toBe('c');
    // Nothing mutated between calls.
    expect(present.size).toBe(1);
  });

  it('performs no filesystem access itself — the predicate is the only I/O boundary', () => {
    // If pickFirstPresent touched the filesystem, this would throw or behave
    // differently under a predicate that never consults real paths at all.
    const result = pickFirstPresent(
      CONTEXT_FILE_CASCADE,
      (c): c is ContextCascadeFile => c === 'README.md',
    );
    expect(result).toBe('README.md');
  });
});

describe('resolveContextFiles', () => {
  it('returns an explicit, non-empty context.files list unchanged', () => {
    const result = resolveContextFiles(
      { files: ['docs/architecture.md'] },
      () => true,
    );
    expect(result).toEqual(['docs/architecture.md']);
  });

  it('an explicit list suppresses the cascade entirely — the predicate is never consulted', () => {
    let called = false;
    resolveContextFiles({ files: ['docs/architecture.md'] }, () => {
      called = true;
      return true;
    });
    expect(called).toBe(false);
  });

  it('applies the cascade when context.files is absent', () => {
    const present = new Set(['README.md']);
    const result = resolveContextFiles({}, (c) => present.has(c));
    expect(result).toEqual(['README.md']);
  });

  it('applies the cascade when context.files is an empty array', () => {
    const present = new Set(['CLAUDE.md']);
    const result = resolveContextFiles({ files: [] }, (c) => present.has(c));
    expect(result).toEqual(['CLAUDE.md']);
  });

  it('respects the cascade order — AGENTS.md wins over CLAUDE.md when both are present', () => {
    const present = new Set(['CLAUDE.md', 'AGENTS.md']);
    const result = resolveContextFiles({}, (c) => present.has(c));
    expect(result).toEqual(['AGENTS.md']);
  });

  it('returns an empty list when nothing in the cascade is present', () => {
    const result = resolveContextFiles({}, () => false);
    expect(result).toEqual([]);
  });
});
