/**
 * The per-run scratch `HOME` (D-07).
 *
 * Every child of a workspace runs with `HOME` pointed at a directory that did
 * not exist before the run and does not exist after it. That is what stops an
 * agent's `git config --global`, its `~/.npmrc`, and its credential helper from
 * outliving the round that wrote them.
 *
 * **The security property comes from `mkdtemp`, not from the deletion.**
 * `mkdtemp` is the only race-free way to obtain a directory whose name nothing
 * else can predict, so "the agent's configuration did not reach the next run"
 * holds even if a teardown is interrupted, crashes, or loses a race with a
 * still-open file handle (T-2-20). Deletion is hygiene on top of that. Reading
 * it the other way round — treating the delete as the control — is what leads to
 * a teardown that throws mid-cleanup and takes the rest of the teardown with it.
 *
 * **The mode this directory ends up with is not decided here.** `mkdtemp`
 * creates it `0700`, owned by the daemon user, which is correct whenever the
 * privilege drop did not happen. When it did, the worker user is a different
 * identity and needs to write its own `HOME` — so `exec/privilege.ts`'s
 * `applyWorkerAccess` widens the directory to the shared group (group rwx, no
 * world bit, T-2-35) after the worktree backend has created both. Kept there
 * rather than here so that this module has no opinion about OS identity and
 * stays the same on every platform.
 *
 * ── Why the homes live under a directory of their own (CR-03, WR-06) ───────
 *
 * They used to be created directly under `os.tmpdir()`, and that made the
 * paragraph above less true than it reads. `/tmp` is world-readable, so *any*
 * local process could `ls` it, learn every live `adl-home-*` name, and — being
 * a member of the one shared worker group that every concurrent feature's
 * child runs as (see README § Permission model) — traverse straight into
 * another feature's `HOME`. The unpredictable `mkdtemp` name defeats a
 * *guessing* attacker; it does nothing against one who can read the directory
 * listing.
 *
 * So every home is now created inside {@link scratchHomeRoot}, a single
 * daemon-owned `0700` directory. `applyWorkerAccess` gives that root group
 * **`--x` and nothing else**: traverse, never list, never write. A worker-group
 * member can therefore reach the home whose name it was given (its own, through
 * `HOME`) and cannot enumerate the others — which puts `mkdtemp`'s
 * unpredictability back in the position of being the control this module's
 * opening paragraph says it is.
 *
 * The root is also the inventory the GC backstop needs. `Workspace.destroy()`
 * is the only thing that ever removed a scratch `HOME`, so a worker that died
 * between {@link createScratchHome} and `destroy()` — the exact crash D-15
 * exists for — leaked one forever, with nothing able to find it. See
 * {@link listScratchHomes} and `worktree/gc.ts`'s `sweepScratchHomes`.
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceError } from '../errors.js';

/** A private `HOME` belonging to one `Workspace` instance. */
export interface ScratchHome {
  /** Absolute path to the directory. Handed to children as `HOME`, never as a readable/writable workspace path. */
  readonly path: string;
}

/** The leading segment every scratch home's directory name carries. */
const SCRATCH_HOME_PREFIX = 'adl-home-';

/** The suffix on a home's owner marker. See {@link ownerFileFor}. */
const OWNER_SUFFIX = '.owner';

/**
 * The one directory every scratch `HOME` is created inside.
 *
 * A function rather than a constant because `os.tmpdir()` reads `TMPDIR` /
 * `TEMP` at call time, and a test that moves the temp root would otherwise be
 * silently ignored by a value computed at import.
 */
export function scratchHomeRoot(): string {
  return join(tmpdir(), 'adl-homes');
}

/**
 * Where a home's ownership record lives: **beside** the directory, not inside
 * it.
 *
 * Inside would be the obvious place and it would be wrong. The home is granted
 * group `rwx` to the shared worker group, so a marker inside it is a file the
 * agent — and, while CR-03 stands, any *other* concurrent feature's agent — can
 * rewrite. A record that says "the process that owns this is dead" is a request
 * to the sweep to delete the directory, so a writable marker is a way to ask ADL
 * to destroy a running feature's `HOME`.
 *
 * The root, by contrast, is `0700` to the daemon plus group `--x`: a worker can
 * traverse it and cannot create, delete, or modify anything in it. The marker
 * therefore sits in the one nearby place the identity ADL drops to cannot reach.
 */
function ownerFileFor(home: string): string {
  return `${home}${OWNER_SUFFIX}`;
}

/**
 * What is recorded about the process that created a scratch home.
 *
 * A pid and nothing else — deliberately no timestamp, and deliberately no
 * "max age". The question the sweep has to answer is "did the worker that owned
 * this die", and process liveness answers it directly, where a clock only ever
 * approximates it. That is the same reasoning D-16 applies to worktrees, reached
 * through a different door.
 */
export interface ScratchHomeOwner {
  /** The pid of the ADL process that created the home. */
  readonly pid: number;
}

