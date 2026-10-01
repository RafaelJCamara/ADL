/**
 * The privilege drop (WORK-05, D-05, D-06, D-18).
 *
 * On Linux, every child a workspace launches runs as a dedicated unprivileged
 * OS user. Everywhere else it does not, and this module's second job — equal in
 * weight to the first — is to say so out loud.
 *
 * ── Why a launcher and not `execa({ uid, gid })` ──────────────────────────
 *
 * The obvious implementation is wrong twice over (02-RESEARCH.md § Pitfall 8),
 * and both failures are silent:
 *
 * 1. `setuid(2)` from an unprivileged process fails with `EPERM`, so the uid /
 *    gid options require the daemon to already be root — which contradicts
 *    D-06's premise that the long-running manager never needs root-capable
 *    permissions.
 * 2. They do not relinquish supplementary groups. Node's documentation for
 *    `uid` / `gid` is silent on `setgroups()`, and a parent's supplementary
 *    groups are inherited by the child — so the "unprivileged" worker keeps
 *    every membership the daemon had, and nothing in the output says so. The
 *    CERT secure-coding guidance is explicit that supplementary groups must be
 *    relinquished explicitly when dropping privileges.
 *
 * That second point is threat T-2-30, and it is the reason
 * `test/exec/privilege.test.ts` asserts against the child's **supplementary
 * group list** rather than against its uid: a uid comparison alone passes
 * cleanly on the broken implementation.
 *
 * D-18 therefore resolves to an external launcher that performs the full
 * `setgroups` → `setgid` → `setuid` sequence itself. `sudo -u` is the default
 * because it is the only mechanism in Pitfall 8's table that does the whole
 * sequence *without* requiring the caller to be root; `setpriv --reuid --regid
 * --init-groups --inh-caps=-all` is the documented alternative for an operator
 * who prefers not to configure sudoers, and it does require a root caller,
 * which changes which process holds privilege. Swapping between them is a
 * change to {@link launcherPrefix} and one README section — that is the whole
 * of the seam.
 *
 * ── Why a missing launcher warns instead of throwing ──────────────────────
 *
 * D-05 makes the drop Linux-only in v1, and the maintainer's own machine is
 * Windows. A hard failure would mean the development environment cannot run the
 * loop at all; a silent no-op would mean an operator believes a run was
 * isolated when it was not (T-2-32). The resolution is the middle one: continue,
 * and emit a warning that names concretely what is not enforced.
 */
import { constants, type Stats } from 'node:fs';
import {
  access,
  chmod,
  chown,
  lstat,
  open,
  readFile,
  readdir,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { scratchHomeRoot } from './scratch-home.js';

/**
 * What actually happened to the privilege drop.
 *
 * Four members rather than the three the plan sketched. `worker-user-unset` is
 * split out from `launcher-missing` because T-2-32 names three distinct causes
 * of a silent non-drop — wrong platform, missing launcher, unset user — and the
 * whole value of the warning is that it tells an operator which one to fix. A
 * warning that says "sudo was not found" when the real problem is an unset
 * `ADL_WORKER_USER` sends them to the wrong file.
 */
export type PrivilegeMode =
  'dropped' | 'unsupported-platform' | 'launcher-missing' | 'worker-user-unset';

/**
 * The pre-provisioned worker identity (D-06).
 *
 * Two non-secret NAMES. Never a credential, and never anything read out of the
 * child's environment — this is the one place ADL legitimately reads its own
 * process environment, and what it reads is a user name and a group name.
 *
 * ── The limit of this identity, stated where it is defined (CR-03) ─────────
 *
 * It is per **deployment**, not per feature — one `adl-worker` user and one
 * `adl-worker` group for every feature the daemon runs, concurrently or
 * otherwise. So the isolation this module buys is between *ADL's agents* and
 * *the host*, and there is **no isolation between one feature and another**:
 * every concurrent feature's child is the same uid in the same group, and
 * {@link applyWorkerAccess} grants that one group `rwx` on every feature's
 * worktree. Feature A's agent can therefore read and rewrite feature B's source
 * — including after B's reviewer stage has passed and before its pull request
 * opens, which is the gate ADL exists to be.
 *
 * That is a real gap, it is not closable with group permissions alone (a second
 * identity requires a second uid), and it is recorded with a reproduction and a
 * proposed shape in
 * `.planning/phases/02-workspace-the-exec-boundary/deferred-items.md` § D-2-R-1.
 * `packages/workspace/README.md` § Permission model states it to operators. Do
 * not read the grants below as per-feature; they are not.
 */
export interface WorkerIdentity {
  /** The dedicated unprivileged OS user children are dropped to. */
  readonly user?: string;
  /** The group shared by the daemon user and the worker user. */
  readonly group?: string;
}

/** The environment variables the daemon publishes the worker identity through. */
export const WORKER_USER_VAR = 'ADL_WORKER_USER';
export const WORKER_GROUP_VAR = 'ADL_WORKER_GROUP';

/**
 * Read the worker identity from the DAEMON's own environment.
 *
 * The default for `worktreeWorkspace`'s `worker` option. A caller that passes
 * an identity explicitly — the manager, once Phase 3 owns configuration —
 * overrides this entirely.
 */
export function workerIdentityFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkerIdentity {
  const user = env[WORKER_USER_VAR]?.trim();
  const group = env[WORKER_GROUP_VAR]?.trim();
  return {
    ...(user === undefined || user === '' ? {} : { user }),
    ...(group === undefined || group === '' ? {} : { group }),
  };
}

/** The launcher D-18 selects by default. `setpriv` is the documented alternative. */
export const PRIVILEGE_LAUNCHER = 'sudo';

/** Resolves an executable name against a PATH, or reports it unresolvable. */
export type LauncherResolver = (
  name: string,
  path: string,
) => Promise<string | undefined>;

export interface PrivilegeConfig {
  readonly worker: WorkerIdentity;
  /**
   * The PATH the CHILD will run with — `ExecSpec.path`, not the daemon's.
   *
   * Under `extendEnv: false` execa resolves the executable it is given from
   * `env.PATH` rather than from the parent's (02-RESEARCH.md § Pitfall 7), and
   * the launcher is now the executable it is given. A launcher resolved against
   * the daemon's PATH but absent from the child's would be an `ENOENT` at the
   * first real agent invocation rather than a mode this module can report.
   */
  readonly path: string;
  /** Defaults to `process.platform`. A parameter so the OS gate is testable. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to a PATH scan. A parameter so launcher absence is testable. */
  readonly resolveLauncher?: LauncherResolver;
}

export interface PrivilegeDecision {
  readonly mode: PrivilegeMode;
  /**
   * The argv the real command is appended to. Empty for every non-dropped mode,
   * which is what makes `[...prefix, ...spec.argv]` correct unconditionally at
   * the call site rather than something guarded by an `if`.
   */
  readonly prefix: readonly string[];
  /**
   * The PATH this decision was made against — `PrivilegeConfig.path`, echoed.
   *
   * Carried so that two decisions can be compared without a caller having to
   * remember which PATH produced which. The mode alone is not enough to explain
   * a disagreement, and "the PATH the daemon has and the PATH this child gets
   * differ in whether they contain sudo" is the entire content of the WR-10
   * banner. See {@link privilegeModeMismatch}.
   */
  readonly path: string;
}

const NO_PREFIX: readonly string[] = Object.freeze([]);

/**
 * Find an executable on a PATH without launching anything.
 *
 * Deliberately not `which` / `where`: resolving the launcher must not itself be
 * a process launch, because the only sanctioned process launch in this
 * repository is `run()`, and `run()` is the caller.
 */
async function resolveOnPath(
  name: string,
  path: string,
): Promise<string | undefined> {
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable by us. Try the next entry.
    }
  }
  return undefined;
}

