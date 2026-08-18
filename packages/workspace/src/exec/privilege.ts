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
import { constants } from 'node:fs';
import {
  access,
  chmod,
  chown,
  lstat,
  readFile,
  readdir,
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
   * Files that must stay daemon-owned and NOT group-writable.
   *
   * `<mainRepo>/.git/config`, in practice. Passed in rather than derived here
   * so this module holds no opinion about git's layout — the backend that knows
   * where the repository is names the file.
   */
  readonly protect?: readonly string[];
  /** Overridable for tests. Defaults to `/etc/group`. */
  readonly groupFile?: string;
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
 * Give the shared group read, write, and traverse permission over one tree.
 *
 * **Symlinks are skipped, never followed.** `chmod` has no `lchmod` on Linux,
 * so widening through a link inside a worktree would apply the group bits to
 * whatever it points at — and the contents of a worktree are exactly what an
 * agent controls. A link to `/etc` is a one-line exploit of a helper that
 * recursed blindly (T-2-35).
 *
 * **No world bit is ever set.** The mode is the existing mode OR the group
 * bits, so anything already open stays as it was and nothing becomes readable
 * to every local user because ADL touched it.
 */
async function grantGroupAccess(path: string, gid: number): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;

  // -1 means "leave the owner alone" to chown(2). The daemon user stays the
  // owner; only the group changes.
  await chown(path, -1, gid);

  const bits = info.isDirectory() ? 0o070 : 0o060;
  // & 0o7777 keeps setuid/setgid/sticky exactly as found rather than dropping
  // them on the way through.
  await chmod(path, (info.mode & 0o7777) | bits);

  if (!info.isDirectory()) return;
  for (const entry of await readdir(path)) {
    await grantGroupAccess(join(path, entry), gid);
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
 * Take group and world write permission off a file, and never add any.
 *
 * The counterpart to {@link grantGroupAccess}, and the structural half of the
 * defence against 02-RESEARCH.md § Pitfall 5: a linked worktree shares the main
 * repository's `.git/config`, git config names programs git executes, and git
 * has stated it has no plans to change that. Layer 1 (per-invocation `-c`
 * neutralisation) is plan `02-08`. This is layer 2, and it is precisely what a
 * dedicated OS user buys beyond "the agent cannot read /etc/shadow" (T-2-31).
 *
 * Clearing rather than merely not-granting is deliberate. A repository created
 * under a permissive umask can arrive with the config already group-writable,
 * and "we did not widen it" would then be true while the worker could still
 * write it.
 */
async function protectFromWorker(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(
      `${path} is a symbolic link; refusing to chmod through it (the target is outside this module's knowledge).`,
    );
  }
  await chmod(path, info.mode & 0o7777 & ~0o022);
}

/**
 * Grant the worker user exactly what it must be able to write, and nothing more.
 *
 * The trees passed in are the scratch `HOME`, the feature's worktree, and the
 * main repository's per-worktree administrative directory — the worker needs to
 * write an index and a `HEAD` in that last one in order to commit. The main
 * repository's `.git/config` is deliberately NOT among them; it is passed as
 * `protect` instead.
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

  const group = config.group?.trim() ?? '';
  if (group === '') {
    return {
      outcome: 'degraded',
      reason: `the privilege drop is active but ${WORKER_GROUP_VAR} is unset, so the worker user has no shared group through which to reach its worktree or its scratch HOME`,
    };
  }

  let gid: number | undefined;
  try {
    gid = await resolveGroupId(group, config.groupFile);
  } catch (error) {
    return {
      outcome: 'degraded',
      reason: `could not read the group database while resolving ${group}: ${codeOf(error)}`,
    };
  }

  if (gid === undefined) {
    return {
      outcome: 'degraded',
      reason: `group ${group} could not be resolved to a gid from the local group database — it is either absent, or its line's gid field is not a bare decimal and was rejected rather than coerced to 0 (see parseId); a directory-service group is not visible here, and the operator must pre-provision a local group (D-06)`,
    };
  }

  // The scratch-home root, and ONLY when a home under it is being granted.
  // Ordered before the grants so that a run which cannot traverse to its own
  // HOME degrades before anything has been widened, rather than after.
  const granted: string[] = [];
  if (paths.some((path) => dirname(path) === scratchHomeRoot())) {
    try {
      await grantTraverse(scratchHomeRoot(), gid);
      granted.push(scratchHomeRoot());
    } catch (error) {
      return {
        outcome: 'degraded',
        reason: `could not give group ${group} traverse access to the scratch-home root ${scratchHomeRoot()}: ${codeOf(error)}`,
      };
    }
  }

  for (const path of paths) {
    try {
      await grantGroupAccess(path, gid);
      granted.push(path);
    } catch (error) {
      // Setting a group requires the calling process to be a member of it,
      // which the install documentation establishes. EPERM here almost always
      // means the daemon user was never added to the shared group.
      return {
        outcome: 'degraded',
        reason: `could not give group ${group} access to ${path}: ${codeOf(error)}`,
      };
    }
  }

  for (const path of config.protect ?? []) {
    try {
      await protectFromWorker(path);
    } catch (error) {
      return {
        outcome: 'degraded',
        reason: `could not remove group and world write permission from ${path}: ${codeOf(error)}`,
      };
    }
  }

  // `granted`, not `paths`: the caller asked about three trees and the helper
  // also touched the scratch-home root, so reporting the argument back would
  // understate what this function changed on disk.
  return { outcome: 'applied', group, gid, paths: granted };
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
