/**
 * A gate's `owned_dir`, from the worker's side (ROLE-09, M08 step 8.6): get it
 * ready before the gate runs, settle which files are the gate's before ADL's
 * own run, and carry exactly those back onto the branch afterwards.
 *
 * ## Why ADL commits, and why here
 *
 * A gate that declares `owned_dir` works in a composed copy with no `.git`
 * (`visible_paths`, 8.1) — it cannot commit, by construction, and the 8.0
 * spike decided that was the right shape: ADL carries the surviving files back
 * into the developer's worktree and commits them itself, at a moment it
 * controls. That moment is after the gate has judged and before the dispatch's
 * `finally` destroys the copy, in the worker, because the worker is the only
 * process holding both roots and the per-dispatch push credential (5.10's
 * constraint, still true for that reason). The round loop learns about the
 * commit through the gate envelope's `GateHeadRange` — this module's commit and
 * nothing else a gate stage committed — and vouches for it, so the next
 * developer is never blamed for it (D-8-A-1).
 *
 * ## Which files are the gate's
 *
 * Three sets, all computed against git rather than guessed:
 *
 * - **What the copy may start with:** the files git tracks under the
 *   directory at HEAD, and nothing else. The worktree must be clean there —
 *   `git status`, plus the index flags that would blind `git status` — and the
 *   copy is then pruned to the tracked set, so a file a developer left
 *   untracked, or hid behind a `.gitignore` it committed, is never run as the
 *   gate's and never committed under ADL's name.
 * - **What belongs to earlier features:** tracked files this branch has not
 *   changed (`diff.changedPaths` is `baseRef...HEAD`, three-dot, so a default
 *   branch that moved on does not count). They are left out of the run and
 *   left alone by the commit — a tester that wrote nothing is not credited
 *   with another feature's tests (D-8-05-3), and cannot quietly rewrite them.
 * - **This feature's:** every other file under the directory at the moment ADL
 *   freezes it ({@link OwnedFilesHost.freeze}) — what earlier rounds carried
 *   back, plus what this attempt wrote.
 *
 * ## What was judged is what lands
 *
 * The freeze happens immediately before ADL's own run (the tester's suite), and
 * it does two things. Everything OUTSIDE the directory goes back to what ADL
 * composed, so a run cannot pass on a helper the gate wrote somewhere that is
 * never committed. And the directory's files are READ INTO MEMORY, so the run
 * is given exactly their paths and the commit writes exactly those bytes — a
 * runner that writes a cache or rewrites a snapshot while it runs cannot make
 * the commit differ from the run. A gate that runs nothing of ADL's (a command
 * gate) is frozen at carry-back instead, which is the same answer.
 *
 * The commit makes the branch hold exactly the third set: files are added or
 * changed, and this feature's files the gate deleted are deleted. A carry-back
 * that fails before its commit lands is undone — files restored, index
 * unstaged — so the next attempt does not find a dirty directory and blame the
 * developer for it.
 *
 * Classify, don't throw (convention 5): every refusal is a `StageError` kind
 * and a sentence, beside the code that knows what went wrong.
 */
import type { StageErrorKind, Workspace } from '@adl/core/stage';
import { directoriesOverlap, isWithinDirectory } from '@adl/core/config';
import {
  carryBackFiles,
  managerGitClient,
  pruneOwnedDirectory,
  readOwnedFiles,
  restoreComposition,
  snapshotComposition,
  type CommitIdentity,
  type CompositionSnapshot,
  type OwnedFileContents,
} from '@adl/workspace';
import type { GateHeadRange } from '../ipc/stage-verdict.js';
import type { OwnedFiles, OwnedFilesHost } from './gates/agent-gate-host.js';

/**
 * Who ADL's own commits are attributed to — author and committer alike.
 *
 * Deliberately not the developer agent's identity (`ADL (claude-code)`), so
 * `git log` tells "the developer wrote this" from "ADL committed what a gate
 * left" without reading a message. Attribution only: anything can forge an
 * author, which is why the round loop vouches by sha, never by name.
 */
export const ADL_COMMIT_IDENTITY: CommitIdentity = Object.freeze({
  name: 'ADL',
  email: 'adl@noreply.local',
});

export type OwnedDirRefusal = {
  readonly ok: false;
  readonly kind: StageErrorKind;
  readonly detail: string;
  /** Present when ADL's commit landed before the failure (a failed push). */
  readonly head?: GateHeadRange;
};

/** What happened to the gate's files after it judged. */
export type CarryBackOutcome =
  | {
      readonly ok: true;
      /** The paths committed, or empty when nothing differed. */
      readonly committed: readonly string[];
      /** ADL's commit, from its parent, when one was made. */
      readonly head?: GateHeadRange;
    }
  | OwnedDirRefusal;