/**
 * The launcher argv prefix, isolated so D-18's alternative is one edit away.
 *
 * Each flag is load-bearing:
 *
 * - `--preserve-env` — `sudo` resets the environment by default, and the
 *   environment it would reset is the one `buildChildEnv` constructed from
 *   nothing: the scratch `HOME`, the git and npm neutralisers, the caller's
 *   explicitly named model key. Losing it would silently undo D-07, D-09 and
 *   D-10 in a way that looks like the agent misbehaving. This requires the
 *   `SETENV` tag on the sudoers entry, which is why the README documents the
 *   entry with that tag rather than a bare `NOPASSWD:`.
 * - `--non-interactive` — without it, a sudoers rule that does not match makes
 *   `sudo` prompt for a password on a tty the daemon does not have, and the
 *   exec hangs instead of failing. A misconfiguration must be loud and fast.
 * - `--user` — the drop target.
 * - `--` — terminates sudo's own option parsing, so an agent CLI invoked with a
 *   leading `-something` is passed through as the command rather than
 *   reinterpreted as a sudo flag.
 */
function launcherPrefix(launcher: string, user: string): readonly string[] {
  return Object.freeze([
    launcher,
    '--preserve-env',
    '--non-interactive',
    '--user',
    user,
    '--',
  ]);
}

/**
 * Decide whether this child can be dropped, and to what.
 *
 * Gated on the platform FIRST, before anything else is consulted, because D-05
 * makes every other consideration moot off Linux.
 */
export async function privilegeLauncher(
  config: PrivilegeConfig,
): Promise<PrivilegeDecision> {
  const path = config.path;

  const platform = config.platform ?? process.platform;
  if (platform !== 'linux') {
    return { mode: 'unsupported-platform', prefix: NO_PREFIX, path };
  }

  const user = config.worker.user?.trim() ?? '';
  if (user === '') {
    return { mode: 'worker-user-unset', prefix: NO_PREFIX, path };
  }

  const resolve = config.resolveLauncher ?? resolveOnPath;
  const launcher = await resolve(PRIVILEGE_LAUNCHER, path);
  if (launcher === undefined) {
    return { mode: 'launcher-missing', prefix: NO_PREFIX, path };
  }

  // The RESOLVED absolute path, not the bare name. `sudo` is setuid root; being
  // explicit about which one is being invoked costs nothing and removes a
  // second, later PATH lookup nobody would think to audit.
  return { mode: 'dropped', prefix: launcherPrefix(launcher, user), path };
}

/**
 * The banner for a creation-time / run-time privilege disagreement, or
 * `undefined` when the two agree (WR-10).
 *
 * The mode is decided twice, deliberately, against two different PATHs:
 * `worktree/backend.ts` resolves it against the DAEMON's PATH to answer "will a
 * drop happen, and therefore does the worker need access to these
 * directories?", and `exec/run.ts` resolves it against `ExecSpec.path` to answer
 * "can execa resolve the launcher from the environment THIS child gets?"
 * (02-RESEARCH.md § Pitfall 7). Both questions are real. What was missing is any
 * handling of the two answers differing, and each direction has a consequence:
 *
 * - **creation dropped, run-time not** — `applyWorkerAccess` widened the
 *   worktree, the administrative directory and the scratch `HOME` to the shared
 *   group, and then the child ran as the daemon anyway. That is exposure with no
 *   beneficiary: exactly the state `applyWorkerAccess`'s `mode !== 'dropped'`
 *   early return exists to avoid, arrived at from the other side.
 * - **creation not dropped, run-time dropped** — the child is handed a `sudo`
 *   prefix with no access grant behind it, so every command fails to write its
 *   own worktree with a permission error that reads like an agent bug.
 *
 * A separate banner from {@link privilegeWarning} rather than a fourth
 * {@link PrivilegeMode}, because this is not a statement about one decision: it
 * is a statement about two of them being inconsistent, and it names both PATHs
 * because "a silent half-configured drop" (T-2-32's shape) is only actionable if
 * the operator can see which PATH is missing the launcher.
 *
 * **Not wired to a call site yet.** Both call sites are outside this module, and
 * the wiring is recorded in
 * `.planning/phases/02-workspace-the-exec-boundary/deferred-items.md` § D-2-R-2
 * together with why a module-level ledger inside this file was rejected instead.
 */
