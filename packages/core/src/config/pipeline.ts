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
export const BUILT_IN_STAGE_IDS = Object.freeze([
  'develop',
  'review',
  'test',
] as const);
export type BuiltInStageId = (typeof BUILT_IN_STAGE_IDS)[number];

/**
 * Where a resolved stage's implementation ultimately comes from.
 *
 * `built-in` / `npm` / `repo-path` are D-23's three tiers, and all three answer
 * the same question: *where is the module?* `command` (HARN-02, M07 step 7.3)
 * answers it differently — **there is no module**. A plain-command gate is a
 * program named in the pipeline entry's own `with.command` block, so it needs
 * no registry entry, no loader, and no resolution tier. That is what lets a
 * third party add a gate today, before M13's harness loader exists: a gate that
 * is just a program is the smallest possible extension point, and it is the one
 * `.planning/research/ARCHITECTURE.md` §3 describes when it says a command gate
 * "validates its output against the published JSON Schema instead of importing
 * anything".
 */
export type HarnessSource = 'built-in' | 'npm' | 'repo-path' | 'command';

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

function isGroupEntry(
  entry: PipelineEntryInput,
): entry is { readonly group: readonly unknown[] } {
  return typeof entry === 'object' && entry !== null && 'group' in entry;
}

/**
 * Does this entry's `with:` block declare its own program (HARN-02, M07 step
 * 7.3)?
 *
 * **Structural recognition only, never validation.** This decides which
 * *source* an entry resolves to; whether the block is a well-formed command is
 * the gate's own question, answered where the gate runs, with the gate's own
 * schema, and reported as a `StageError` — because a misconfigured gate did not
 * judge (CORE-06). Validating here instead would put every gate's private
 * configuration schema into `@adl/core`, which is the opposite of what `with`
 * being opaque is for.
 *
 * The bar is deliberately low and deliberately explicit: a `command` key whose
 * value is an object. An entry that *meant* to name a built-in and typo'd its
 * `with:` block still fails at the registry, where the error names the id.
 */
function declaresCommand(entry: PipelineEntryInput): boolean {
  if (typeof entry === 'string' || isGroupEntry(entry)) return false;
  const block = entry.with;
  if (block === undefined) return false;
  const command = block['command'];
  return typeof command === 'object' && command !== null;
}

/**
 * Resolve one harness id against the registry, in D-23's fixed order:
 * built-in, then npm package, then repo-relative path. The path guard runs
 * first and unconditionally — a candidate that fails it is rejected before
 * any tier is even consulted, regardless of what it happens to match.
 */
function resolveHarnessId(
  id: string,
  registry: HarnessRegistry,
): HarnessSource {
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
    // A command gate carries its own implementation, so it skips the registry
    // entirely (HARN-02, M07 step 7.3) — but NOT the path guard, which
    // `resolveHarnessId` runs first and unconditionally. The id still becomes a
    // stage id that verdicts, `stage_attempts` and coverage rows join on, and
    // one that could be read as a filesystem path is exactly as dangerous here
    // as anywhere else.
    let source: HarnessSource;
    if (declaresCommand(entry)) {
      if (!isRepoRelativePath(id)) {
        throw new HarnessResolutionError(
          `harness id "${id}" is not a valid repo-relative path candidate — it must not be ` +
            'absolute, contain a `..` segment, or carry a drive-letter, UNC, or NUL byte.',
          id,
        );
      }
      source = 'command';
    } else {
      source = resolveHarnessId(id, registry);
    }

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
      ...(typeof entry !== 'string' && entry.with !== undefined
        ? { with: entry.with }
        : {}),
      ...(typeof entry !== 'string' && entry.on_send_back !== undefined
        ? { onSendBack: entry.on_send_back }
        : {}),
    });
  }

  return resolved;
}
