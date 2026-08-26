/**
 * The manager-owned git client, and the unconditional configuration
 * neutralisation every one of its invocations carries (D-12, D-19, WORK-07).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **WHY THIS EXISTS ON TOP OF D-08**
 *
 * D-08 points ADL's own git at an ADL-owned `HOME` and `GIT_CONFIG_GLOBAL`, and
 * switches the system scope off. Both were confirmed to work for their own
 * scopes. Neither touches **local** scope — and a linked worktree does not have
 * a local configuration of its own. It shares the main repository's.
 *
 * So an agent working inside its worktree can write the *main* repository's
 * configuration, and ADL reads that file on every git command it runs.
 * Reproduced on this repository's own development machine, git 2.49:
 *
 * ```
 * $ git -C <worktree> config core.hooksPath <attacker dir>
 * $ git -C <main-repo> config --get core.hooksPath
 * <attacker dir>                      <- leaked into the MAIN repository
 * $ grep hooksPath <main-repo>/.git/config
 * hooksPath = <attacker dir>
 * ```
 *
 * This is code execution, not misconfiguration: the keys below name programs
 * git runs during ordinary operations. Also reproduced locally — a
 * `post-index-change` hook planted through a poisoned `core.hooksPath` **ran**
 * during a plain `git status --porcelain` on the main repository and wrote its
 * sentinel file; with {@link NEUTRALISE_ARGS} in the argv it did not.
 *
 * And there is no version to wait for. Git's position, cited in the advisories
 * that documented this class, is that it *"currently has no plans to change the
 * behaviour regarding potentially dangerous configuration directives in a
 * repo's `.git/config` file"*. ADL neutralises them itself, on every invocation,
 * or not at all.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **The neutralisation is not a parameter.** It is not a default a caller may
 * override, not an option an operator may switch off, and not a wrapper a caller
 * may choose to skip. That is structural here rather than documented: the argv
 * builder is private to this module, so there is no exported way to reach
 * {@link Workspace.exec} without the prefix, and `test/git/manager-git.test.ts`
 * drives every exported operation and finds the prefix in each captured argv.
 * A neutralisation an operator can turn off is a neutralisation that will be off
 * on the installation that needed it, and the failure produces no output at all
 * until the planted program runs.
 *
 * **Phases 5 and 9 extend this interface; they do not go around it.** The forge
 * push, the remote calls, and the pull-request operations are new methods on
 * {@link ManagerGitClient} that call the same private {@link ManagerGitClient}
 * argv builder — which is why they inherit the overrides without anyone
 * remembering to add them. A new call site that assembles its own `git` argv
 * and hands it to `workspace.exec()` would compile, pass lint, and be wrong.
 *
 * **There is exactly one other consumer of {@link NEUTRALISE_ARGS}, and it is
 * not a call site — it is the other chokepoint.** `git/adl-git.ts` runs the
 * worktree plumbing (`worktree add/remove/list/prune`, `branch`, `status`,
 * `stash create`, `update-ref`, `checkout`) that this narrow client deliberately
 * does not expose, and it splices the same frozen list into the same position.
 * That module exists because those eight invocations went through `simple-git`
 * with no overrides and no controlled environment for the whole of plan `02-08`
 * — 02-REVIEW.md CR-01 and CR-02 — which is to say the claim two paragraphs up
 * was false in this package's own source at the moment it was written. Read
 * `adl-git.ts`'s docblock for what now makes a ninth bypass fail the build
 * rather than pass review.
 */
import type { LogChunk, Workspace } from '@adl/core/stage';
import { WorkspaceError } from '../errors.js';

/**
 * The executable configuration keys ADL neutralises, overridden with something
 * inert — **not every executable key git has**. See
 * {@link NEUTRALISATION_RESIDUAL_RISK}, which is the honest half of this
 * sentence and was missing until 02-REVIEW.md WR-12 pointed out that the word
 * "every" was doing work the list could not support.
 *
 * Each entry carries the answer to "what does an attacker get from this one",
 * because eight opaque assignments is a list a future contributor will trim —
 * that is threat T-2-37, and the per-key loop in `test/git/poisoned-config.test.ts`
 * is the other half of the defence: a removed entry removes its own assertion,
 * so trimming this list makes the suite prove less rather than fail. Read that
 * loop before touching this array.
 *
 * All eight were verified locally, one at a time, against a repository whose
 * local configuration had that key poisoned: in every case
 * `git -c <entry> config --get <key>` returned the neutralised value.
 *
 * **Adding an entry is a two-file change.** `test/git/manager-git.test.ts`
 * asserts this list and the README's "What ADL's own git overrides" table
 * describe the same key set, so an addition here without a README row fails the
 * suite. That correspondence is what keeps accepted risk T-2-42 discoverable.
 */