export function privilegeModeMismatch(
  creation: PrivilegeDecision,
  runtime: PrivilegeDecision,
): string | undefined {
  if (creation.mode === runtime.mode) return undefined;

  const consequence =
    creation.mode === 'dropped'
      ? 'the workspace directories were widened to the shared worker group at creation and this child then ran as the DAEMON — group access with no beneficiary'
      : runtime.mode === 'dropped'
        ? 'this child was handed a launcher prefix with no access grant behind it — it will fail to write its own worktree, with an error that looks like the agent misbehaving'
        : 'the two non-dropped modes disagree about WHY the drop did not happen, so the banner above may name the wrong cause';

  return [
    `${ADL_WARNING_PREFIX} Privilege mode MISMATCH: the workspace resolved ${creation.mode} at creation and ${runtime.mode} for this exec.`,
    `${ADL_WARNING_PREFIX} Consequence: ${consequence}.`,
    `${ADL_WARNING_PREFIX} Creation-time PATH (the daemon's): ${creation.path}`,
    `${ADL_WARNING_PREFIX} Run-time PATH (ExecSpec.path): ${runtime.path}`,
    `${ADL_WARNING_PREFIX} These two PATHs must agree about whether ${PRIVILEGE_LAUNCHER} is resolvable. See packages/workspace/README.md.`,
  ].join('\n');
}

/** Prefix on every line this module writes. Greppable in a CI log on purpose. */
export const ADL_WARNING_PREFIX = '[ADL][WORK-05]';

/**
 * The banner for a non-dropped mode, or `undefined` when the drop happened.
 *
 * It names three concrete things rather than saying "isolation is reduced",
 * because T-2-32 is a *repudiation* threat: the failure it describes is an
 * operator believing a run was contained. A vague banner does not correct that
 * belief, so each consequence is stated as a fact about this run.
 */
export function privilegeWarning(
  mode: PrivilegeMode,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (mode === 'dropped') return undefined;

  const cause =
    mode === 'unsupported-platform'
      ? `this platform is ${platform}, and the launcher-based drop is Linux-only in v1 (D-05)`
      : mode === 'launcher-missing'
        ? `${PRIVILEGE_LAUNCHER} was not resolvable on the PATH this child runs with (D-18); see packages/workspace/README.md for the setpriv alternative`
        : `${WORKER_USER_VAR} is not set, so there is no pre-provisioned worker identity to drop to (D-06)`;

  return [
    `${ADL_WARNING_PREFIX} Privilege drop NOT applied: ${cause}.`,
    `${ADL_WARNING_PREFIX} Children of this workspace run with the daemon's OWN OS identity — not a dedicated unprivileged worker user.`,
    `${ADL_WARNING_PREFIX} The main repository's .git/config is therefore writable by anything the agent can run, and git config names programs git executes (core.hooksPath, core.pager, *.sshCommand) during ADL's own operations.`,
    `${ADL_WARNING_PREFIX} The OS-level isolation described in packages/workspace/README.md applies to Linux deployments only.`,
  ].join('\n');
}

/** Where a warning goes. Injectable so the once-per-process rule is testable. */
export type PrivilegeWarningSink = (message: string) => void;

/**
 * Standard error, until there is a logger.
 *
 * Phase 3 routes this through the structured logger (pino) alongside every
 * other operator-facing event. Until that logger exists, standard error is the
 * correct destination rather than a placeholder: it is unbuffered, it is what a
 * systemd unit captures, and it is not stdout — which the CLI parses.
 */
const stderrSink: PrivilegeWarningSink = (message) => {
  process.stderr.write(`${message}\n`);
};

/**
 * A warner that emits at most one banner over its lifetime.
 *
 * Exported as a FACTORY rather than exposing a reset on the module-level
 * instance. A `resetForTests()` would be a way for production code to re-arm
 * the warning, and "at most once per process" is the property under test — a
 * test that reaches for a reset is testing a different function than the one
 * that ships. A test makes its own warner; `run()` uses the shared one.
 */
export function createPrivilegeWarner(
  sink: PrivilegeWarningSink = stderrSink,
): (mode: PrivilegeMode, platform?: NodeJS.Platform) => void {
  let warned = false;
  return (mode, platform) => {
    if (warned) return;
    const text = privilegeWarning(mode, platform);
    // `dropped` yields no text and — importantly — does not consume the one
    // warning. A process whose first workspace dropped and whose second did not
    // must still hear about the second.
    if (text === undefined) return;
    warned = true;
    sink(text);
  };
}

const processWarner = createPrivilegeWarner();

/**
 * The process-wide warner `run()` uses. See {@link createPrivilegeWarner}.
 *
 * It says what THIS decision was, and cannot say whether it agrees with the one
 * the workspace was created under — that is {@link privilegeModeMismatch}, which
 * needs both decisions and therefore a caller that kept the first one.
 */
export function warnPrivilegeModeOnce(mode: PrivilegeMode): void {
  processWarner(mode);
}

/** One line of `/etc/group`, parsed. */
export interface GroupEntry {
  readonly name: string;
  readonly gid: number;
  /** Supplementary members. A user's PRIMARY group does not list them here. */
  readonly members: readonly string[];
}

/**
 * Parse one numeric id field out of a `/etc/group` or `/etc/passwd` line.
 *
 * **`Number()` is the wrong parser here, and its wrongness has a direction.**
 * `Number('')` is `0`, `Number(' 12 ')` is `12`, and `Number('0x10')` is `16`,
 * so `Number.isInteger(Number(field))` accepts a line whose id field is *empty*
 * and resolves it to **0 — the root user and the root group**. A malformed or
 * truncated line in the group database would then make {@link applyWorkerAccess}
 * `chown` the worktree, the scratch `HOME` and the worktree administrative
 * directory to group root, set group `rw` on them, and report `applied`: a
 * privilege-boundary failure that announces success. The two other coercions are
 * milder but the same shape — a padded or hex field silently naming an identity
 * the operator did not write.
 *
 * So the accepted form is exactly what the file format allows: a bare,
 * non-negative decimal, and nothing else. Anything else makes the entry *not an
 * entry*, which surfaces as `resolveGroupId` returning `undefined` and
 * `applyWorkerAccess` degrading with a named reason (and its banner) — loud, and
 * never a grant to an identity nobody chose.
 */