/** One scratch home found on disk by {@link listScratchHomes}. */
export interface ScratchHomeEntry {
  readonly path: string;
  /**
   * The recorded owner, or `undefined` when there is no readable marker.
   *
   * `undefined` is not an error and — unlike `sweepOrphans`' unknown feature —
   * it is emphatically **not** licence to collect. A home with no marker was
   * created by an older ADL, or by something that is not ADL at all, and the
   * fail-safe direction here is to leave it alone.
   */
  readonly owner: ScratchHomeOwner | undefined;
}

/**
 * What teardown actually did — returned rather than thrown or swallowed.
 *
 * A discriminated union rather than a boolean, because the three outcomes want
 * different things from the caller: `removed` is the happy path, `already-absent`
 * is what idempotency looks like from the inside, and `not-removed` is a real
 * event an operator may want to see (a leaked temp directory on a long-running
 * daemon) without it being a failure that aborts anything.
 */
export type ScratchHomeTeardown =
  | {
      readonly outcome: 'removed';
      readonly path: string;
      /** How many attempts it took. >1 means the Windows handle race was hit and lost, then won. */
      readonly attempts: number;
    }
  | {
      /** The directory was not there to begin with. Teardown is safe to call twice. */
      readonly outcome: 'already-absent';
      readonly path: string;
    }
  | {
      readonly outcome: 'not-removed';
      readonly path: string;
      readonly attempts: number;
      /** The OS error code and message. Never a value from the child's environment. */
      readonly reason: string;
    };

/**
 * Create {@link scratchHomeRoot}, or prove the one that is already there is
 * ADL's.
 *
 * A fixed name inside a world-writable sticky directory is squattable: any
 * local user can create `/tmp/adl-homes` first, as a symlink or as a `0777`
 * directory, and every scratch `HOME` ADL creates afterwards lands somewhere
 * they chose. `mkdtemp` would still give unpredictable leaf names, but the
 * listing — the exact thing this root exists to deny — would be theirs to read.
 *
 * So an existing root is *verified*, and a root that fails verification is a
 * throw rather than a fallback to `os.tmpdir()`. Falling back would be the
 * failure mode this phase has a history of: a control that continues, degraded,
 * without saying so.
 */
async function ensureScratchHomeRoot(): Promise<string> {
  const root = scratchHomeRoot();

  try {
    // Not `recursive: true`: that reports success for a pre-existing directory
    // without telling us it pre-existed, which is precisely the case that has
    // to be verified rather than assumed.
    await mkdir(root, { mode: 0o700 });
    return root;
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') throw error;
  }

  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new WorkspaceError(
      `${root} exists and is not a directory (or is a symbolic link to one). ADL creates every scratch HOME inside it, so it refuses to use a path something else is in control of.`,
    );
  }

  // POSIX only. On Windows `fs.Stats.mode` reports the read-only attribute
  // rather than real permission bits and `getuid` does not exist, so these two
  // checks would be measuring something they do not mean.
  const uid = process.getuid?.();
  if (uid !== undefined) {
    if (info.uid !== uid) {
      throw new WorkspaceError(
        `${root} is owned by uid ${info.uid}, not by the ADL daemon's uid ${uid}. A scratch-HOME root someone else owns is a directory someone else can read, so ADL refuses to create homes in it.`,
      );
    }
    if ((info.mode & 0o022) !== 0) {
      throw new WorkspaceError(
        `${root} is group- or world-writable (mode ${(info.mode & 0o7777).toString(8)}). Its whole job is to be the directory a concurrent feature's agent cannot write, so ADL refuses to create homes in it.`,
      );
    }
  }

  return root;
}

/**
 * Record which process owns a home, in the one place beside it that the worker
 * user cannot write.
 *
 * `wx` — fail if it exists — rather than a plain write: an existing marker at
 * this path means something raced us for a name `mkdtemp` had just guaranteed
 * was ours, and overwriting it is how that anomaly would become invisible.
 *
 * A failure here is deliberately **not** fatal. The marker is what makes the
 * home *collectable* (WR-06); the home itself is already correct without it, and
 * D-07's guarantee has never depended on cleanup. An unmarked home is a leak,
 * which is the failure mode this whole mechanism is downgrading, so failing the
 * run over it would trade a disk-space problem for an outage.
 */
