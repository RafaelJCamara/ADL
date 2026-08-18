/**
 * The ONE place `src/` runs `git` for ADL's own account (CR-01, CR-02, WR-03).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **WHY THIS MODULE EXISTS**
 *
 * `git/manager-git.ts` states the rule — git config names programs git
 * executes, an agent inside a linked worktree can write the *main* repository's
 * `.git/config`, and therefore ADL neutralises those keys itself "on every
 * invocation, or not at all". `git/host-backend.ts` restates it as a structural
 * claim: "there is exactly one exec primitive in the repository … one place
 * where the neutralisation is applied — by construction rather than by every
 * future call site remembering."
 *
 * Both claims were **false** in the shipped source, and the code review that
 * found it (02-REVIEW.md CR-01) is worth quoting in one line: eight production
 * git invocations in `worktree/lifecycle.ts`, `worktree/list.ts` and
 * `worktree/backend.ts` went through `simpleGit(...).raw([...])` and carried
 * neither the overrides nor a controlled environment. `git status` inside the
 * agent's own worktree, `git worktree add` in the main repository — each of them
 * reads the file the agent is able to poison, and the phase's own suite already
 * proved the payload runs (`test/git/poisoned-config.test.ts`, the CONTROL
 * case). CR-02 is the same defect one layer down: `simple-git@3.36.0` spawns
 * with `env: this.env`, `this.env` is `undefined` unless `.env()` was called,
 * and `spawn` with `env: undefined` inherits `process.env` **in full** — so
 * those children carried the daemon's forge token and model key straight into
 * an attacker-planted hook.
 *
 * The fix is not a reminder at eight call sites. It is this module, plus three
 * things that make a ninth call site impossible to add quietly:
 *
 * 1. `eslint.config.js`'s `adl/no-simple-git-in-workspace-src` entry bans the
 *    `simple-git` specifier — static import, `require()`, and dynamic
 *    `import()` — inside `packages/workspace/src/**`. The package-wide spawn
 *    exemption stays exactly one entry wide; this narrows it back for the one
 *    specifier that turned out to be a bypass.
 * 2. `test/contract/workspace-contract.test.ts` reads every file under `src/`
 *    and fails, by filename, if any of them names `simple-git` or `simpleGit` —
 *    the same sole-site shape the registry guard already uses, so the boundary
 *    holds even if the lint config is edited.
 * 3. `test/git/adl-git.test.ts` drives the real production entry points against
 *    a really-poisoned repository and requires the planted hook not to fire,
 *    with a control that requires it to fire through a bare `simpleGit` handle.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **What every invocation from here carries, and why none of it is optional:**
 *
 * - {@link NEUTRALISE_ARGS}, ahead of the subcommand, from the same frozen list
 *   `managerGitClient` uses. One list, one proof loop, one README table.
 * - The zero-inherit child environment, because this goes through
 *   {@link run} — the repository's only process launch — which is the only
 *   caller of `buildChildEnv`. That is D-10 applying to ADL's git for the first
 *   time.
 * - `LC_ALL=C` / `LANG=C`. Git's messages are localised through gettext, and
 *   `worktree/lifecycle.ts` has to tell "this worktree was already gone" from
 *   "this failed" by reading one of them (WR-03). Under the old inheriting
 *   spawn, that comparison was against a message in the *host operator's*
 *   language, so idempotent teardown — the property the GC backstop is built
 *   on — silently stopped working on a French or Japanese deployment. Forcing
 *   the locale here makes the message a constant rather than a setting.
 * - An exit code. `simple-git`'s `GitError` carries exactly `task` and
 *   `message` and no status at all, which is why the old code could only match
 *   prose. {@link AdlGitOutcome.exitCode} is `run()`'s, so a caller can key on
 *   the status *and* the message rather than on the message alone.
 *
 * **`owner: 'adl'`, deliberately.** These are ADL's own children, not an
 * agent's: they must not be dropped to the worker user (the manager has to be
 * able to write `<mainRepo>/.git/config`, which `applyWorkerAccess` takes group
 * and world write off precisely so the worker cannot), and they must not spend
 * WORK-05's once-per-process banner. See `ExecOwner` in `exec/run.ts`.
 */
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExecSpec, LogChunk } from '@adl/core/stage';
import { WorkspaceError } from '../errors.js';
import { run } from '../exec/run.js';
import { NEUTRALISE_ARGS } from './manager-git.js';

/**
 * The default ADL-owned git home: `~/.adl/git-home`.
 *
 * A function rather than a module-level constant so a test can observe the
 * default without the module having read anything at import time. `homedir()`
 * resolves the *daemon's* own home — a non-secret path, never a credential —
 * and this is deliberately not a temp directory: an operator who configures a
 * committer identity for ADL expects it to still be there next week, and
 * `git stash create` (the snapshot primitive) needs one.
 *
 * It lives in this module rather than in `git/host-backend.ts` where it started
 * because the worktree modules need it too, and importing it from a *backend*
 * module would trip the sole-construction-site guard in
 * `test/contract/workspace-contract.test.ts`. The host-git backend imports it
 * from here.
 */
export function defaultHostGitHome(): string {
  return join(homedir(), '.adl', 'git-home');
}