function parseId(field: string | undefined): number | undefined {
  if (field === undefined || !/^\d+$/.test(field)) return undefined;
  const value = Number(field);
  // A gid past 2^53 cannot round-trip through a JS number, and passing a
  // rounded one to `chown` would name a DIFFERENT group than the file does.
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Strip a trailing carriage return from one line.
 *
 * A group file that has been through a Windows editor (or a CRLF-normalising
 * container build) leaves `\r` on the last field of every line. Left in place it
 * rides along on the final member name, so `entry.members.includes(user)` is
 * `false` for a user who *is* a member — which would silently invert the
 * environment guard in `privilege.test.ts` that exists to stop the T-2-30
 * assertion going vacuous.
 */
function withoutCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Parse `/etc/group` content.
 *
 * A parser rather than a shell-out to `getent`, for the reason
 * {@link resolveOnPath} gives: resolving an identity must not be a process
 * launch. The honest limitation is that a directory-service identity
 * (LDAP/SSSD) does not appear in this file — in that deployment
 * {@link applyWorkerAccess} degrades with a named reason instead of silently
 * granting nothing, which is the behaviour that matters.
 *
 * A line whose gid field is not a bare decimal is **skipped**, not repaired and
 * not defaulted. See {@link parseId} for why defaulting is the dangerous option.
 */
export function parseGroupEntries(text: string): readonly GroupEntry[] {
  const entries: GroupEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = withoutCarriageReturn(raw);
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(':');
    const name = fields[0];
    const gid = parseId(fields[2]);
    if (name === undefined || name === '' || gid === undefined) continue;
    entries.push({
      name,
      gid,
      members: (fields[3] ?? '').split(',').filter((member) => member !== ''),
    });
  }
  return entries;
}

/** Read and parse the group database. */
export async function readGroupEntries(
  file = '/etc/group',
): Promise<readonly GroupEntry[]> {
  return parseGroupEntries(await readFile(file, 'utf8'));
}

/** The numeric gid behind a group name, or `undefined` if it is not in the file. */
export async function resolveGroupId(
  name: string,
  file = '/etc/group',
): Promise<number | undefined> {
  const entries = await readGroupEntries(file);
  return entries.find((entry) => entry.name === name)?.gid;
}

/** A user's numeric identity as `/etc/passwd` records it. */
export interface UserIds {
  readonly uid: number;
  /** The PRIMARY group. Supplementary memberships live in `/etc/group`. */
  readonly gid: number;
}

/**
 * The numeric ids behind a user name, or `undefined` if it is not in the file.
 *
 * Parsed with the same strictness as {@link parseGroupEntries}, and for the same
 * reason: a `/etc/passwd` line whose uid field is empty would otherwise resolve
 * to **uid 0**, and this function is what the privilege test compares a dropped
 * child's reported identity against.
 */
export async function resolveUserIds(
  name: string,
  file = '/etc/passwd',
): Promise<UserIds | undefined> {
  const text = await readFile(file, 'utf8');
  for (const raw of text.split('\n')) {
    const line = withoutCarriageReturn(raw);
    const fields = line.split(':');
    if (fields[0] !== name) continue;
    const uid = parseId(fields[2]);
    const gid = parseId(fields[3]);
    if (uid === undefined || gid === undefined) continue;
    return { uid, gid };
  }
  return undefined;
}

export interface WorkerAccessConfig {
  /** The decision from {@link privilegeLauncher}. Anything but `dropped` is a no-op. */
  readonly mode: PrivilegeMode;
  /** The shared group. Both the daemon user and the worker user are members. */
  readonly group: string | undefined;
  /**
   * The worker's user NAME, resolved to a uid through the passwd database.
   *
   * What lets the grant tell "an entry the worker made" (the worker's own to
   * manage -- skipped) from "an entry somebody else owns that the daemon cannot
   * widen" (which must degrade loudly, not be waved through as though the
   * worker had made it). Without it nothing is treated as the worker's, which is
   * the strict direction. A name that is set but unresolvable degrades, because
   * a `sudo --user` of a name `/etc/passwd` does not have fails anyway.
   */
  readonly workerUser?: string;
  /**
   * Paths that must stay daemon-writable only, however they arrived.
   *
   * `<common git dir>/config` and `<common git dir>/hooks`, in practice: both
   * name programs git executes on the DAEMON's behalf. A file has its group and
   * world write bits cleared; a directory has them cleared on itself and on
   * every entry beneath it. A path that does not exist is skipped (there is
   * nothing to protect). Passed in rather than derived here so this module holds
   * no opinion about git's layout.
   *
   * **Runs whether or not the grants succeeded.** A degraded grant is a reason
   * to say so, never a reason to leave `.git/config` writable.
   */
  readonly protect?: readonly string[];
  /**
   * Directories the worker may create entries in and may NOT touch the daemon's
   * entries of: group `rwx` plus the sticky bit (`1775`), applied to the
   * directory itself and **not** recursively.
   *
   * The loose-object fan-out directories (`objects/xx`), in practice. Sticky is
   * the whole point: an entry in a sticky directory can be unlinked or renamed
   * only by its owner or the directory's owner, so the worker can add objects
   * and cannot replace or delete one the daemon wrote.
   */
  readonly stickyDirs?: readonly string[];
  /** Overridable for tests. Defaults to `/etc/group`. */
  readonly groupFile?: string;
  /** Overridable for tests. Defaults to `/etc/passwd`. */
  readonly passwdFile?: string;
  /**
   * Test seam: called with each child's path immediately before the grant walk
   * opens it -- the window in which a path-based walk could be redirected by a
   * symlink swap. A test swaps the entry here, deterministically, instead of
   * racing a second process for the same window. Never set in production.
   */
  readonly beforeOpen?: (path: string) => void | Promise<void>;
}