export const NEUTRALISED_CONFIG = Object.freeze([
  // A directory of scripts git executes around ordinary operations. Verified to
  // fire during `git status` via `post-index-change`.
  'core.hooksPath=',
  // A command git runs to ask what changed. It executes on status, diff, and
  // anything that refreshes the index — the most reliably triggered of the set.
  'core.fsmonitor=false',
  // A command git pipes its output through. `cat` rather than empty: a pager
  // that cannot run is a git command that fails, and this must never be the
  // reason a manager operation breaks.
  'core.pager=cat',
  // A command git launches to compose a message. `false` is the POSIX utility
  // that does nothing and exits non-zero — a manager operation that somehow
  // wanted an editor should fail rather than open one.
  'core.editor=false',
  // The program git uses to reach a remote. An attacker-chosen value here runs
  // on every fetch and push.
  'core.sshCommand=',
  // A program git runs to obtain credentials — so it is both an execution
  // vector and, pointed at an attacker's helper, a way to be *handed* the forge
  // token ADL is about to push with. Empty resets the helper list.
  'credential.helper=',
  // A program git runs instead of computing a diff itself.
  'diff.external=',
  // `ext::<command>` URLs run an arbitrary command as the transport. `never`
  // is git's own refusal, rather than a value this module invents.
  'protocol.ext.allow=never',
] as const);

/**
 * What {@link NEUTRALISED_CONFIG} does **not** cover, stated rather than implied
 * (02-REVIEW.md WR-12, threat T-2-42).
 *
 * A residual risk that is written down is an accepted one; a residual risk that
 * a reader has to infer from the absence of a key is one nobody accepted. Two
 * families are open, and they differ in kind:
 *
 * 1. **Wildcard driver keys, which cannot be neutralised by name at all.**
 *    `filter.<driver>.clean` / `.smudge` and `diff.<driver>.textconv` /
 *    `.command` name programs git runs when a `.gitattributes` entry selects
 *    that driver — on checkout, on status, and on diff. `<driver>` is chosen by
 *    the attacker, so `-c filter.x.clean=` closes one driver and not the
 *    mechanism. This is the substantive part of the finding: the reachable
 *    surface here is *repository content* (a committed `.gitattributes`), not
 *    configuration, and closing it needs a different control — `-c
 *    core.attributesFile=` only disables the *global* attributes file, never
 *    the tracked one or `.git/info/attributes`.
 * 2. **Fixed-name keys not yet in the list**, each of which is a one-line
 *    addition above plus a README row: `core.alternateRefsCommand`,
 *    `core.askPass`, `gpg.program`, `gpg.ssh.program`, `sequence.editor`,
 *    `uploadpack.packObjectsHook`. None of them is reachable through an
 *    operation `ManagerGitClient` ships today — ADL neither signs, nor prompts,
 *    nor serves an upload-pack — which is why they are recorded here rather
 *    than added blind; Phase 5's push and Phase 9's forge operations make
 *    `gpg.*` and `uploadpack.*` live, and that is the change that should add
 *    them.
 *
 * Both are additionally covered by the OS layer wherever WORK-05's privilege
 * drop is in force, because the worker cannot write `<mainRepo>/.git/config` at
 * all there — but D-05 makes that Linux-only, so it is a second layer and never
 * the argument.
 */
export const NEUTRALISATION_RESIDUAL_RISK =
  'filter.<driver>.clean/.smudge and diff.<driver>.textconv/.command remain reachable through a committed .gitattributes: the driver name is attacker-chosen, so no fixed -c override closes the mechanism. core.alternateRefsCommand, core.askPass, gpg.program, gpg.ssh.program, sequence.editor and uploadpack.packObjectsHook are unneutralised fixed-name keys, none reachable through an operation ManagerGitClient ships today.';

