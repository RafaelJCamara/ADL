/**
 * The per-run scratch `HOME` (D-07).
 *
 * Every child of a workspace runs with `HOME` pointed at a directory that did
 * not exist before the run and does not exist after it. That is what stops an
 * agent's `git config --global`, its `~/.npmrc`, and its credential helper from
 * outliving the round that wrote them.
 *
 * The security property comes from `mkdtemp`, not from the deletion: `mkdtemp`
 * is the only race-free way to obtain a directory whose name nothing else can
 * predict, so a fresh directory per run holds even if a teardown is interrupted.
 * Deletion is hygiene on top of that.
 *
 * Scope note: retry-with-backoff on the Windows `EBUSY`/`EPERM` case, and the
 * neutraliser variables that point tool config *into* this directory, land in
 * plan `02-05`. This module ships the create-and-delete pair.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A private `HOME` belonging to one `Workspace` instance. */
export interface ScratchHome {
  /** Absolute path to the directory. Handed to children as `HOME`, never as a readable/writable workspace path. */
  readonly path: string;
}

/** Create a fresh, unpredictably named home directory under the OS temp root. */
export async function createScratchHome(): Promise<ScratchHome> {
  return { path: await mkdtemp(join(tmpdir(), 'adl-home-')) };
}

/** Remove a scratch home and everything the run left in it. */
export async function destroyScratchHome(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