/**
 * What granting the worker access actually did.
 *
 * A discriminated union following `ScratchHomeTeardown`'s precedent: the
 * three outcomes want different things from the caller, and `degraded` in
 * particular is a real event an operator should see — a run whose worker cannot
 * write its own worktree will fail in a way that looks like the agent being
 * broken.
 */
export type WorkerAccessReport =
  | {
      readonly outcome: 'applied';
      readonly group: string;
      readonly gid: number;
      readonly paths: readonly string[];
    }
  | {
      /** Not dropped, so there is no second identity to grant anything to. */
      readonly outcome: 'not-applicable';
      readonly mode: PrivilegeMode;
    }
  | {
      readonly outcome: 'degraded';
      /** Names what could not be done. Never a value from the child's environment. */
      readonly reason: string;
    };

/** The OS error code behind a failed filesystem call, when there is one. */
function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'unknown error';
}

/**
 * One filesystem entry, held open so that what was inspected is what is changed.
 *
 * The reason this is an object and not a path: every operation below goes
 * through the SAME open file, never back through the path. A path is a name an
 * attacker who can write the parent directory can re-point between two calls;
 * an open descriptor is the inode itself.
 */
interface HeldEntry {
  /** `fstat` of the open entry -- not `lstat` of a name that may since have moved. */
  readonly info: Stats;
  chown(gid: number): Promise<void>;
  chmod(mode: number): Promise<void>;
  /** The names inside a directory. */
  list(): Promise<string[]>;
  /** The path to open `name` through, as a child of THIS open entry. */
  child(name: string): string;
  close(): Promise<void>;
}

/**
 * Open an entry, or report why it is not one to touch.
 *
 * `undefined` means "skip it": a symlink, something that vanished, something that
 * is not a file or directory. `root` is true for a path the caller NAMED, where
 * absence or a symlink is not a thing to step over quietly.
 */
type OpenEntry = (
  path: string,
  root: boolean,
) => Promise<HeldEntry | undefined>;

/** What `open(2)` says about an entry that is simply not there to grant. */
const SKIPPED_ON_OPEN: ReadonlySet<string> = new Set([
  'ELOOP', // O_NOFOLLOW met a symlink
  'ENOENT', // gone since the directory was read (git renames its tmp_obj_*)
  'ENOTDIR', // replaced by a file since the directory was read
  'ENXIO', // a socket, or a fifo with no reader
  'ENODEV',
  'EOPNOTSUPP',
]);

/**
 * `/proc/self/fd/<n>`: the directory a descriptor stands for, as a path.
 *
 * `fs/promises` has no `fchownat` and no `readdir(fd)`, so the way to keep
 * walking THROUGH an open directory rather than back through its name is the
 * kernel's own: a path under `/proc/self/fd/<n>/` resolves relative to the
 * descriptor's inode, wherever the directory's name has since been pointed.
 */
const PROC_SELF_FD = '/proc/self/fd';

/**
 * The race-free opener (Linux): `O_NOFOLLOW`, then everything on the descriptor.
 *
 * `lstat`-then-`chown` -- what this module did -- is a time-of-check/time-of-use
 * gap over a tree the WORKER can write: it swaps a daemon-owned entry for a
 * symlink between the two calls and the daemon `chown`s and `chmod`s the target
 * (reproduced: a repository's `pre-commit` hook went to the worker's group, group
 * writable, in 3 tries of 300). `open(O_NOFOLLOW)` refuses a symlink atomically
 * with the open, and `fchown`/`fchmod`/`fstat` act on the inode that was opened,
 * so there is no second name lookup to redirect. Measured against the same probe:
 * 0 hits in 1500 tries and half a million swaps.
 *
 * `O_NONBLOCK` so opening a FIFO the worker planted cannot hang the daemon on a
 * writer that never comes.
 */
function descriptorOpener(workerUid: number | undefined): OpenEntry {
  const flags =
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

  return async (path, root) => {
    let handle: FileHandle;
    try {
      handle = await open(path, flags);
    } catch (error) {
      const code = codeOf(error);
      if (!root && SKIPPED_ON_OPEN.has(code)) return undefined;
      if (!root && code === 'EACCES') {
        // A directory the worker made private (0700) is not one the daemon can
        // open. That is the worker's own business -- but only if the worker
        // made it. `lstat` is a name lookup, and that is fine HERE: nothing is
        // changed on the strength of it, only skipped.
        const info = await lstat(path).catch(() => undefined);
        if (info === undefined) return undefined;
        if (workerUid !== undefined && info.uid === workerUid) return undefined;
      }
      throw error;
    }

    let info: Stats;
    try {
      info = await handle.stat();
    } catch (error) {
      await handle.close();
      throw error;
    }
    const via = `${PROC_SELF_FD}/${String(handle.fd)}`;

    return {
      info,
      chown: (gid) => handle.chown(-1, gid),
      chmod: (mode) => handle.chmod(mode),
      list: () => readdir(via),
      child: (name) => join(via, name),
      close: () => handle.close(),
    };
  };
}

/**
 * The path-based opener, for a platform with no `/proc/self/fd`.
 *
 * Reached only by the platforms the privilege drop does not exist on (D-05), in
 * which `applyWorkerAccess` runs under a test that injected `mode: 'dropped'` to
 * exercise the arithmetic. It checks `lstat` and skips symlinks, and it IS racy
 * in the way {@link descriptorOpener} documents; that is acceptable only because
 * there is no worker identity on those platforms for anything to be raced by.
 * It is never selected on Linux.
 */
const pathOpener: OpenEntry = async (path, root) => {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (!root && SKIPPED_ON_OPEN.has(codeOf(error))) return undefined;
    throw error;
  }
  if (info.isSymbolicLink()) {
    if (root) {
      throw Object.assign(new Error(`${path} is a symbolic link`), {
        code: 'ELOOP',
      });
    }
    return undefined;
  }
  return {
    info,
    chown: (gid) => chown(path, -1, gid),
    chmod: (mode) => chmod(path, mode),
    list: () => readdir(path),
    child: (name) => join(path, name),
    close: () => Promise.resolve(),
  };
};

