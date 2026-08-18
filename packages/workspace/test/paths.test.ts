/**
 * The D-02 containment guard, as a unit suite over a real temp directory.
 *
 * "Real" is load-bearing twice over. The guard's last step realpaths the
 * deepest existing part of the candidate, so a synthetic root would make the
 * symlink cases pass for no reason at all — and a suite that passes for no
 * reason is worse than an absent one, because it reads as proof. And the
 * sibling-prefix case (T-2-25) only means something if `feat-1` and
 * `feat-1-evil` are two directories that genuinely exist beside each other.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainmentError, WorkspaceError } from '../src/errors.js';
import {
  assertWithinRoot,
  isWithinRoot,
  resolveWithinRoot,
} from '../src/paths.js';

/** The parent of both the root and its confusingly named sibling. */
let scratch: string;
/** `<scratch>/feat-1` — the workspace root under test. */
let root: string;
/** `<scratch>/feat-1-evil` — a sibling whose NAME EXTENDS the root's. */
let sibling: string;

/**
 * Whether this process may create a symbolic link at all.
 *
 * On Windows an unprivileged process cannot create a file symlink without
 * Developer Mode, but it CAN create a directory *junction* — which is the same
 * escape from the guard's point of view, so the cases below use a directory
 * link and stay real on every platform this repository is developed on. If even
 * that fails, the two symlink cases report themselves skipped with the reason
 * rather than silently passing.
 */
let linkFailure: string | undefined;

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'adl-paths-')));
  root = join(scratch, 'feat-1');
  sibling = join(scratch, 'feat-1-evil');

  await mkdir(root);
  await mkdir(sibling);
  await writeFile(join(sibling, 'secret.txt'), 'the neighbour\n');

  try {
    // `<root>/escape` -> `<scratch>/feat-1-evil`. One link exercising BOTH
    // defects at once: a purely lexical guard accepts it because nothing
    // resolves upward, and a realpath-plus-bare-prefix guard accepts it too
    // because 'feat-1-evil' starts with 'feat-1'.
    await symlink(sibling, join(root, 'escape'), LINK_TYPE);
  } catch (error) {
    linkFailure = `this process cannot create a ${LINK_TYPE} link on ${process.platform}: ${(error as Error).message}`;
  }
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('containment: the lexical half', () => {
  it('accepts a plain relative path and returns where it resolves', () => {
    expect(resolveWithinRoot(root, 'notes.md')).toBe(join(root, 'notes.md'));
  });

  it('accepts a nested path whose directories do not exist yet', () => {
    expect(resolveWithinRoot(root, 'nested/dir/file.txt')).toBe(
      join(root, 'nested', 'dir', 'file.txt'),
    );
  });

  // One case per rejection `isRepoRelativePath` contributes, written out rather
  // than table-driven: when one of these goes red the failure should name the
  // exact class of path that stopped being refused.
  it.each([
    ['a `..` segment', '../escape.txt'],
    ['a `..` segment buried mid-path', 'a/../../escape.txt'],
    ['a backslash `..` segment', 'a\\..\\..\\escape.txt'],
    ['an absolute POSIX path', '/etc/passwd'],
    ['a drive-letter path', 'C:\\Windows\\System32\\config'],
    ['a UNC path', '\\\\server\\share\\secret'],
    ['a NUL byte', 'notes.md\0.png'],
    ['the empty string', ''],
  ])('rejects %s', (_name, candidate) => {
    expect(() => resolveWithinRoot(root, candidate)).toThrow(ContainmentError);
  });

  it('rejects a candidate resolving to the workspace root itself', () => {
    // `.` and `./` are the two spellings that survive the repo-relative schema
    // — neither contains a `..` segment — and both address a directory.
    for (const candidate of ['.', './']) {
      expect(() => resolveWithinRoot(root, candidate)).toThrow(
        ContainmentError,
      );
    }
  });

  it('names the candidate and never the resolved root', () => {
    // T-2-28. The root is the operator's absolute scratch path; a third-party
    // harness that provoked the rejection has no business learning it.
    let thrown: ContainmentError | undefined;
    try {
      resolveWithinRoot(root, '../escape.txt');
    } catch (error) {
      thrown = error as ContainmentError;
    }

    expect(thrown).toBeInstanceOf(ContainmentError);
    expect(thrown!.candidate).toBe('../escape.txt');
    expect(thrown!.message).toContain('../escape.txt');
    expect(thrown!.message).not.toContain(root);
    expect(thrown!.message).not.toContain(scratch);
  });

  it('rejects a sibling directory whose name extends the root’s', () => {
    // T-2-25, asserted against the predicate directly because no *lexical*
    // candidate can reach it — the schema has already excluded every string
    // that resolves upward. This is the case a bare `startsWith` accepts.
    expect(sibling.startsWith(root)).toBe(true); // the trap, spelled out
    expect(isWithinRoot(root, sibling)).toBe(false);
    expect(isWithinRoot(root, join(sibling, 'secret.txt'))).toBe(false);

    // ...and the same test the other way, so a guard that simply returned
    // `false` for everything could not pass this file.
    expect(isWithinRoot(root, join(root, 'inside.txt'))).toBe(true);
    expect(isWithinRoot(root, root)).toBe(true);
  });
});

describe('containment: the filesystem half', () => {
  it('rejects a symlink inside the root that points at the sibling', async (ctx) => {
    if (linkFailure !== undefined) ctx.skip(linkFailure);

    await expect(assertWithinRoot(root, 'escape/secret.txt')).rejects.toThrow(
      ContainmentError,
    );
  });

  it('rejects the symlinked directory itself, not only files under it', async (ctx) => {
    if (linkFailure !== undefined) ctx.skip(linkFailure);

    await expect(assertWithinRoot(root, 'escape')).rejects.toThrow(
      ContainmentError,
    );
  });

  it('accepts a write target that does not exist yet, under a directory that does not either', async () => {
    // The common case, and the reason the guard climbs to the deepest EXISTING
    // ancestor instead of realpathing the leaf: realpath would throw ENOENT
    // here and make `write` impossible.
    const absolute = await assertWithinRoot(root, 'nested/dir/file.txt');
    expect(absolute).toBe(join(root, 'nested', 'dir', 'file.txt'));

    await mkdir(join(root, 'nested', 'dir'), { recursive: true });
    await writeFile(absolute, 'written\n');
    await expect(readFile(absolute, 'utf8')).resolves.toBe('written\n');
  });

  it('accepts a file that already exists', async () => {
    const absolute = await assertWithinRoot(root, 'nested/dir/file.txt');
    expect(absolute).toBe(join(root, 'nested', 'dir', 'file.txt'));
  });

  it('refuses to verify containment against a root that does not exist', async () => {
    // The stub backend's root is a real `mkdtemp` directory precisely because
    // of this: with an imaginary root the realpath climb would walk past the
    // intended boundary to the OS temp directory and the guard would stop
    // testing anything while still returning cleanly.
    await expect(
      assertWithinRoot(join(scratch, 'no-such-root'), 'notes.md'),
    ).rejects.toThrow(WorkspaceError);
  });
});