/**
 * {@link NEUTRALISED_CONFIG} flattened into argv form.
 *
 * The `-c` argument form rather than `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n`,
 * on the research's recommendation and for two reasons that matter here: it is
 * per-invocation, and it is visible in the argv — so it appears in a log, it can
 * be asserted by a test that captures the argv, and it cannot be lost by a
 * refactor of the environment builder. Both forms were verified to beat a
 * poisoned local value; only one of them is auditable after the fact.
 */
export const NEUTRALISE_ARGS: readonly string[] = Object.freeze(
  NEUTRALISED_CONFIG.flatMap((assignment) => ['-c', assignment]),
);

/** One entry of `git status --porcelain=v1 -z`. */
export interface GitStatusEntry {
  /** The two-character XY code, verbatim — `' M'`, `'??'`, `'R '`. */
  readonly code: string;
  /** Path relative to the repository root. Never quoted: `-z` is used. */
  readonly path: string;
  /** Where the content came from, for a rename or a copy. */
  readonly from?: string;
}

/**
 * ADL's own git operations — a handful of named operations, never a live handle.
 *
 * The narrow-interface-plus-factory shape follows
 * `packages/db/src/repository/features.ts`: what leaves a module is named
 * functions, not an object a caller can reach into. That is load-bearing rather
 * than stylistic here. A client that exposed its `Workspace`, or a `raw(argv)`
 * escape hatch, would put a git invocation without the neutralisation one line
 * away from every future call site.
 */
export interface ManagerGitClient {
  /** The working tree's status, parsed. */
  status(): Promise<readonly GitStatusEntry[]>;
  /** Resolve a revision to its full object name. */
  revParse(rev: string): Promise<string>;
  /** Every local branch, by short name. */
  branches(): Promise<readonly string[]>;
  /**
   * The configuration value git *actually sees* for `key` during one of this
   * client's invocations, or `undefined` when it is unset.
   *
   * This is a real operation and not a test hook, though the poisoned-config
   * suite is its heaviest user: an operator asking "what committer identity is
   * ADL going to use" has no other way to get an answer that accounts for the
   * overrides, and a status view that reported the *file's* value would be
   * reporting the poisoned one.
   */
  effectiveConfig(key: string): Promise<string | undefined>;
  /**
   * Every file that exists at `ref`, repo-relative, optionally restricted to
   * one `pathPrefix` (M05's detection scanner — `git ls-tree`, not a working
   * tree walk, so this reads the DEFAULT BRANCH's committed state rather than
   * whatever an agent's worktree currently has checked out).
   *
   * `pathPrefix` is a plain string handed to git's own pathspec matching —
   * git itself, not this client, decides what "under `pathPrefix`" means, so
   * there is nothing here to contain: an out-of-tree pathspec simply matches
   * nothing.
   */
  listFiles(ref: string, pathPrefix?: string): Promise<readonly string[]>;
  /**
   * Every path that differs between `base` and `head`, repo-relative
   * (protected-path enforcement, ROLE-11, M05 step 5.16 — `@adl/manager`'s
   * `loop/protected-paths-check.ts` is the caller).
   *
   * `base...head` — three dots, not two. Git diffs `head` against the merge
   * base of `base` and `head`, never against `base`'s own tip. That is what
   * makes one expression correct for both of this caller's cases: round 1's
   * `base` is the watched repository's own default branch, which may have
   * moved past the commit the feature actually branched from by the time this
   * runs, while every later round's `base` is an ancestor of `head` by
   * construction (the developer's own prior commit) — where the merge base
   * *is* `base` and the two forms agree. Two dots would silently include
   * unrelated commits `base` picked up after the feature diverged.
   */
  diffNameOnly(base: string, head: string): Promise<readonly string[]>;
  /**
   * Push `refspec` to `remoteUrl` (M05's forge publish step).
   *
   * **Deliberately no credential parameter.** `NEUTRALISE_ARGS` already
   * resets `credential.helper` to empty on every invocation this client
   * makes (see the class docblock), so the one git-native mechanism left for
   * an authenticated HTTPS push is a `remoteUrl` carrying its own
   * `https://<user>:<token>@host/...` — libcurl reads embedded URL
   * credentials directly and never consults a helper, so this needs no
   * change to the neutralisation list. Building that URL — obtaining a
   * short-lived installation token and formatting it in — is the caller's
   * job (the forge adapter), never this client's: `test/git/manager-git.test.ts`'s
   * credential-boundary suite is what keeps a "just add a token field"
   * shortcut from landing here instead. The one accepted residual this
   * choice carries — the credential is a plain `remoteUrl` argv element, and
   * argv is visible to another process on the same host via `ps` — is
   * recorded in `docs/plan/DEBT.md` rather than solved by this signature.
   */
  push(remoteUrl: string, refspec: string): Promise<void>;
}