/**
 * Choose the opener, or say why none is safe.
 *
 * On Linux the only acceptable one is the descriptor-based one, which needs
 * `/proc`. A Linux host without it (a stripped container) gets a degraded report
 * naming that, rather than the racy fallback behind the operator's back.
 */
async function chooseOpener(
  workerUid: number | undefined,
): Promise<OpenEntry | { readonly unavailable: string }> {
  if (process.platform !== 'linux') return pathOpener;
  try {
    await stat(PROC_SELF_FD);
  } catch {
    return {
      unavailable: `${PROC_SELF_FD} is not available, and the grant walk refuses to fall back to path-based chown/chmod over a tree the worker can write (a symlink swap would redirect it) -- mount /proc`,
    };
  }
  return descriptorOpener(workerUid);
}

/** What one walk needs to know that is not the path. */
interface WalkContext {
  readonly open: OpenEntry;
  readonly gid: number;
  /** The worker's uid when known; its entries are its own to manage. */
  readonly workerUid: number | undefined;
  readonly beforeOpen?: (path: string) => void | Promise<void>;
}

/** Whether an entry is one the worker identity made. */
function madeByWorker(info: Stats, ctx: WalkContext): boolean {
  return ctx.workerUid !== undefined && info.uid === ctx.workerUid;
}

/**
 * A cheap, read-only look at a child, used only to SKIP work -- never to decide
 * what to change.
 *
 * Every later attach re-walks the whole worktree, and the common case by then is
 * a file that already carries the grant. Opening each one (open, fstat, close,
 * three trips to the thread pool) cost about 90us an entry, which on a worktree
 * with a `node_modules` in it is seconds per stage; an `lstat` is a fraction of
 * that. It is safe because it is one-directional: a stale answer here can at
 * worst leave a file un-granted until the next attach, and it never reaches
 * `chown`/`chmod` -- anything that might need changing is opened with
 * `O_NOFOLLOW` and decided again from the descriptor. A link, an entry that is
 * gone, and a regular file that is already the worker's or already carries the
 * grant are skipped; a directory (which has to be descended into) and anything
 * unusual is not.
 */
async function nothingToGrant(
  path: string,
  ctx: WalkContext,
): Promise<boolean> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    // Gone: nothing to do. Any other failure is left for the open to report.
    return SKIPPED_ON_OPEN.has(codeOf(error));
  }
  if (info.isSymbolicLink()) return true;
  if (!info.isFile()) return false;
  return (
    madeByWorker(info, ctx) ||
    (info.gid === ctx.gid && (info.mode & 0o060) === 0o060)
  );
}

/**
 * Give the shared group read, write, and traverse permission over one tree.
 *
 * **Symlinks are skipped, never followed -- and "never" includes the race.**
 * `chmod` has no `lchmod` on Linux, so widening through a link inside a worktree
 * would apply the group bits to whatever it points at, and the contents of a
 * worktree are exactly what an agent controls (T-2-35). The check that an entry
 * is not a link is made by `open(O_NOFOLLOW)` and everything after it acts on the
 * open descriptor ({@link descriptorOpener}), so there is no gap between "it was
 * not a link" and "now change it" for the worker to swap a link into.
 *
 * **No world bit is ever set.** The mode is the existing mode OR the group
 * bits, so anything already open stays as it was and nothing becomes readable
 * to every local user because ADL touched it.
 *
 * **Idempotent, and tolerant of what the worker made (D-6-CI-4).** This runs
 * again on every `attach`, by which time the worker has created files in the
 * tree. `chown(2)` and `chmod(2)` by a non-owner fail with `EPERM` even when they
 * would change nothing, so each is issued only when it would change something,
 * and an entry the WORKER made is left to the worker. The gate is "owned by the
 * worker's uid" and nothing looser: an entry owned by a third user that does not
 * already carry the grant is attempted, fails with `EPERM`, and degrades the
 * report -- a repository a human cloned while the daemon runs as another user is
 * a misconfiguration to announce, not one to report as `applied` (it used to be
 * skipped on "the daemon does not own it").
 *
 * **Vanishing is not failure.** `git` renames its `tmp_obj_*` files into place
 * while a walk is under way; an entry that is gone by the time it is opened is
 * skipped. A directory the daemon cannot read that the worker made is skipped
 * for the same reason it is not the daemon's to widen.
 */
async function grantGroupAccess(
  path: string,
  ctx: WalkContext,
  root: boolean,
): Promise<void> {
  const entry = await ctx.open(path, root);
  if (entry === undefined) return;

  try {
    const { info } = entry;
    const directory = info.isDirectory();
    // A fifo, a socket, a device: nothing a worktree needs a grant on.
    if (!directory && !info.isFile()) return;

    if (!madeByWorker(info, ctx)) {
      // -1 means "leave the owner alone" to chown(2). The daemon user stays the
      // owner; only the group changes.
      if (info.gid !== ctx.gid) await entry.chown(ctx.gid);

      const bits = directory ? 0o070 : 0o060;
      // & 0o7777 keeps setuid/setgid/sticky exactly as found rather than
      // dropping them on the way through.
      const mode = info.mode & 0o7777;
      if ((mode & bits) !== bits) await entry.chmod(mode | bits);
    }

    if (!directory) return;

    let names: string[];
    try {
      names = await entry.list();
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      if (code === 'EACCES' && madeByWorker(info, ctx)) return;
      throw error;
    }
    for (const name of names) {
      const child = entry.child(name);
      if (await nothingToGrant(child, ctx)) continue;
      await ctx.beforeOpen?.(child);
      await grantGroupAccess(child, ctx, false);
    }
  } finally {
    await entry.close();
  }
}