async function recordOwner(home: string): Promise<void> {
  try {
    await writeFile(
      ownerFileFor(home),
      `${JSON.stringify({ pid: process.pid } satisfies ScratchHomeOwner)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  } catch {
    // Swallowed on purpose — see the docblock. The consequence is one
    // uncollectable directory, and `listScratchHomes` reports it as unowned
    // rather than pretending it is not there.
  }
}

/**
 * Create a fresh, unpredictably named home directory under ADL's scratch root.
 *
 * Deliberately NOT configurable, and deliberately never reused. A configurable
 * root invites a shared one; a reused directory replaces D-07's "the
 * configuration does not survive because the directory stops existing" with a
 * wipe step that has to run correctly on every single run, and a wipe step that
 * misses one file is indistinguishable from one that works.
 */
export async function createScratchHome(): Promise<ScratchHome> {
  const root = await ensureScratchHomeRoot();
  const path = await mkdtemp(join(root, SCRATCH_HOME_PREFIX));
  await recordOwner(path);
  return { path };
}

/**
 * Every scratch home currently on disk, with whatever ownership was recorded.
 *
 * The MECHANISM half, in the sense `worktree/list.ts` is the mechanism behind
 * `sweepOrphans`: this reports what exists and decides nothing about what should
 * be collected. The policy — "the process that owned this is gone" — is
 * `sweepScratchHomes` in `worktree/gc.ts`.
 *
 * A missing root is an empty inventory rather than an error: a daemon that has
 * not yet created a workspace has no homes, and that is not a condition anyone
 * needs to hear about.
 */
export async function listScratchHomes(): Promise<readonly ScratchHomeEntry[]> {
  const root = scratchHomeRoot();

  let names: readonly string[];
  try {
    // `withFileTypes` so a *symlink* named `adl-home-x` is not mistaken for a
    // directory: `Dirent.isDirectory()` does not follow links, and following
    // one here would point the sweep's `rm` at a target somebody else chose.
    const entries = await readdir(root, { withFileTypes: true });
    names = entries
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith(SCRATCH_HOME_PREFIX),
      )
      .map((entry) => entry.name);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return [];
    throw error;
  }

  const found: ScratchHomeEntry[] = [];
  for (const name of names) {
    const path = join(root, name);
    found.push({ path, owner: await readOwner(path) });
  }
  return found;
}

/** The recorded owner of one home, or `undefined` if there is not a usable one. */
async function readOwner(home: string): Promise<ScratchHomeOwner | undefined> {
  let text: string;
  try {
    text = await readFile(ownerFileFor(home), 'utf8');
  } catch {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('pid' in parsed) ||
      typeof parsed.pid !== 'number' ||
      !Number.isSafeInteger(parsed.pid) ||
      // `process.kill(0, sig)` signals the whole process GROUP. A zero or
      // negative pid never reaches a liveness probe from here.
      parsed.pid <= 0
    ) {
      return undefined;
    }
    return { pid: parsed.pid };
  } catch {
    return undefined;
  }
}

/**
 * Errors that mean "something still has this directory open", as opposed to
 * "this cannot work".
 *
 * On Windows a directory that a *just-exited* child still holds a handle on
 * fails removal with `EBUSY` or `EPERM`, and the handle is usually released
 * within milliseconds — so these are worth a short retry. `ENOTEMPTY` is the
 * same story one level down: a concurrent write landed between the recursive
 * walk and the final `rmdir`. Anything not on this list (`EACCES` on a
 * directory ADL does not own, for instance) will not improve by being retried.
 */
const TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE']);

/** Bounded: ~4 retries over roughly 250ms total. Teardown must not become a stall. */
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = 25;

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * Remove a scratch home and everything the run left in it — best effort.
 *
 * Three deliberate choices:
 *
 * 1. **It does not throw.** Teardown runs after the interesting work, often
 *    alongside other teardown steps, and a throw here would abort them. The
 *    outcome is returned so a caller can log it, and `mkdtemp` means a leaked
 *    directory is a disk-space problem rather than a security one.
 * 2. **An already-absent directory is a success.** `Workspace.destroy()` and any
 *    later GC backstop can both reach this, and a teardown that must run exactly
 *    once is a teardown nobody can safely add a backstop to.
 * 3. **`force` is off, on purpose.** `rm(dir, { force: true })` swallows
 *    `ENOENT`, which is the very thing that distinguishes `already-absent` from
 *    `removed`. Letting the error surface is what makes idempotency observable
 *    instead of merely true.
 *
 * The owner marker beside the directory goes first, and its removal is the one
 * `force: true` in this function — its outcome is not part of the contract, and
 * a marker left behind by a failed removal would make a live home look
 * collectable to the sweep.
 */
export async function destroyScratchHome(
  dir: string,
): Promise<ScratchHomeTeardown> {
  try {
    await rm(ownerFileFor(dir), { force: true });
  } catch {
    // Never lets marker removal change what this function reports: the
    // discriminating outcome belongs to the DIRECTORY, and `dir` may not even
    // be a valid path (a case the suite drives deliberately).
  }

  let lastReason = 'unknown';
  let used = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    used = attempt;
    try {
      await rm(dir, { recursive: true });
      return { outcome: 'removed', path: dir, attempts: attempt };
    } catch (error) {
      const code = codeOf(error);

      if (code === 'ENOENT') {
        return { outcome: 'already-absent', path: dir };
      }

      lastReason = `${code ?? 'unknown'}: ${(error as Error).message}`;

      if (code === undefined || !TRANSIENT_CODES.has(code)) break;

      if (attempt < MAX_ATTEMPTS) {
        // Linear backoff. The handle-release window this is waiting on is
        // milliseconds; exponential backoff would mostly be spent sleeping past
        // it.
        await new Promise((resolve) =>
          setTimeout(resolve, BACKOFF_MS * attempt),
        );
      }
    }
  }

  return {
    outcome: 'not-removed',
    path: dir,
    // The attempts ACTUALLY made, not the cap: a non-transient error breaks out
    // after one, and reporting five would send whoever reads the log looking
    // for a retry loop that never ran.
    attempts: used,
    reason: lastReason,
  };
}
