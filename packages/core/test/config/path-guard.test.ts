import { describe, expect, it } from 'vitest';

import { isRepoRelativePath, RepoRelativePathSchema } from '../../src/config/path-guard.js';

/**
 * Threat T-1-02. Every path in `adl.yml` — a context file entry, a command's
 * working directory, a prompt template — is repo-supplied, and D-22 records
 * that repo-supplied means untrusted. The rejection happens here, at schema
 * level, so a traversal never reaches a filesystem call in Phase 2.
 */

const ACCEPTED = [
  'README.md',
  'docs/architecture.md',
  'a/b/c/d/deeply/nested.txt',
  'src/config/adl-yml.ts',
  '.github/copilot-instructions.md',
  '...hidden',
  'a/..b/c',
  'release-1.2.3/notes.md',
  'a\\b\\windows-relative.txt',
];

const REJECTED: ReadonlyArray<readonly [string, string]> = [
  ['/etc/passwd', 'absolute POSIX path'],
  ['/', 'the filesystem root'],
  ['../secrets.env', 'a leading parent-directory segment'],
  ['a/../../etc/passwd', 'an interior parent-directory segment'],
  ['..', 'a bare parent-directory segment'],
  ['a/..', 'a trailing parent-directory segment'],
  ['..\\secrets.env', 'a parent-directory segment with a backslash separator'],
  ['a\\..\\..\\etc', 'interior parent-directory segments with backslash separators'],
  ['C:\\Windows\\System32\\config', 'a Windows drive-letter path'],
  ['c:/windows/system32', 'a lowercase drive-letter path with forward slashes'],
  ['\\\\server\\share\\secrets', 'a UNC path'],
  ['docs/a\u0000.md', 'an embedded NUL byte'],
  ['\u0000', 'a bare NUL byte'],
  ['', 'the empty string'],
];

describe('RepoRelativePathSchema', () => {
  it('accepts a plain relative path and a nested relative path', () => {
    for (const value of ACCEPTED) {
      expect(RepoRelativePathSchema.safeParse(value).success, value).toBe(true);
    }
  });

  it.each(REJECTED)('rejects %j — %s', (value) => {
    expect(RepoRelativePathSchema.safeParse(value).success).toBe(false);
  });

  it('rejects a non-string', () => {
    for (const value of [42, null, undefined, ['a'], { path: 'a' }]) {
      expect(RepoRelativePathSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it('does not mistake a filename that merely starts with dots for a traversal', () => {
    // `..` is only a traversal when it is a whole path *segment*. A file named
    // `..gitignore` or a directory named `..build` is legal and must not be
    // rejected by an over-eager substring check.
    for (const value of ['..gitignore', 'a/..build/x.ts', 'x..y', 'a/b..']) {
      expect(RepoRelativePathSchema.safeParse(value).success, value).toBe(true);
    }
  });
});

describe('isRepoRelativePath', () => {
  it('agrees with the schema on every case', () => {
    for (const value of ACCEPTED) {
      expect(isRepoRelativePath(value), value).toBe(true);
    }
    for (const [value] of REJECTED) {
      expect(isRepoRelativePath(value), value).toBe(false);
    }
  });

  it('is a pure predicate — it reads no filesystem and reports nothing about existence', () => {
    // A path that certainly does not exist is still a *valid* repo-relative
    // path. Existence is Phase 2's question; shape is this one's.
    expect(isRepoRelativePath('does/not/exist/anywhere.txt')).toBe(true);
  });
});