/**
 * Give the shared group the ability to PASS THROUGH one directory, and nothing
 * else.
 *
 * `--x` without `r` is the whole point: a process can `cd` into the directory
 * and open a child whose name it already knows, and cannot list what is in it.
 * That is what makes `mkdtemp`'s unpredictable name a control again rather than
 * a decoration — see `exec/scratch-home.ts` § Why the homes live under a
 * directory of their own, and CR-03.
 *
 * Used on {@link scratchHomeRoot} only. It is emphatically NOT a general
 * "grant the parent too" helper: the parent of a worktree is the operator's
 * scratch root, and the parent of anything else could be `/tmp` or `/`.
 */
async function grantTraverse(path: string, gid: number): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(
      `${path} is a symbolic link; refusing to chmod through it (the target is outside this module's knowledge).`,
    );
  }
  await chown(path, -1, gid);
  // `| 0o010` — group execute. Never `0o040` (read: the listing this root
  // exists to withhold) and never `0o020` (write: the owner markers beside each
  // home are what the sweep trusts, and a worker that could rewrite one could
  // ask the sweep to delete a live feature's HOME).
  await chmod(path, (info.mode & 0o7777) | 0o010);
}

/**
 * Give the shared group a directory it may add to and may not tamper with:
 * `g+rwx` and the sticky bit, on the directory itself only.
 *
 * Not recursive on purpose -- see {@link WorkerAccessConfig.stickyDirs}. What is
 * inside was written by the daemon (and is exactly what sticky protects) or by
 * the worker (and is the worker's).
 */
async function grantSticky(path: string, ctx: WalkContext): Promise<void> {
  const entry = await ctx.open(path, false);
  if (entry === undefined) return;
  try {
    const { info } = entry;
    if (!info.isDirectory() || madeByWorker(info, ctx)) return;
    if (info.gid !== ctx.gid) await entry.chown(ctx.gid);
    const mode = info.mode & 0o7777;
    const wanted = mode | 0o070 | 0o1000;
    if (wanted !== mode) await entry.chmod(wanted);
  } finally {
    await entry.close();
  }
}

/**
 * Take group and world write permission off a tree, and never add any.
 *
 * The counterpart to {@link grantGroupAccess}, and the structural half of the
 * defence against 02-RESEARCH.md § Pitfall 5: a linked worktree shares the main
 * repository's `.git/config`, git config names programs git executes, and git
 * has stated it has no plans to change that. Layer 1 (per-invocation `-c`
 * neutralisation) is plan `02-08`. This is layer 2, and it is precisely what a
 * dedicated OS user buys beyond "the agent cannot read /etc/shadow" (T-2-31).
 *
 * Clearing rather than merely not-granting is deliberate. A repository created
 * under a permissive umask can arrive with the config -- or a hook -- already
 * group-writable, and "we did not widen it" would then be true while the worker
 * could still write it. A hook is a program git runs on the daemon's later
 * operations, so it is the same escalation one directory over.
 *
 * Applied to a directory it covers the directory and every entry beneath it;
 * symlinks inside are skipped (the same `open(O_NOFOLLOW)` walk as the grant).
 * An entry that does not exist is nothing to protect.
 */
async function protectFromWorker(
  path: string,
  ctx: WalkContext,
  root: boolean,
): Promise<void> {
  const entry = await ctx.open(path, root);
  if (entry === undefined) return;
  try {
    const { info } = entry;
    const directory = info.isDirectory();
    if (!directory && !info.isFile()) return;

    const mode = info.mode & 0o7777;
    if ((mode & 0o022) !== 0) await entry.chmod(mode & ~0o022);
    if (!directory) return;

    let names: string[];
    try {
      names = await entry.list();
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw error;
    }
    for (const name of names) {
      await protectFromWorker(entry.child(name), ctx, false);
    }
  } finally {
    await entry.close();
  }
}

/** `protect`, run for a path that may legitimately not exist. */
async function protectIfPresent(path: string, ctx: WalkContext): Promise<void> {
  try {
    await protectFromWorker(path, ctx, true);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return;
    throw error;
  }
}

/**
 * Grant the worker user exactly what it must be able to write, and nothing more.
 *
 * The trees passed in are the scratch `HOME`, the feature's worktree, and the
 * main repository's per-worktree administrative directory — the worker needs to
 * write an index and a `HEAD` in that last one in order to commit — plus the
 * shared parts of the main repository a commit writes to (see
 * `worktree/shared-git.ts`). The main repository's `.git/config` and
 * `.git/hooks` are deliberately NOT among them; they are passed as `protect`
 * instead.
 *
 * One path is granted that no caller passes: {@link scratchHomeRoot}, and only
 * `--x`. Without it the worker cannot reach its own `HOME`; with anything more
 * it could list every other live feature's, which is exactly what moving the
 * homes out of `/tmp` was for (CR-03). It is granted here rather than by the
 * backend because this is the module that knows the gid, and it is guarded on a
 * granted path actually being a child of that root so it can never become a
 * general "widen the parent too" rule.
 *
 * **What this does NOT grant is per-feature separation.** See
 * {@link WorkerIdentity}: one group for every feature, so these grants make each
 * feature's worktree reachable by every other concurrently running feature's
 * agent.
 *
 * **`protect` is independent of the grants.** It runs after them whatever they
 * did, and its own failure is reported alongside theirs, so a grant that
 * degraded half way (or never started) cannot be the reason `.git/config` was
 * left writable.
 *
 * A no-op when the mode is not `dropped`. There is no second identity in that
 * case, so widening anything would be pure exposure with no beneficiary.
 */
