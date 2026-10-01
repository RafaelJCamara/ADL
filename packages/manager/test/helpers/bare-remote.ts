/**
 * A bare repository a test pushes to, that the privilege-dropped worker can
 * actually push to (D-6-CI-5).
 *
 * Several M05/M08 cases push to a local bare repository standing in for a
 * forge. Created by the test process it is owned by the DAEMON's uid, and under
 * the Linux privilege drop the push runs as the worker: git (>= 2.35.2) then
 * refuses with `detected dubious ownership in repository` -- and, past that,
 * with `unable to create temporary object directory`, because the worker cannot
 * write a repository it neither owns nor shares a group with. No production
 * remote has this shape (a forge is an HTTPS URL), so this is a property of the
 * fixture, and the fixture is what is fixed: under the drop the repository is
 * created BY the worker, so it passes both checks for the right reason.
 *
 * Reading it back is also done as the worker, for the converse reason -- the
 * daemon is not the owner either. Undropped (Windows, macOS, Linux without
 * `ADL_WORKER_USER`, or without a resolvable `sudo`) it is a plain
 * `git init --bare` in `parent`.
 *
 * Lives in `@adl/manager`'s test helpers, and not in `@adl/workspace`'s, for a
 * reason that is checked rather than argued: `workspace-contract.test.ts` scans
 * the WHOLE of `packages/workspace` -- `test/` included -- for any module naming
 * a process launcher, so this file there is red (`T-2-40`). (A review suggested
 * moving it to remove the suppression below; that was tried and is why this
 * comment says so.) Manager tests already carry the same suppression for the
 * same reason -- `test/prompt/build.test.ts`, `test/prompt/determinism.test.ts`.
 */
// A test fixture creating the repository a push goes to -- test infrastructure,
// not ADL orchestration reaching past `Workspace.exec()` (WORK-02's subject). It
// must run `git` as a DIFFERENT OS user than the test, which no `Workspace` the
// test holds can do for a repository that has to exist before one is created.
// eslint-disable-next-line no-restricted-imports -- test-only fixture, see comment above
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { onTestFinished } from 'vitest';
import { privilegeLauncher, workerIdentityFromEnv } from '@adl/workspace';

const run = promisify(execFile);

export interface BareRemote {
  /** The path to push to. */
  readonly path: string;
  /** What `ref` resolves to in the remote. */
  revParse(ref: string): Promise<string>;
}

/**
 * Create a bare repository, removed when the current test finishes.
 *
 * @param parent  Where to create it when no privilege drop is in play. Ignored
 *                under the drop, where the repository must be somewhere the
 *                worker may create a directory: the system temp directory.
 */
export async function createBareRemote(parent: string): Promise<BareRemote> {
  // The backend's own decision, asked the backend's own way (the same function,
  // the same identity reader, the daemon's PATH), so "is the drop in play" cannot
  // be answered differently here. The variable alone is not the answer: it can be
  // set on a machine that has no `sudo` or is not Linux, where the backend does
  // not drop and a `sudo` here would fail for no reason of the test's.
  const worker = workerIdentityFromEnv();
  const decision = await privilegeLauncher({
    worker,
    path: process.env['PATH'] ?? '',
  });
  const name = `adl-remote-${randomBytes(6).toString('hex')}.git`;

  if (decision.mode !== 'dropped' || worker.user === undefined) {
    const path = join(parent, name);
    await mkdir(path, { recursive: true });
    await run('git', ['-C', path, 'init', '--bare', '--quiet']);
    onTestFinished(() => rm(path, { recursive: true, force: true }));
    return {
      path,
      revParse: async (ref) =>
        (await run('git', ['-C', path, 'rev-parse', ref])).stdout.trim(),
    };
  }

  const user = worker.user;
  const path = join(tmpdir(), name);
  const asWorker = (...argv: string[]) =>
    run('sudo', ['--non-interactive', '--user', user, '--', ...argv], {
      // Not the test's environment: the worker's git needs a PATH and a HOME it
      // can write, nothing else.
      env: { PATH: process.env['PATH'] ?? '', HOME: tmpdir() },
    });
  await asWorker('git', 'init', '--bare', '--quiet', path);
  onTestFinished(async () => {
    await asWorker('rm', '-rf', path);
  });
  return {
    path,
    revParse: async (ref) =>
      (await asWorker('git', '-C', path, 'rev-parse', ref)).stdout.trim(),
  };
}