export interface OwnedDirSession {
  /** Handed to the gate, through `AgentGateHost.owned`. */
  readonly host: OwnedFilesHost;
  /** Commit what the gate left, and push the branch when a credential was minted. */
  carryBack(input: {
    readonly stageId: string;
    readonly pushUrl: string | undefined;
    readonly branch: string;
  }): Promise<CarryBackOutcome>;
}

export interface PrepareOwnedDirInput {
  readonly dir: string;
  /** The dispatched feature's folder (`assign.workspaceHandle`). */
  readonly featurePath: string;
  /** The developer's worktree — where the branch is. */
  readonly worktree: Workspace;
  /** The gate's composed, `.git`-less copy. */
  readonly composed: Workspace;
  /** `GateDiff.changedPaths` — what this branch changed since `baseRef`. */
  readonly changedOnBranch: readonly string[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** At most ten paths, then a count — a reason is rendered into a public PR comment. */
function listed(paths: readonly string[]): string {
  return (
    paths.slice(0, 10).join(', ') +
    (paths.length > 10 ? `, and ${String(paths.length - 10)} more` : '')
  );
}

/**
 * Make the copy start from what git tracks, and return the session — or a
 * refusal, before the gate has spent anything.
 */
export async function prepareOwnedDir(
  input: PrepareOwnedDirInput,
): Promise<
  { readonly ok: true; readonly session: OwnedDirSession } | OwnedDirRefusal
> {
  const { dir } = input;

  // `adl.yml`'s own superRefine checks `owned_dir` against ITS `features_dir`,
  // and detection reads the daemon's `repos[].features_dir` instead. This is
  // the check against the folder actually dispatched. `binary_missing` on the
  // composition failure's precedent beside it: "this stage cannot run as
  // configured", non-retryable, and a human's to fix.
  if (directoriesOverlap(dir, input.featurePath)) {
    return {
      ok: false,
      kind: 'binary_missing',
      detail:
        `owned_dir "${dir}" overlaps this feature's folder "${input.featurePath}". The ` +
        "feature folder holds the spec the gate judges against, so ADL will not commit a gate's " +
        "output into it — check that adl.yml's features_dir matches the daemon's repos[].features_dir.",
    };
  }

  const git = managerGitClient(input.worktree);
  let tracked: readonly string[];
  try {
    const dirty = (await git.status()).filter(
      (entry) =>
        isWithinDirectory(entry.path, dir) ||
        (entry.from !== undefined && isWithinDirectory(entry.from, dir)),
    );
    // Only ADL writes here, and ADL commits — or undoes — everything it
    // writes, so a difference is something else's: in practice the
    // developer's agent, which ROLE-11 forbids to change this directory at
    // all. Escalated rather than cleaned up: deleting what the developer left
    // would hide that it tried.
    if (dirty.length > 0) {
      return {
        ok: false,
        kind: 'unparseable',
        detail:
          `${dir} has uncommitted changes in the worktree, and only ADL writes there: ` +
          listed(
            dirty.map(
              (entry) => `${entry.code.trim() || entry.code} ${entry.path}`,
            ),
          ),
      };
    }
    // The two index flags that make `git status` report a modified file as
    // clean. Set by `git update-index`, which nothing in ADL runs.
    const flagged = await git.flaggedIndexEntries(dir);
    if (flagged.length > 0) {
      return {
        ok: false,
        kind: 'unparseable',
        detail:
          `${dir} has files git has been told not to look at (assume-unchanged or ` +
          `skip-worktree), so ADL cannot tell what they hold: ${listed(flagged)}`,
      };
    }
    tracked = await git.listFiles('HEAD', dir);
  } catch (error) {
    return {
      ok: false,
      kind: 'provider_error',
      detail: `could not read what git tracks under owned_dir "${dir}": ${messageOf(error)}`,
    };
  }

  // A filesystem failure here or below is not a refusal of anything the gate
  // or the developer did — it is the host. `provider_error`, retryable on the
  // transient budget, for the same reason a failed git read above is.
  let composition: CompositionSnapshot;
  try {
    await pruneOwnedDirectory(input.composed.root, dir, new Set(tracked));
    composition = await snapshotComposition(input.composed.root);
  } catch (error) {
    return {
      ok: false,
      kind: 'provider_error',
      detail: `could not prepare owned_dir "${dir}" in the gate's workspace: ${messageOf(error)}`,
    };
  }

  const changed = new Set(input.changedOnBranch);
  const earlierFeatures = new Set(tracked.filter((path) => !changed.has(path)));
  const thisFeaturesTracked = tracked.filter(
    (path) => !earlierFeatures.has(path),
  );

  let frozen: OwnedFileContents | undefined;
  async function freeze(): Promise<OwnedFileContents> {
    if (frozen !== undefined) return frozen;
    try {
      await restoreComposition({
        root: input.composed.root,
        source: input.worktree.root,
        snapshot: composition,
        except: dir,
      });
      frozen = await readOwnedFiles(input.composed.root, dir, earlierFeatures);
    } catch (error) {
      frozen = {
        ok: false,
        detail: `${dir} could not be read: ${messageOf(error)}`,
      };
    }
    return frozen;
  }

  return {
    ok: true,
    session: {
      host: {
        dir,
        async freeze(): Promise<OwnedFiles> {
          const contents = await freeze();
          return contents.ok
            ? { ok: true, files: [...contents.files.keys()] }
            : contents;
        },
      },
      async carryBack({ stageId, pushUrl, branch }) {
        const contents = await freeze();
        if (!contents.ok) {
          return {
            ok: false,
            kind: 'unparseable',
            detail: `the ${stageId} gate left something in ${dir} ADL will not commit: ${contents.detail}`,
          };
        }

        let head: GateHeadRange | undefined;
        const committed: string[] = [];
        try {
          const before = await git.revParse('HEAD');
          const carried = await carryBackFiles({
            to: input.worktree.root,
            dir,
            write: contents.files,
            remove: thisFeaturesTracked.filter(
              (path) => !contents.files.has(path),
            ),
            backup: `${input.composed.root}.carry-back`,
          });
          if (!carried.ok) {
            return {
              ok: false,
              kind: 'unparseable',
              detail: `the ${stageId} gate's output could not be carried back: ${carried.detail}`,
            };
          }
          try {
            if (carried.touched.length > 0) {
              await git.add(carried.touched);
              const touched = new Set(carried.touched);
              // Only what actually differs: a round-2 tester re-writing round
              // 1's tests byte for byte must make no commit, not a failed one.
              const differs = (await git.status()).some(
                (entry) =>
                  touched.has(entry.path) ||
                  (entry.from !== undefined && touched.has(entry.from)),
              );
              if (differs) {
                await git.commit({
                  paths: carried.touched,
                  message:
                    `test(${stageId}): commit what the ${stageId} gate left in ${dir}\n\n` +
                    `ADL ran these against the app and carried them back from the gate's ` +
                    `code-blind workspace (ROLE-09).\n\n` +
                    carried.touched.map((path) => `- ${path}`).join('\n'),
                  identity: ADL_COMMIT_IDENTITY,
                });
                head = { before, after: await git.revParse('HEAD') };
                committed.push(...carried.touched);
              }
            }
          } catch (error) {
            // Before the commit landed: put the worktree and the index back
            // exactly as they were, so the retry does not find this directory
            // dirty and blame the developer for it. Best effort — a failure
            // here is reported alongside the first.
            if (head === undefined) {
              let undoFailure = '';
              try {
                if (carried.touched.length > 0)
                  await git.unstage(carried.touched);
                await carried.undo();
              } catch (undoError) {
                undoFailure = `; undoing it also failed: ${messageOf(undoError)}`;
              }
              return {
                ok: false,
                kind: 'provider_error',
                detail: `could not commit the ${stageId} gate's files in ${dir}: ${messageOf(error)}${undoFailure}`,
              };
            }
            throw error;
          } finally {
            await carried.discard();
          }
        } catch (error) {
          return {
            ok: false,
            kind: 'provider_error',
            detail: `could not carry back the ${stageId} gate's files in ${dir}: ${messageOf(error)}`,
            ...(head === undefined ? {} : { head }),
          };
        }

        // 5.10's constraint, for ADL's commit as for the developer's: only the
        // worker holds the credential, and a green round promotes the change
        // request without pushing anything. So the branch is pushed EVERY time
        // a credential was minted, commit or not — an earlier attempt may have
        // committed and then failed to push, and its retry, finding nothing
        // new to commit, must still put that commit on the remote. A push
        // failure is retryable and is reported rather than swallowed, because
        // a round that went green with the tests only on this machine would
        // put a pull request in front of a human without them.
        if (pushUrl !== undefined) {
          try {
            await git.push(pushUrl, `HEAD:refs/heads/${branch}`);
          } catch (error) {
            return {
              ok: false,
              kind: 'provider_error',
              detail: `the ${stageId} gate's files are committed locally, but pushing the branch failed: ${messageOf(error)}`,
              ...(head === undefined ? {} : { head }),
            };
          }
        }
        return {
          ok: true,
          committed,
          ...(head === undefined ? {} : { head }),
        };
      },
    },
  };
}