export async function applyWorkerAccess(
  paths: readonly string[],
  config: WorkerAccessConfig,
): Promise<WorkerAccessReport> {
  if (config.mode !== 'dropped') {
    return { outcome: 'not-applicable', mode: config.mode };
  }

  let workerUid: number | undefined;
  const workerUser = config.workerUser?.trim() ?? '';
  if (workerUser !== '') {
    let ids: UserIds | undefined;
    try {
      ids = await resolveUserIds(workerUser, config.passwdFile);
    } catch (error) {
      return {
        outcome: 'degraded',
        reason: `could not read the user database while resolving ${workerUser}: ${codeOf(error)}`,
      };
    }
    if (ids === undefined) {
      return {
        outcome: 'degraded',
        reason: `worker user ${workerUser} could not be resolved to a uid from the local user database, so entries it owns cannot be told from entries nobody can grant (see parseId)`,
      };
    }
    workerUid = ids.uid;
  }

  const opener = await chooseOpener(workerUid);
  if (typeof opener === 'object') {
    return { outcome: 'degraded', reason: opener.unavailable };
  }

  const granted: string[] = [];
  const grant = await grantPhase(paths, config, opener, workerUid, granted);

  // Always, and AFTER: see the docblock. Its failure never replaces the
  // grant's; both are worth hearing.
  let protectFailure: string | undefined;
  const protectContext: WalkContext = { open: opener, gid: -1, workerUid };
  for (const path of config.protect ?? []) {
    try {
      await protectIfPresent(path, protectContext);
    } catch (error) {
      protectFailure = `could not remove group and world write permission from ${path}: ${codeOf(error)}`;
      break;
    }
  }

  if (!grant.ok) {
    return {
      outcome: 'degraded',
      reason:
        protectFailure === undefined
          ? grant.reason
          : `${grant.reason}; and ${protectFailure}`,
    };
  }
  if (protectFailure !== undefined) {
    return { outcome: 'degraded', reason: protectFailure };
  }

  // `granted`, not `paths`: the caller asked about a few trees and the helper
  // also touched the scratch-home root, so reporting the argument back would
  // understate what this function changed on disk.
  return {
    outcome: 'applied',
    group: grant.group,
    gid: grant.gid,
    paths: granted,
  };
}

/** The grants, as a result rather than an exception (convention 5). */
type GrantResult =
  | { readonly ok: true; readonly group: string; readonly gid: number }
  | { readonly ok: false; readonly reason: string };

async function grantPhase(
  paths: readonly string[],
  config: WorkerAccessConfig,
  open: OpenEntry,
  workerUid: number | undefined,
  granted: string[],
): Promise<GrantResult> {
  const group = config.group?.trim() ?? '';
  if (group === '') {
    return {
      ok: false,
      reason: `the privilege drop is active but ${WORKER_GROUP_VAR} is unset, so the worker user has no shared group through which to reach its worktree or its scratch HOME`,
    };
  }

  let gid: number | undefined;
  try {
    gid = await resolveGroupId(group, config.groupFile);
  } catch (error) {
    return {
      ok: false,
      reason: `could not read the group database while resolving ${group}: ${codeOf(error)}`,
    };
  }

  if (gid === undefined) {
    return {
      ok: false,
      reason: `group ${group} could not be resolved to a gid from the local group database — it is either absent, or its line's gid field is not a bare decimal and was rejected rather than coerced to 0 (see parseId); a directory-service group is not visible here, and the operator must pre-provision a local group (D-06)`,
    };
  }

  const ctx: WalkContext = {
    open,
    gid,
    workerUid,
    ...(config.beforeOpen === undefined
      ? {}
      : { beforeOpen: config.beforeOpen }),
  };

  // The scratch-home root, and ONLY when a home under it is being granted.
  // Ordered before the grants so that a run which cannot traverse to its own
  // HOME degrades before anything has been widened, rather than after.
  if (paths.some((path) => dirname(path) === scratchHomeRoot())) {
    try {
      await grantTraverse(scratchHomeRoot(), gid);
      granted.push(scratchHomeRoot());
    } catch (error) {
      return {
        ok: false,
        reason: `could not give group ${group} traverse access to the scratch-home root ${scratchHomeRoot()}: ${codeOf(error)}`,
      };
    }
  }

  for (const path of paths) {
    try {
      await grantGroupAccess(path, ctx, true);
      granted.push(path);
    } catch (error) {
      // Setting a group requires the calling process to be a member of it,
      // which the install documentation establishes. EPERM here almost always
      // means the daemon user was never added to the shared group -- or that
      // the tree is owned by somebody who is neither the daemon nor the worker.
      return {
        ok: false,
        reason: `could not give group ${group} access to ${path}: ${codeOf(error)}`,
      };
    }
  }

  for (const path of config.stickyDirs ?? []) {
    try {
      // Not added to `granted`: 256 fan-out directories would drown the three
      // trees the report is there to name.
      await grantSticky(path, ctx);
    } catch (error) {
      return {
        ok: false,
        reason: `could not give group ${group} a sticky, writable ${path}: ${codeOf(error)}`,
      };
    }
  }

  return { ok: true, group, gid };
}

/**
 * The banner for a degraded {@link WorkerAccessReport}, or `undefined`.
 *
 * Separate from {@link privilegeWarning} and deliberately NOT once-per-process:
 * this one is about a specific workspace's directories, so suppressing repeats
 * would hide the second broken feature behind the first.
 */
export function workerAccessWarning(
  report: WorkerAccessReport,
): string | undefined {
  if (report.outcome !== 'degraded') return undefined;
  return (
    `${ADL_WARNING_PREFIX} Worker access NOT applied: ${report.reason}.\n` +
    `${ADL_WARNING_PREFIX} The privilege drop is active, so children run as the worker user but may be unable to write their own worktree or scratch HOME. See packages/workspace/README.md § Permission model.`
  );
}

/** Write a degraded worker-access report to standard error, if there is one. */
export function reportWorkerAccess(
  report: WorkerAccessReport,
  sink: PrivilegeWarningSink = stderrSink,
): void {
  const text = workerAccessWarning(report);
  if (text !== undefined) sink(text);
}

/**
 * Write a {@link privilegeModeMismatch} banner to standard error, if there is
 * one.
 *
 * Deliberately NOT once-per-process, for {@link workerAccessWarning}'s reason:
 * a mismatch is a fact about one workspace's exec, so suppressing repeats would
 * hide the second broken feature behind the first.
 */
export function reportPrivilegeModeMismatch(
  creation: PrivilegeDecision,
  runtime: PrivilegeDecision,
  sink: PrivilegeWarningSink = stderrSink,
): void {
  const text = privilegeModeMismatch(creation, runtime);
  if (text !== undefined) sink(text);
}