export interface ManagerGitClientOptions {
  /**
   * The `PATH` the `git` child is resolved from.
   *
   * Defaults to the daemon's own. This is one of the two places ADL reads its
   * own process environment on purpose (the other is the worker identity in
   * `exec/privilege.ts`), and what it reads is a search path — never a
   * credential. Under `extendEnv: false` execa resolves the executable from the
   * child's `PATH` rather than the parent's, so this cannot be omitted
   * (02-RESEARCH.md § Pitfall 7).
   */
  readonly path?: string;
  /** The git executable. A parameter so a test can point at a stand-in. */
  readonly gitBinary?: string;
}

/** What one invocation produced. Internal — see {@link ManagerGitClient}. */
interface GitOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Build the client over a host-rooted {@link Workspace}.
 *
 * The workspace arrives as a parameter rather than being constructed here, and
 * that is the D-17 boundary: this module owns no exec primitive, imports no git
 * library, and names no backend. It builds argv and reads output. Everything
 * else — the zero-inherit environment, the ADL-owned `HOME` and
 * `GIT_CONFIG_GLOBAL`, the disabled system scope, the single process launch —
 * belongs to the workspace it was handed, which the caller resolved from the
 * registry like any other.
 */
export function managerGitClient(
  workspace: Workspace,
  options: ManagerGitClientOptions = {},
): ManagerGitClient {
  const gitBinary = options.gitBinary ?? 'git';
  const path = options.path ?? process.env.PATH ?? '';

  /**
   * The one place a git argv is assembled, and the reason the neutralisation
   * cannot be skipped.
   *
   * Deliberately **not** exported, and deliberately not reachable from the
   * returned object. The order is fixed: binary, then every override, then the
   * subcommand. `-c` must precede the subcommand — git parses it as a top-level
   * option — so a caller passing overrides "as extra arguments" would silently
   * pass them to the subcommand instead, which is one more reason this is not
   * something a call site does for itself.
   *
   * `env` is threaded through for the forge token Phase 5's push will need
   * (D-09: named on the one `exec()` that needs it, never on the workspace).
   * No operation supplies one today, which is why it is optional and why there
   * is no credential field anywhere on this module's public types.
   */
  async function git(
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
  ): Promise<GitOutcome> {
    const out: string[] = [];
    const err: string[] = [];

    const collect = (chunk: LogChunk): void => {
      // execa's line iterable strips the newline, so the lines are rejoined
      // rather than concatenated. `-z` output carries no newlines at all and
      // therefore arrives as a single chunk, which is exactly why the porcelain
      // parser below can rely on NUL as its only separator.
      (chunk.stream === 'stdout' ? out : err).push(chunk.text);
    };

    const result = await workspace.exec(
      {
        argv: [gitBinary, ...NEUTRALISE_ARGS, ...args],
        cwd: workspace.root,
        path,
        ...(env === undefined ? {} : { env }),
        // v1 always. See `NetworkPolicy` and `ResourceLimits` in @adl/core.
        networkPolicy: 'full',
        resources: {},
      },
      collect,
    );

    return {
      exitCode: result.exitCode,
      stdout: out.join('\n'),
      stderr: err.join('\n'),
    };
  }

  /** Run, and treat anything but a clean exit as a failure worth naming. */
  async function gitOk(args: readonly string[]): Promise<string> {
    const outcome = await git(args);
    if (outcome.exitCode !== 0) {
      throw new WorkspaceError(
        `git ${args.join(' ')} failed with exit code ${String(outcome.exitCode)}: ${outcome.stderr.trim() || '(no stderr)'}`,
        workspace.id,
      );
    }
    return outcome.stdout;
  }

  return {
    async status(): Promise<readonly GitStatusEntry[]> {
      // `-z` rather than the default: git *quotes and escapes* paths containing
      // spaces, quotes, or non-ASCII bytes in the newline-separated form, so a
      // line-based parser would hand callers a path that does not exist. NUL
      // separation has no escaping at all. Verified shape: " M f.txt\0?? u.txt\0".
      const raw = await gitOk(['status', '--porcelain=v1', '-z']);
      const records = raw.split('\0').filter((record) => record !== '');
      const entries: GitStatusEntry[] = [];

      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        // `noUncheckedIndexedAccess` is on; the loop bound makes this
        // unreachable, and asserting it away would be the one place in this
        // file the compiler is overruled.
        if (record === undefined) continue;

        const code = record.slice(0, 2);
        const path = record.slice(3);

        // A rename or a copy emits TWO records: the destination with the code,
        // then the source on its own. Consuming the second here is what stops
        // it being reported as a nameless entry with a two-character "code"
        // chopped off the front of a real path.
        if (code.startsWith('R') || code.startsWith('C')) {
          const from = records[i + 1];
          i += 1;
          entries.push({ code, path, ...(from === undefined ? {} : { from }) });
          continue;
        }

        entries.push({ code, path });
      }

      return entries;
    },

    async revParse(rev: string): Promise<string> {
      // `--end-of-options` so a revision beginning with `-` is a revision and
      // not a flag. Verified supported by the git this repository builds
      // against. The same guard is on `effectiveConfig`.
      return (
        await gitOk(['rev-parse', '--verify', '--end-of-options', rev])
      ).trim();
    },

    async branches(): Promise<readonly string[]> {
      // `for-each-ref` rather than `branch --list`: `branch` is porcelain whose
      // output git documents as not being a contract, and it decorates the
      // current branch with a marker.
      const raw = await gitOk([
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads',
      ]);
      return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    },

    async effectiveConfig(key: string): Promise<string | undefined> {
      const outcome = await git(['config', '--get', '--end-of-options', key]);

      // Exit 1 is git's "no such key", and it is the ONLY thing that
      // distinguishes an unset key from one set to the empty string — several
      // of the neutralised values *are* the empty string, so collapsing the two
      // would make half the per-key assertions unable to tell a working
      // override from a missing one. Verified: unset -> exit 1 with no output;
      // `-c a.b=` -> exit 0 with empty output.
      if (outcome.exitCode === 1) return undefined;

      if (outcome.exitCode !== 0) {
        throw new WorkspaceError(
          `git config --get ${key} failed with exit code ${String(outcome.exitCode)}: ${outcome.stderr.trim() || '(no stderr)'}`,
          workspace.id,
        );
      }

      return outcome.stdout.trim();
    },

    async listFiles(
      ref: string,
      pathPrefix?: string,
    ): Promise<readonly string[]> {
      // `--end-of-options` so a ref beginning with `-` is a ref, matching
      // `revParse`'s own guard. `-z` for the same reason `status` uses it: a
      // path containing a space, quote, or non-ASCII byte would otherwise
      // arrive quoted and escaped rather than literal.
      const args = [
        'ls-tree',
        '-r',
        '--name-only',
        '-z',
        '--end-of-options',
        ref,
      ];
      if (pathPrefix !== undefined) args.push('--', pathPrefix);
      const raw = await gitOk(args);
      return raw.split('\0').filter((path) => path !== '');
    },

    async diffNameOnly(base: string, head: string): Promise<readonly string[]> {
      // `--end-of-options` before the range, matching `revParse`'s own guard —
      // `base`/`head` are shas or branch names this client's own callers
      // compute, never a raw pathspec, but the guard is unconditional here for
      // the same reason it is everywhere else in this file: nobody has to
      // remember it applies. `-z` for the same reason `listFiles` uses it — a
      // changed path containing a space, quote, or non-ASCII byte would
      // otherwise arrive quoted and escaped rather than literal.
      const raw = await gitOk([
        'diff',
        '--name-only',
        '-z',
        '--end-of-options',
        `${base}...${head}`,
      ]);
      return raw.split('\0').filter((path) => path !== '');
    },

    async push(remoteUrl: string, refspec: string): Promise<void> {
      // No `--end-of-options`: unlike a revision or a config key, a remote
      // URL and a refspec are never attacker-shaped input this client has to
      // defend a leading `-` against — both are assembled by the caller from
      // known-good pieces (a configured repo's remote and ADL's own
      // `adl/<feature-id>` branch convention, D-13).
      await gitOk(['push', remoteUrl, refspec]);
    },
  };
}
