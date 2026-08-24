import { parseAdlYml, type AdlYml } from '@adl/core/config';
import { LoadError } from '@adl/core/spec';

/**
 * The production `resolveAdlYml` (M05 step 5.4) — M03 shipped
 * `DispatcherDeps.resolveAdlYml`/`StartDaemonOptions.resolveAdlYml` as a
 * **required, synchronous** injected dependency (`(feature) => AdlYml`, no
 * `Promise`, no result wrapper) with no real implementation, matching the
 * same "required, explicit, no default" shape `boot/startup.ts`'s own
 * docblock names as the precedent to follow. That signature is kept exactly
 * as M03 left it — the real I/O happens here, once, before the synchronous
 * closure `daemon.ts` hands to the dispatcher ever exists.
 *
 * `adl.yml` lives at the watched repository's root and is read through
 * `Workspace.read()` on a host-rooted workspace (`@adl/workspace`'s
 * `hostGitWorkspace`) — a plain working-tree read under the D-02 containment
 * guard, never a git-ref lookup. `git/host-backend.ts`'s own `read()`
 * docblock reserved exactly this call since M02: "The manager will read
 * `adl.yml` and feature specs through this backend." That is different from
 * 5.1's scanner, which deliberately reads the committed tree via `git
 * ls-tree` rather than a working copy — the scanner's target is a FEATURE's
 * worktree, which an agent can leave dirty; this target is `mainRepo`
 * itself, which no agent ever touches (workers get their own linked
 * worktrees) and which nothing but the operator's own `git pull` can change.
 *
 * v1 scope: exactly one physical `mainRepo` exists per daemon process
 * (`StartDaemonOptions.mainRepo`, singular, matching `dispatchOnce`'s and
 * `gc-schedule.ts`'s own assumption), so this resolves ONE `AdlYml` and
 * `daemon.ts` returns it for every feature regardless of `repo_id`. Real
 * multi-repo support needs a per-repo `mainRepo` mapping that does not exist
 * anywhere else in the dispatch path either.
 */

/** Where `adl.yml` lives, relative to the repository root. Not configurable — `features_dir` is a key *inside* this file, not a locator for it. */
export const ADL_YML_PATH = 'adl.yml';

/** Why {@link resolveProductionAdlYml} could not produce an `AdlYml` to run under. */
export type AdlYmlResolutionRefusal =
  | {
      readonly reason: 'unreadable';
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly reason: 'invalid';
      readonly path: string;
      readonly message: string;
    };

export interface AdlYmlResolved {
  readonly kind: 'resolved';
  readonly config: AdlYml;
}

export interface AdlYmlRefused {
  readonly kind: 'refused';
  readonly refusal: AdlYmlResolutionRefusal;
}

export type AdlYmlResolutionOutcome = AdlYmlResolved | AdlYmlRefused;

export interface ResolveProductionAdlYmlDeps {
  /**
   * Reads a repo-relative path from the repository ADL is running against.
   * The real caller (`daemon.ts`) binds this to a host-rooted
   * `Workspace.read`; a test binds it to whatever it wants without standing
   * one up.
   */
  readonly readFile: (path: string) => Promise<string>;
  /** Defaults to {@link ADL_YML_PATH}. A parameter only so a test can point at a fixture without renaming it. */
  readonly path?: string;
}

/**
 * Read and parse `adl.yml` off the repository ADL is running against.
 *
 * Never throws — matching every other startup gate in this package
 * (`runStartupGate`, `runBackendPreflight`): a read failure (missing file,
 * unreadable path) and a parse/validation failure (`parseAdlYml`'s own
 * `LoadError`) are both real, ordinary outcomes a caller classifies rather
 * than catches.
 */
export async function resolveProductionAdlYml(
  deps: ResolveProductionAdlYmlDeps,
): Promise<AdlYmlResolutionOutcome> {
  const path = deps.path ?? ADL_YML_PATH;

  let source: string;
  try {
    source = await deps.readFile(path);
  } catch (error) {
    return {
      kind: 'refused',
      refusal: {
        reason: 'unreadable',
        path,
        message:
          `could not read ${path} from the repository ADL is running against: ` +
          (error instanceof Error ? error.message : String(error)),
      },
    };
  }

  const parsed = parseAdlYml(source);
  if (parsed instanceof LoadError) {
    return {
      kind: 'refused',
      refusal: { reason: 'invalid', path, message: parsed.message },
    };
  }

  return { kind: 'resolved', config: parsed };
}

/**
 * Thrown by `startDaemon` when the production gate refuses — mirrors
 * `SchemaVersionRefusalError` (`boot/startup.ts`) and `BackendUnavailableError`
 * (`boot/backend-preflight.ts`) exactly: a named, thrown error the caller
 * turns a discriminated refusal into, so every startup gate in this package
 * fails the same shape of way.
 */
export class AdlYmlUnavailableError extends Error {
  readonly refusal: AdlYmlResolutionRefusal;

  constructor(refusal: AdlYmlResolutionRefusal) {
    super(refusal.message);
    this.name = 'AdlYmlUnavailableError';
    this.refusal = refusal;
  }
}
