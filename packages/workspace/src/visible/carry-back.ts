/**
 * Carrying a gate's owned directory back out of its composed workspace (M08
 * step 8.6, ROLE-09) — the filesystem half; `ManagerGitClient.add`/`commit`
 * are the git half, and `@adl/manager`'s stage runner sequences the two.
 *
 * A gate that declares `owned_dir` works in a materialised copy with no `.git`
 * (`compose.ts`), so it cannot commit anything itself — which is the point: the
 * spike's fourth decision was that ADL carries the surviving files back and
 * commits them, at a moment ADL controls. Each operation answers one question:
 *
 * 1. {@link pruneOwnedDirectory} — *what may the gate start from?* Only what
 *    is committed. The copy is a walk of the worktree's filesystem, so a file
 *    under the directory that git does not track — something a developer left
 *    there, or one a `.gitignore` the developer committed hides from `git
 *    status` — would otherwise be run as the gate's own and committed under
 *    ADL's name. Pruned before the gate runs, so it is never seen at all.
 * 2. {@link snapshotComposition} and {@link restoreComposition} — *what else
 *    may the run depend on?* Only what ADL composed. A tester can write a
 *    helper next to its tests but outside the owned directory, and a run that
 *    passes only because of a file that is never committed judged something
 *    that does not land. So before ADL's own run, everything outside the owned
 *    directory goes back to the composition: files the gate added are removed,
 *    files it changed or removed are copied in again from the worktree.
 * 3. {@link readOwnedFiles} — *what is the gate's, now?* Every regular file
 *    under the directory, minus the paths the caller says belong to someone
 *    else, READ INTO MEMORY at that moment. Those bytes are what ADL's run uses
 *    the paths of and what the commit writes, so a runner that rewrites a file
 *    while it runs (a snapshot, a cache) cannot make the commit differ from
 *    the run. Anything that is not a regular file or a directory — a symlink
 *    above all — is a refusal, not a skip, and every read refuses to follow a
 *    link where the platform can say so (`O_NOFOLLOW`).
 * 4. {@link carryBackFiles} — *make the worktree say exactly that, or nothing.*
 *    Removals before writes, so a case-only rename on a case-insensitive
 *    filesystem cannot delete the file it just wrote. Every destination is
 *    checked against the real path of the worktree, so a directory the
 *    developer turned into a link cannot route ADL's write somewhere else. And
 *    every file it is about to overwrite or remove is backed up first, so a
 *    carry-back that fails half-way can be undone: a worktree left dirty under
 *    the owned directory would make the next attempt's "only ADL writes here"
 *    check refuse, and blame the developer for it.
 *
 * Paths here are repo-relative with forward slashes, the shape git and
 * `owned_dir` both use. Classify, don't throw (convention 5): a refusal is a
 * result naming the path; only an I/O failure ADL could not have predicted
 * throws.
 */