/**
 * The locale every ADL-side git child runs under. See the module docblock.
 *
 * Exported so a test can assert the child really received it, rather than
 * asserting that this file contains a string.
 */
export const ADL_GIT_LOCALE: Readonly<Record<string, string>> = Object.freeze({
  LC_ALL: 'C',
  LANG: 'C',
});

/** What one ADL-side git invocation produced. */
export interface AdlGitOutcome {
  /** `null` only when a signal killed the child. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** What a caller may configure. Everything here has a safe default. */
export interface AdlGitOptions {
  /**
   * ADL's own git home — `HOME` and `GIT_CONFIG_GLOBAL` for the child.
   * Defaults to {@link defaultHostGitHome}, and is created `0700` on first use.
   */
  readonly home?: string;
  /**
   * The `PATH` the `git` child is resolved from. Defaults to the daemon's own.
   *
   * One of the two places ADL reads its own process environment on purpose, and
   * what it reads is a search path — never a credential. Under
   * `extendEnv: false` execa resolves the executable from the CHILD's `PATH`
   * rather than the parent's, so this cannot be omitted (02-RESEARCH.md
   * § Pitfall 7).
   */
  readonly path?: string;
  /**
   * The git executable, as an argv prefix. Defaults to `['git']`.
   *
   * A parameter so a test can point at a stand-in — the same reason
   * `ManagerGitClientOptions.gitBinary` exists. It replaces the *binary*, never
   * the overrides: {@link NEUTRALISE_ARGS} is spliced in after it either way,
   * which is why this is not a hole in the boundary.
   */
  readonly binary?: readonly string[];
}

/**
 * ADL's own git, in one repository or worktree.
 *
 * Two methods rather than one because the two failure dispositions are
 * genuinely different: worktree teardown has to *inspect* a non-zero exit to
 * decide whether it means "already gone", while everything else wants a failure
 * to be an exception naming git's own stderr.
 */
export interface AdlGit {
  /** Run, and hand back the exit code and both streams. Never throws on exit. */
  raw(args: readonly string[]): Promise<AdlGitOutcome>;
  /** Run, and treat anything but a clean exit as a failure worth naming. */
  rawOk(args: readonly string[]): Promise<string>;
}

/**
 * Homes already created, by path.
 *
 * Memoised on the promise rather than on a boolean so two concurrent workspace
 * creations do not race the `mkdir`, and so a failed creation is retried rather
 * than remembered as done.
 */
const homesEnsured = new Map<string, Promise<string>>();

async function ensureHome(home: string): Promise<string> {
  const existing = homesEnsured.get(home);
  if (existing !== undefined) return existing;

  const creating = mkdir(home, { recursive: true, mode: 0o700 }).then(
    () => home,
  );
  homesEnsured.set(home, creating);

  try {
    return await creating;
  } catch (error) {
    homesEnsured.delete(home);
    throw new WorkspaceError(
      `Cannot create ADL's own git home at ${JSON.stringify(home)}: ${
        error instanceof Error ? error.message : 'unknown error'
      }. Every git command ADL runs for itself points HOME and GIT_CONFIG_GLOBAL at it, so there is nothing to fall back to that would not be the daemon user's real home.`,
    );
  }
}

export function adlGit(cwd: string, options: AdlGitOptions = {}): AdlGit {
  const home = options.home ?? defaultHostGitHome();
  const path = options.path ?? process.env.PATH ?? '';
  const binary = options.binary ?? ['git'];

  async function raw(args: readonly string[]): Promise<AdlGitOutcome> {
    const out: string[] = [];
    const err: string[] = [];

    const collect = (chunk: LogChunk): void => {
      // execa's line iterable strips the newline, so the lines are rejoined
      // rather than concatenated. `-z` output carries no newlines at all and
      // therefore arrives as a single chunk, which is what lets the porcelain
      // parsers downstream rely on NUL as their only separator.
      (chunk.stream === 'stdout' ? out : err).push(chunk.text);
    };

    const spec: ExecSpec = {
      // The order is fixed and is the whole point: binary, then every override,
      // then the subcommand. `-c` is a TOP-LEVEL git option — an override that
      // landed after the subcommand would be passed to the subcommand instead
      // and silently do nothing.
      argv: [...binary, ...NEUTRALISE_ARGS, ...args],
      cwd,
      path,
      env: ADL_GIT_LOCALE,
      // v1 always. See `NetworkPolicy` and `ResourceLimits` in @adl/core.
      networkPolicy: 'full',
      resources: {},
    };

    const result = await run(spec, await ensureHome(home), collect, {}, 'adl');

    return {
      exitCode: result.exitCode,
      stdout: out.join('\n'),
      stderr: err.join('\n'),
    };
  }

  return {
    raw,

    async rawOk(args: readonly string[]): Promise<string> {
      const outcome = await raw(args);
      if (outcome.exitCode !== 0) {
        throw new WorkspaceError(
          `git ${args.join(' ')} failed with exit code ${String(outcome.exitCode)}: ${outcome.stderr.trim() || '(no stderr)'}`,
        );
      }
      return outcome.stdout;
    },
  };
}
