/**
 * The filesystem half of carrying a gate's `owned_dir` back (M08 step 8.6,
 * ROLE-09): `src/visible/carry-back.ts`.
 *
 * Directory links are made as junctions, which Windows creates without
 * privileges and which `lstat` reports as symbolic links, so the
 * link-refusal cases run on every platform. A FILE symlink needs a privilege
 * this Windows machine does not grant (probed: EPERM), so that one case is
 * POSIX-only, through the visible-skip helper.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  carryBackFiles,
  pruneOwnedDirectory,
  readOwnedFiles,
  restoreComposition,
  snapshotComposition,
} from '../../src/visible/carry-back.js';
import { posixOnly } from '../helpers/platform.js';

let scratch: string;
let copy: string;
let worktree: string;
let outside: string;
let backup: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'adl-carry-back-'));
  copy = join(scratch, 'copy');
  worktree = join(scratch, 'worktree');
  outside = join(scratch, 'outside');
  backup = join(scratch, 'backup');
  await mkdir(copy);
  await mkdir(worktree);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true, maxRetries: 10 });
});

async function put(root: string, path: string, contents: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents);
}

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');

describe('pruneOwnedDirectory', () => {
  it('removes everything under the directory git does not track, and nothing outside it', async () => {
    await put(copy, 'tests/own/a.test.mjs', 'tracked');
    await put(copy, 'tests/own/nested/planted.test.mjs', 'untracked');
    await put(copy, 'tests/other.test.mjs', 'outside the owned dir');

    const removed = await pruneOwnedDirectory(
      copy,
      'tests/own',
      new Set(['tests/own/a.test.mjs']),
    );

    expect(removed).toEqual(['tests/own/nested/planted.test.mjs']);
    await expect(
      readFile(join(copy, 'tests/own/a.test.mjs'), 'utf8'),
    ).resolves.toBe('tracked');
    await expect(
      readFile(join(copy, 'tests/other.test.mjs'), 'utf8'),
    ).resolves.toBe('outside the owned dir');
  });

  it('removes a planted directory link without touching what it points at', async () => {
    await put(outside, 'secret.txt', 'keep me');
    await mkdir(join(copy, 'tests/own'), { recursive: true });
    await symlink(outside, join(copy, 'tests/own/link'), 'junction');

    expect(await pruneOwnedDirectory(copy, 'tests/own', new Set())).toEqual([
      'tests/own/link',
    ]);
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe(
      'keep me',
    );
  });
});

describe('snapshotComposition + restoreComposition', () => {
  it('puts everything outside the owned directory back as composed, and leaves the directory alone', async () => {
    await put(worktree, 'tests/helpers.mjs', 'composed helper');
    await put(worktree, 'package.json', '{"type":"module"}');
    await put(copy, 'tests/helpers.mjs', 'composed helper');
    await put(copy, 'package.json', '{"type":"module"}');
    await put(copy, 'tests/own/a.test.mjs', 'the gate’s');
    const snapshot = await snapshotComposition(copy);

    // What a tester might do outside its own directory: add a helper its test
    // imports, change one that was composed, delete another.
    await put(copy, 'tests/extra-helper.mjs', 'never committed');
    await writeFile(
      join(copy, 'tests/helpers.mjs'),
      'changed by the gate, much longer',
    );
    await rm(join(copy, 'package.json'));
    // And inside it, which is the gate's to change.
    await put(copy, 'tests/own/b.test.mjs', 'also the gate’s');

    const result = await restoreComposition({
      root: copy,
      source: worktree,
      snapshot,
      except: 'tests/own',
    });

    expect(result).toEqual({
      removed: ['tests/extra-helper.mjs'],
      restored: ['package.json', 'tests/helpers.mjs'],
    });
    await expect(
      readFile(join(copy, 'tests/helpers.mjs'), 'utf8'),
    ).resolves.toBe('composed helper');
    await expect(readFile(join(copy, 'package.json'), 'utf8')).resolves.toBe(
      '{"type":"module"}',
    );
    expect((await readdir(join(copy, 'tests/own'))).sort()).toEqual([
      'a.test.mjs',
      'b.test.mjs',
    ]);
  });
});

describe('readOwnedFiles', () => {
  it('reads every regular file under the directory, in path order, minus the excluded ones', async () => {
    await put(copy, 'tests/own/b.test.mjs', 'b');
    await put(copy, 'tests/own/a.test.mjs', 'a');
    await put(copy, 'tests/own/deep/c.mjs', Buffer.from([0x00, 0xff]));
    await put(copy, 'tests/own/from-main.test.mjs', 'an earlier feature’s');
    await put(copy, 'tests/elsewhere.test.mjs', 'not owned');

    const read = await readOwnedFiles(
      copy,
      'tests/own',
      new Set(['tests/own/from-main.test.mjs']),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect([...read.files.keys()]).toEqual([
      'tests/own/a.test.mjs',
      'tests/own/b.test.mjs',
      'tests/own/deep/c.mjs',
    ]);
    expect(read.files.get('tests/own/deep/c.mjs')).toEqual(
      Buffer.from([0x00, 0xff]),
    );
  });

  it('answers with nothing, not an error, when the directory does not exist yet', async () => {
    const read = await readOwnedFiles(copy, 'tests/own');
    expect(read.ok && read.files.size).toBe(0);
  });

  it('refuses a directory link rather than following it', async () => {
    await put(outside, 'secret.txt', 'secret');
    await put(copy, 'tests/own/a.test.mjs', 'a');
    await symlink(outside, join(copy, 'tests/own/escape'), 'junction');

    const read = await readOwnedFiles(copy, 'tests/own');
    expect(read.ok).toBe(false);
    expect(read.ok ? '' : read.detail).toContain('tests/own/escape');
  });

  it('does not refuse a link an EARLIER feature committed — it is excluded, not the gate’s', async () => {
    await put(copy, 'tests/own/a.test.mjs', 'a');
    await symlink(outside, join(copy, 'tests/own/earlier-link'), 'junction');

    const read = await readOwnedFiles(
      copy,
      'tests/own',
      new Set(['tests/own/earlier-link']),
    );
    expect(read.ok && [...read.files.keys()]).toEqual(['tests/own/a.test.mjs']);
  });

  it('refuses the owned directory itself being a link', async () => {
    await mkdir(join(copy, 'tests'), { recursive: true });
    await symlink(outside, join(copy, 'tests/own'), 'junction');

    expect((await readOwnedFiles(copy, 'tests/own')).ok).toBe(false);
  });

  it('refuses a file symlink', async () => {
    const gate = posixOnly(
      'creating a file symlink needs a privilege Windows does not grant by default (probed: EPERM)',
      'ROLE-09',
    );
    if (gate.kind === 'skip') return;
    await put(outside, 'secret.txt', 'secret');
    await mkdir(join(copy, 'tests/own'), { recursive: true });
    await symlink(
      join(outside, 'secret.txt'),
      join(copy, 'tests/own/a.test.mjs'),
    );

    expect((await readOwnedFiles(copy, 'tests/own')).ok).toBe(false);
  });
});

describe('carryBackFiles', () => {
  it('writes bytes exactly, creates directories, deletes what the gate removed, and reports every path', async () => {
    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x0a, 0x80]);
    await put(worktree, 'tests/own/stale.test.mjs', 'the gate deleted this');
    await put(worktree, 'tests/own/a.test.mjs', 'old version');

    const result = await carryBackFiles({
      to: worktree,
      dir: 'tests/own',
      write: new Map([
        ['tests/own/a.test.mjs', bytes('new test')],
        ['tests/own/fixtures/blob.bin', binary],
      ]),
      remove: ['tests/own/stale.test.mjs'],
      backup,
    });

    expect(result.ok && result.touched).toEqual([
      'tests/own/a.test.mjs',
      'tests/own/fixtures/blob.bin',
      'tests/own/stale.test.mjs',
    ]);
    await expect(
      readFile(join(worktree, 'tests/own/a.test.mjs'), 'utf8'),
    ).resolves.toBe('new test');
    expect(
      Buffer.compare(
        await readFile(join(worktree, 'tests/own/fixtures/blob.bin')),
        binary,
      ),
    ).toBe(0);
    expect(await readdir(join(worktree, 'tests/own'))).not.toContain(
      'stale.test.mjs',
    );
  });

  it('can be undone exactly — written files gone, overwritten and removed ones back', async () => {
    await put(worktree, 'tests/own/a.test.mjs', 'old version');
    await put(worktree, 'tests/own/stale.test.mjs', 'removed, then restored');

    const result = await carryBackFiles({
      to: worktree,
      dir: 'tests/own',
      write: new Map([
        ['tests/own/a.test.mjs', bytes('new')],
        ['tests/own/new.test.mjs', bytes('new file')],
      ]),
      remove: ['tests/own/stale.test.mjs'],
      backup,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await result.undo();
    await result.discard();

    expect((await readdir(join(worktree, 'tests/own'))).sort()).toEqual([
      'a.test.mjs',
      'stale.test.mjs',
    ]);
    await expect(
      readFile(join(worktree, 'tests/own/a.test.mjs'), 'utf8'),
    ).resolves.toBe('old version');
    await expect(readdir(scratch)).resolves.not.toContain('backup');
  });

  it('keeps a case-only rename — the removal happens before the write', async () => {
    // On a case-insensitive filesystem (Windows, macOS by default) the two
    // names are ONE file: removing second would delete what was just written.
    await put(worktree, 'tests/own/health.test.mjs', 'old');

    const result = await carryBackFiles({
      to: worktree,
      dir: 'tests/own',
      write: new Map([['tests/own/Health.test.mjs', bytes('renamed')]]),
      remove: ['tests/own/health.test.mjs'],
      backup,
    });

    expect(result.ok).toBe(true);
    expect(await readdir(join(worktree, 'tests/own'))).toEqual([
      'Health.test.mjs',
    ]);
  });

  it('refuses a path outside the owned directory before touching anything', async () => {
    for (const bad of [
      'src/server.mjs',
      'tests/own/../../src/server.mjs',
      'tests/own/./a.test.mjs',
    ]) {
      const result = await carryBackFiles({
        to: worktree,
        dir: 'tests/own',
        write: new Map([
          ['tests/own/a.test.mjs', bytes('a')],
          [bad, bytes('not the gate’s to write')],
        ]),
        remove: [],
        backup,
      });
      expect(result.ok, bad).toBe(false);
    }
    await expect(readdir(worktree)).resolves.toEqual([]);
  });

  it('refuses to write through a directory the worktree has turned into a link, and leaves nothing behind', async () => {
    await put(worktree, 'tests/own/a.test.mjs', 'kept');
    await mkdir(join(worktree, 'tests/own/deep'), { recursive: true });
    await rm(join(worktree, 'tests/own/deep'), { recursive: true });
    await symlink(outside, join(worktree, 'tests/own/deep'), 'junction');

    const result = await carryBackFiles({
      to: worktree,
      dir: 'tests/own',
      // The first write succeeds; the second would go through the link.
      write: new Map([
        ['tests/own/a.test.mjs', bytes('overwritten')],
        ['tests/own/deep/b.test.mjs', bytes('b')],
      ]),
      remove: [],
      backup,
    });

    expect(result.ok).toBe(false);
    await expect(readdir(outside)).resolves.toEqual([]);
    // All or nothing: the first write was undone.
    await expect(
      readFile(join(worktree, 'tests/own/a.test.mjs'), 'utf8'),
    ).resolves.toBe('kept');
  });
});