import { constants } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/** A path is under `dir` (segment-wise) or is `dir` itself. */
function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/** Repo-relative, forward slashes, no `.`/`..`/empty segment. */
function isCleanRelative(path: string): boolean {
  return (
    !path.includes('\\') &&
    path
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Every entry under `root/dir` (or all of `root`), by lstat — links reported, never followed. */
async function walk(
  root: string,
  dir?: string,
): Promise<{ readonly files: string[]; readonly others: string[] }> {
  const files: string[] = [];
  const others: string[] = [];
  async function visit(relDir: string | undefined): Promise<void> {
    let entries;
    try {
      entries = await readdir(
        relDir === undefined ? root : join(root, relDir),
        {
          withFileTypes: true,
        },
      );
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const rel = relDir === undefined ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(rel);
      } else if (entry.isFile()) {
        files.push(rel);
      } else {
        others.push(rel);
      }
    }
  }
  if (dir !== undefined) {
    // The directory itself must be a directory. A link AT the owned path is the
    // case `Dirent` cannot see from inside it.
    try {
      const top = await lstat(join(root, dir));
      if (!top.isDirectory()) {
        others.push(dir);
        return { files, others };
      }
    } catch (error) {
      if (isMissing(error)) return { files, others };
      throw error;
    }
  }
  await visit(dir);
  files.sort();
  others.sort();
  return { files, others };
}

/**
 * Remove from `root/dir` every file — and anything else — whose path is not in
 * `keep`, and report what went. Run against a freshly composed copy, with
 * `keep` set to what git tracks under `dir` at HEAD.
 */
export async function pruneOwnedDirectory(
  root: string,
  dir: string,
  keep: ReadonlySet<string>,
): Promise<readonly string[]> {
  const { files, others } = await walk(root, dir);
  const removed: string[] = [];
  for (const path of [...files, ...others]) {
    if (keep.has(path)) continue;
    // `rm` on a link removes the link, never its target.
    await rm(join(root, path), { recursive: true, force: true });
    removed.push(path);
  }
  return removed.sort();
}

/** What a composed workspace held, entry by entry — {@link snapshotComposition}. */
export type CompositionSnapshot = ReadonlyMap<string, string>;

/** Size and modification time — what "unchanged since composition" is judged on. */
function stampOf(stats: {
  size: number;
  mtimeMs: number;
  isFile(): boolean;
}): string {
  return `${stats.isFile() ? 'f' : 'o'}:${String(stats.size)}:${String(stats.mtimeMs)}`;
}

/**
 * Record every entry of a freshly composed workspace — files and links alike —
 * so {@link restoreComposition} can put it back. Stat only, never content: the
 * composition may hold an installed dependency tree.
 */
export async function snapshotComposition(
  root: string,
): Promise<CompositionSnapshot> {
  const { files, others } = await walk(root);
  const snapshot = new Map<string, string>();
  for (const path of [...files, ...others]) {
    snapshot.set(path, stampOf(await lstat(join(root, path))));
  }
  return snapshot;
}

/**
 * Put everything outside `except` back to what {@link snapshotComposition}
 * recorded: entries the gate added are removed, and entries it changed or
 * removed are copied in again from `source` — the worktree the composition was
 * taken from, with the same `cp` the composition used.
 */
export async function restoreComposition(input: {
  readonly root: string;
  readonly source: string;
  readonly snapshot: CompositionSnapshot;
  readonly except: string;
}): Promise<{
  readonly removed: readonly string[];
  readonly restored: readonly string[];
}> {
  const { files, others } = await walk(input.root);
  const removed: string[] = [];
  const restored: string[] = [];
  for (const path of [...files, ...others]) {
    if (isWithin(path, input.except) || input.snapshot.has(path)) continue;
    await rm(join(input.root, path), { recursive: true, force: true });
    removed.push(path);
  }
  for (const [path, stamp] of input.snapshot) {
    if (isWithin(path, input.except)) continue;
    const destination = join(input.root, path);
    let current: string | undefined;
    try {
      current = stampOf(await lstat(destination));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (current === stamp) continue;
    await rm(destination, { recursive: true, force: true });
    try {
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(input.source, path), destination, {
        errorOnExist: false,
        force: true,
      });
    } catch (error) {
      // Gone from the source too: a fresh composition would not have it either.
      if (!isMissing(error)) throw error;
    }
    restored.push(path);
  }
  return { removed: removed.sort(), restored: restored.sort() };
}

/** What {@link readOwnedFiles} read, or the one entry it would not accept. */
export type OwnedFileContents =
  | { readonly ok: true; readonly files: ReadonlyMap<string, Buffer> }
  | { readonly ok: false; readonly detail: string };

/** Open without following a link where the platform can refuse one, and require a regular file. */
async function readRegularFile(absolute: string): Promise<Buffer | undefined> {
  const before = await lstat(absolute);
  if (!before.isFile()) return undefined;
  // `O_NOFOLLOW` is POSIX; on Windows it is absent and the lstat above is the
  // check — `DEBT.md` D-8-06-5 carries the window between the two.
  const handle = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Every regular file under `root/dir` that is not in `exclude`, with its bytes,
 * in path order — or a refusal naming the first entry, not excluded, that is
 * not a regular file or a directory.
 *
 * `exclude` is the caller's answer to "which of these belong to someone else"
 * — for the stage runner, files an earlier feature committed. It applies before
 * the refusal: a link an earlier feature committed is not this gate's, and must
 * not stop every gate after it.
 */
export async function readOwnedFiles(
  root: string,
  dir: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<OwnedFileContents> {
  const { files, others } = await walk(root, dir);
  const refuse = (path: string): OwnedFileContents => ({
    ok: false,
    detail:
      `${path} is not a regular file — ADL commits only regular files out of ${dir}, ` +
      'and will not follow or commit a symbolic link, a socket or a device',
  });
  const [first] = others.filter((path) => !exclude.has(path));
  if (first !== undefined) return refuse(first);
  const contents = new Map<string, Buffer>();
  for (const path of files) {
    if (exclude.has(path)) continue;
    const bytes = await readRegularFile(join(root, path));
    if (bytes === undefined) return refuse(path);
    contents.set(path, bytes);
  }
  return { ok: true, files: contents };
}

export interface CarryBackInput {
  /** The developer's worktree root — where the branch is. */
  readonly to: string;
  /** The owned directory every path below must lie within. */
  readonly dir: string;
  /** Files to write, with the bytes to write — {@link readOwnedFiles}' answer. */
  readonly write: ReadonlyMap<string, Buffer>;
  /** Files to delete from `to` — committed ones the gate no longer has. */
  readonly remove: readonly string[];
  /**
   * Where to keep what is overwritten or removed, so the carry-back can be
   * undone. Must not exist; it is created, and {@link CarriedBack.discard}
   * removes it.
   */
  readonly backup: string;
}

/** A carry-back that happened, with the means to take it back. */
export interface CarriedBack {
  readonly ok: true;
  /** Every path written or removed, sorted — what a caller stages and commits. */
  readonly touched: readonly string[];
  /** Restore the worktree to exactly what it held before. */
  undo(): Promise<void>;
  /** Drop the backup, once the carry-back is committed or undone. */
  discard(): Promise<void>;
}

export type CarryBackResult =
  CarriedBack | { readonly ok: false; readonly detail: string };

/**
 * Make `to/dir` hold exactly `write` for those paths and none of `remove`,
 * and report every path touched. All or nothing: a refusal or an I/O failure
 * part-way restores what was already done before it returns or rethrows.
 */
export async function carryBackFiles(
  input: CarryBackInput,
): Promise<CarryBackResult> {
  for (const path of [...input.write.keys(), ...input.remove]) {
    if (!isCleanRelative(path) || !isWithin(path, input.dir)) {
      return {
        ok: false,
        detail: `${path} is not a path under ${input.dir} — nothing was carried back`,
      };
    }
  }

  const realTo = await realpath(input.to);

  /** Is the nearest existing ancestor of `path`'s destination inside the worktree? */
  async function contained(path: string): Promise<boolean> {
    let probe = dirname(join(input.to, path));
    for (;;) {
      try {
        const rel = relative(realTo, await realpath(probe));
        return (
          rel === '' ||
          (!rel.startsWith('..') &&
            !rel.startsWith(sep) &&
            !/^[A-Za-z]:/.test(rel))
        );
      } catch (error) {
        if (!isMissing(error)) throw error;
        const parent = dirname(probe);
        if (parent === probe) return false;
        probe = parent;
      }
    }
  }

  /** `lstat`, or `undefined` when there is nothing there. */
  async function entryAt(absolute: string) {
    try {
      return await lstat(absolute);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  const backedUp: string[] = [];
  const created: string[] = [];
  const undo = async (): Promise<void> => {
    for (const path of created) {
      await rm(join(input.to, path), { force: true });
    }
    for (const path of backedUp) {
      const destination = join(input.to, path);
      await rm(destination, { force: true });
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(input.backup, path), destination, { force: true });
    }
  };
  const discard = (): Promise<void> =>
    rm(input.backup, { recursive: true, force: true });

  /** Copy what is at `path` aside before it is overwritten or removed. */
  async function backUp(path: string): Promise<void> {
    const destination = join(input.backup, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(input.to, path), destination);
    backedUp.push(path);
  }

  const refuse = async (detail: string): Promise<CarryBackResult> => {
    await undo();
    await discard();
    return { ok: false, detail };
  };

  await mkdir(input.backup, { recursive: true });
  try {
    // Removals first: on a case-insensitive filesystem, a case-only rename's
    // removal and its write name the SAME file, and removing second would
    // delete what was just written.
    for (const path of input.remove) {
      const destination = join(input.to, path);
      if (!(await contained(path))) {
        return await refuse(
          `${path} lies outside the worktree, through a symbolic link — not removed`,
        );
      }
      const existing = await entryAt(destination);
      if (existing === undefined) continue;
      if (!existing.isFile()) {
        return await refuse(
          `${path} is not a regular file in the worktree — not removed`,
        );
      }
      await backUp(path);
      await rm(destination, { force: true });
    }

    for (const [path, bytes] of input.write) {
      const destination = join(input.to, path);
      if (!(await contained(path))) {
        return await refuse(
          `${path} would be written outside the worktree, through a symbolic link — refused`,
        );
      }
      const existing = await entryAt(destination);
      if (existing !== undefined && !existing.isFile()) {
        return await refuse(
          `${path} is not a regular file in the worktree — ADL will not write through it`,
        );
      }
      if (existing === undefined) created.push(path);
      else await backUp(path);
      await mkdir(dirname(destination), { recursive: true });
      // Re-checked after `mkdir`: the directories just created are ordinary
      // ones, but the check is cheap and the alternative is reasoning.
      if (!(await contained(path))) {
        return await refuse(
          `${path} would be written outside the worktree — refused`,
        );
      }
      await writeFile(destination, bytes);
    }
  } catch (error) {
    await undo();
    await discard();
    throw error;
  }

  return {
    ok: true,
    touched: [...input.write.keys(), ...input.remove].sort(),
    undo,
    discard,
  };
}
