import { GROUP_SYNTAX_REJECTION, type OnSendBack } from './adl-yml.js';
import { isRepoRelativePath } from './path-guard.js';

/**
 * Pipeline resolution (EXEC-07, D-23) — turning `adl.yml`'s `pipeline` entries
 * into an ordered list of resolved stages.
 *
 * This is EXEC-07's entire mechanism, made mechanical rather than asserted:
 * `ARCHITECTURE.md` §2 records that `gating` is one `FeatureState` and the
 * pipeline's position is `features.current_stage_index` — data on a row, not
 * a name in the lifecycle's state set. Adding a harness here adds a
 * configuration entry and, later, a `stage_attempts` row. It does not touch
 * `packages/core/src/state/transition.ts` and does not require a migration —
 * `test/state/exec-07.test.ts` proves both mechanically.
 *
 * This module is pure, matching `context-cascade.ts`'s pattern: the registry
 * — which built-in ids, npm package names, and repo-relative paths are
 * actually available — is supplied by the caller, who owns the I/O (loading
 * an npm package, checking a path exists). `@adl/core` provides the
 * resolution *policy* and the ordered candidate list only.
 */

/** The stage ids ADL ships without any harness configuration (`ARCHITECTURE.md` §3). */
export const BUILT_IN_STAGE_IDS = Object.freeze(['develop', 'review', 'test'] as const);
export type BuiltInStageId = (typeof BUILT_IN_STAGE_IDS)[number];

/** Where a resolved stage's implementation ultimately comes from. */
export type HarnessSource = 'built-in' | 'npm' | 'repo-path';

/** One pipeline entry, resolved to a concrete implementation source. */
export interface ResolvedStage {
  /** Stable, and what verdicts, `stage_attempts`, and coverage rows join on. */
  readonly id: string;
  readonly source: HarnessSource;
  /** Harness-specific configuration, passed through opaquely. */
  readonly with?: Readonly<Record<string, unknown>> | undefined;
  /** Whether a send_back from this stage continues the pipeline or stops it. */
  readonly onSendBack?: OnSendBack | undefined;
}

/**
 * A harness id that could not be resolved: unknown to every tier of the
 * registry, failed the path guard, is a duplicate of an earlier stage's id,
 * or is the parse-and-reject `group:` syntax.
 *
 * Raised at pipeline **resolution** time — which callers run at
 * configuration-validation time, never mid-run (D-23) — so a misspelled
 * harness id is caught before a feature has spent a round on it.
 */
export class HarnessResolutionError extends Error {
  override readonly name = 'HarnessResolutionError';
  readonly harnessId: string | undefined;

  constructor(message: string, harnessId?: string) {
    super(message);
    this.harnessId = harnessId;
    // Keeps `instanceof HarnessResolutionError` working under transpilation,
    // matching the pattern `../errors.js`'s `LoadError` already established.
    Object.setPrototypeOf(this, HarnessResolutionError.prototype);
  }
}

/**
 * What resolution is allowed to consult. Every membership check here is a
 * plain lookup — no filesystem access, no `import()`, no network. The
 * caller precomputes each set from whatever I/O it needed to do (reading
 * `package.json`, listing a directory) before calling {@link resolvePipeline}.
 */
export interface HarnessRegistry {
  readonly builtIns: ReadonlySet<string>;
  readonly npmPackages: ReadonlySet<string>;
  readonly repoPaths: ReadonlySet<string>;
}

/** The registry `resolvePipeline` uses when none is supplied: only the built-ins. */
function defaultRegistry(): HarnessRegistry {
  return {
    builtIns: new Set(BUILT_IN_STAGE_IDS),
    npmPackages: new Set(),
    repoPaths: new Set(),
  };
}

/** A raw pipeline entry, decoupled from `AdlYmlSchema`'s inferred type so this module is independently testable. */
export type PipelineEntryInput =
  | string
  | {
      readonly harness: string;
      readonly with?: Readonly<Record<string, unknown>> | undefined;
      readonly on_send_back?: OnSendBack | undefined;
    }
  | { readonly group: readonly unknown[] };

function isGroupEntry(entry: PipelineEntryInput): entry is { readonly group: readonly unknown[] } {
  return typeof entry === 'object' && entry !== null && 'group' in entry;
}

/**
 * Resolve one harness id against the registry, in D-23's fixed order:
 * built-in, then npm package, then repo-relative path. The path guard runs
 * first and unconditionally — a candidate that fails it is rejected before
 * any tier is even consulted, regardless of what it happens to match.
 */
function resolveHarnessId(id: string, registry: HarnessRegistry): HarnessSource {
  if (!isRepoRelativePath(id)) {
    throw new HarnessResolutionError(
      `harness id "${id}" is not a valid repo-relative path candidate — it must not be ` +
        'absolute, contain a `..` segment, or carry a drive-letter, UNC, or NUL byte.',
      id,
    );
  }

  if (registry.builtIns.has(id)) return 'built-in';
  if (registry.npmPackages.has(id)) return 'npm';
  if (registry.repoPaths.has(id)) return 'repo-path';

  throw new HarnessResolutionError(
    `unknown harness id "${id}" — not a built-in stage, an npm package, or a repo-relative ` +
      'path known to the registry.',
    id,
  );
}

/**
 * Resolve every pipeline entry to a {@link ResolvedStage}, in order.
 *
 * Pure and total in the sense that matters here: it either returns a fully
 * resolved list or throws a {@link HarnessResolutionError} naming exactly
 * the entry that could not be resolved — never a partial result, and never
 * a resolution that runs I/O of its own.
 *
 * @throws {HarnessResolutionError} for an unknown id, a `group:` entry, or
 *   two entries resolving to the same stage id.
 */
export function resolvePipeline(
  entries: readonly PipelineEntryInput[],
  registry: HarnessRegistry = defaultRegistry(),
): readonly ResolvedStage[] {
  const resolved: ResolvedStage[] = [];
  const seenIds = new Set<string>();

  for (const entry of entries) {
    if (isGroupEntry(entry)) {
      throw new HarnessResolutionError(GROUP_SYNTAX_REJECTION);
    }

    const id = typeof entry === 'string' ? entry : entry.harness;
    const source = resolveHarnessId(id, registry);

    if (seenIds.has(id)) {
      throw new HarnessResolutionError(
        `duplicate stage id "${id}" — two pipeline entries resolved to the same id, and the ` +
          'stage id is what verdicts, stage_attempts, and coverage rows join on.',
        id,
      );
    }
    seenIds.add(id);

    resolved.push({
      id,
      source,
      ...(typeof entry !== 'string' && entry.with !== undefined ? { with: entry.with } : {}),
      ...(typeof entry !== 'string' && entry.on_send_back !== undefined
        ? { onSendBack: entry.on_send_back }
        : {}),
    });
  }

  return resolved;
}
