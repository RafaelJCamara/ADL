import * as z from 'zod';

import {
  ADL_YML_VERSION,
  CommandSpecSchema,
  ContextConfigSchema,
  LimitsSchema,
  PipelineEntrySchema,
  StartCommandSpecSchema,
  type AdlYml,
  type Limits,
} from './adl-yml.js';
import { RepoRelativePathSchema } from './path-guard.js';

/**
 * `EffectiveConfig` — the three-way fold of defaults, daemon configuration,
 * and the repository's `adl.yml` into the one object ADL actually runs
 * under (D-22).
 *
 * ## Why this is a security boundary, not a convenience merge
 *
 * `adl.yml` is untrusted input: anyone who can push a file into a watched
 * repository controls it (01-CONTEXT.md § D-22). Two rules make this module
 * a trust boundary rather than a config-parsing convenience:
 *
 * 1. **Clamp, never merge, for `limits`.** Every field under `limits` may
 *    only be *lowered* from the daemon's ceiling. This is implemented as an
 *    explicit per-field clamp driven by {@link LIMITS_FIELDS} rather than a
 *    generic deep merge with a special case — a generic merge is exactly
 *    where a newly added limit field would arrive unclamped. A budget the
 *    watched repository can raise is not a budget.
 * 2. **Reject, never clamp, for `DAEMON_ONLY_FIELDS`.** Backend selection,
 *    model selection, and every credential-selecting field are daemon-only.
 *    A repo-supplied value for one of these is discarded outright and
 *    reported, never merged in any form. A backend the watched repository
 *    can choose is a credential-selection primitive under a trust boundary
 *    that already grants code execution on the ADL host.
 *
 * ## Snapshotting
 *
 * The result is deeply frozen before it is returned. `ARCHITECTURE.md` §2
 * records that the effective configuration is snapshotted into the feature
 * row at lease time — editing `adl.yml` mid-flight must not reach a running
 * feature's pipeline. A frozen object turns "we agreed not to mutate this"
 * into a property a caller cannot violate by accident.
 */

/** The three agent roles `adl.yml` and daemon configuration both name. */
export const AGENT_ROLES = ['developer', 'reviewer', 'tester'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** ADL's own baked-in fallback backend and model, used when the daemon names none. */
const DEFAULT_AGENT_BLOCK = Object.freeze({ backend: 'claude-code', model: 'default' });

/**
 * ADL's documented defaults — the third and lowest-priority input to
 * {@link mergeConfig}. Used when a field is absent from both the daemon
 * config and the repo's `adl.yml`.
 */
export const DEFAULT_CONFIG = Object.freeze({
  limits: Object.freeze({
    max_rounds: 6,
    budget_usd: 15,
    repeat_finding_threshold: 2,
  }) satisfies Limits,
  agents: Object.freeze({
    developer: DEFAULT_AGENT_BLOCK,
    reviewer: DEFAULT_AGENT_BLOCK,
    tester: DEFAULT_AGENT_BLOCK,
  }),
});

export type DefaultConfig = typeof DEFAULT_CONFIG;

// ---------------------------------------------------------------------------
// Daemon configuration
// ---------------------------------------------------------------------------

/**
 * The shape a daemon administrator may configure for one agent role.
 *
 * Unlike the repo's `AgentBlockSchema`, `prompt_template` is intentionally
 * absent here — the daemon may also want to override it, but D-22's
 * daemon-only claim is about backend and credential selection specifically;
 * `prompt_template` flows from the repo (see {@link mergeConfig}).
 */
const DaemonAgentBlockSchema = z.strictObject({
  backend: z.string().min(1).describe('The agent backend id (e.g. "claude-code"). Daemon-only.'),
  model: z.string().min(1).describe('The model alias to run this role with. Daemon-only.'),
});

export type DaemonAgentBlock = z.infer<typeof DaemonAgentBlockSchema>;

/**
 * What a daemon administrator may configure.
 *
 * `limits` here is a **ceiling**, not a value that reaches `EffectiveConfig`
 * directly: a field present here is the maximum the repo may request; a
 * field absent falls back to {@link DEFAULT_CONFIG}'s ceiling. `agents` is
 * the daemon's own backend/model selection per role, optional per role for
 * the same reason — absence falls back to {@link DEFAULT_CONFIG}.
 */
export const DaemonConfigSchema = z
  .strictObject({
    limits: LimitsSchema.partial().default({}),
    agents: z
      .strictObject({
        developer: DaemonAgentBlockSchema.optional(),
        reviewer: DaemonAgentBlockSchema.optional(),
        tester: DaemonAgentBlockSchema.optional(),
      })
      .default({}),
  })
  .meta({ id: 'DaemonConfig' });

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

// ---------------------------------------------------------------------------
// The resolved config
// ---------------------------------------------------------------------------

/** An agent role's fully resolved configuration: backend and model always present. */
const ResolvedAgentBlockSchema = z.strictObject({
  backend: z.string().min(1),
  model: z.string().min(1),
  prompt_template: RepoRelativePathSchema.optional(),
});

export type ResolvedAgentBlock = z.infer<typeof ResolvedAgentBlockSchema>;

const CommandsSchema = z.strictObject({
  build: CommandSpecSchema,
  start: StartCommandSpecSchema,
  test: CommandSpecSchema,
  teardown: CommandSpecSchema,
});

/**
 * The configuration ADL actually runs a feature under — the output of
 * {@link mergeConfig}. Every field is fully resolved: no further defaulting
 * or clamping is meaningful once a value validates against this schema.
 */
export const EffectiveConfigSchema = z
  .strictObject({
    version: z.literal(ADL_YML_VERSION),
    features_dir: RepoRelativePathSchema,
    commands: CommandsSchema,
    context: ContextConfigSchema,
    pipeline: z.array(PipelineEntrySchema).min(1),
    limits: LimitsSchema,
    agents: z.strictObject({
      developer: ResolvedAgentBlockSchema,
      reviewer: ResolvedAgentBlockSchema,
      tester: ResolvedAgentBlockSchema,
    }),
  })
  .meta({ id: 'EffectiveConfig' });

export type EffectiveConfig = z.infer<typeof EffectiveConfigSchema>;

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

/** The `limits` fields, driving the clamp explicitly rather than by a generic deep merge. */
const LIMITS_FIELDS = [
  'max_rounds',
  'budget_usd',
  'repeat_finding_threshold',
] as const satisfies readonly (keyof Limits)[];

/**
 * Every field a repository's `adl.yml` may never influence at all —
 * backend selection, model selection, and (by extension) every
 * credential-selecting field. Reported, not silently absorbed, when a repo
 * supplies one (D-22).
 */
export const DAEMON_ONLY_FIELDS: readonly string[] = Object.freeze(
  AGENT_ROLES.flatMap((role) => [`agents.${role}.backend`, `agents.${role}.model`]),
);

/** One `limits` field the repo tried to raise above the daemon's ceiling. */
export interface ClampedField {
  readonly field: string;
  readonly requested: number;
  readonly ceiling: number;
}

/** One daemon-only field the repo attempted to set, and what it tried to set it to. */
export interface DiscardedField {
  readonly field: string;
  readonly requested: string;
}

/** What the daemon has something to log, and the pull request has something to show. */
export interface MergeReport {
  readonly clamped: readonly ClampedField[];
  readonly discarded: readonly DiscardedField[];
}

export interface MergeResult {
  readonly config: EffectiveConfig;
  readonly report: MergeReport;
}

/** Recursively freezes an object or array in place, and returns it. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Fold `defaults`, `daemon`, and `repo` — in that order — into one frozen
 * {@link EffectiveConfig}.
 *
 * Pure: the same three inputs always produce deeply equal results, and
 * neither `daemon` nor `repo` is mutated. Every field under `limits` is
 * clamped down (never up) to the daemon's ceiling; every field named in
 * {@link DAEMON_ONLY_FIELDS} is taken from the daemon and any repo-supplied
 * value is discarded and reported.
 */
export function mergeConfig(defaults: DefaultConfig, daemon: DaemonConfig, repo: AdlYml): MergeResult {
  const clamped: ClampedField[] = [];
  const discarded: DiscardedField[] = [];

  // --- limits: clamp, never merge -------------------------------------
  const limitsCeiling: Limits = {
    max_rounds: daemon.limits.max_rounds ?? defaults.limits.max_rounds,
    budget_usd: daemon.limits.budget_usd ?? defaults.limits.budget_usd,
    repeat_finding_threshold:
      daemon.limits.repeat_finding_threshold ?? defaults.limits.repeat_finding_threshold,
  };

  const resolvedLimits = {} as Record<keyof Limits, number>;
  for (const field of LIMITS_FIELDS) {
    const ceiling = limitsCeiling[field];
    const requested = repo.limits[field];
    if (requested > ceiling) {
      clamped.push({ field: `limits.${field}`, requested, ceiling });
      resolvedLimits[field] = ceiling;
    } else {
      resolvedLimits[field] = requested;
    }
  }

  // --- agents: reject repo-supplied backend/model, never clamp --------
  const resolvedAgents = {} as Record<AgentRole, ResolvedAgentBlock>;
  for (const role of AGENT_ROLES) {
    const daemonBlock = daemon.agents[role] ?? defaults.agents[role];
    const repoBlock = repo.agents[role];

    if (repoBlock?.backend !== undefined) {
      discarded.push({ field: `agents.${role}.backend`, requested: repoBlock.backend });
    }
    if (repoBlock?.model !== undefined) {
      discarded.push({ field: `agents.${role}.model`, requested: repoBlock.model });
    }

    resolvedAgents[role] = {
      backend: daemonBlock.backend,
      model: daemonBlock.model,
      ...(repoBlock?.prompt_template !== undefined
        ? { prompt_template: repoBlock.prompt_template }
        : {}),
    };
  }

  // --- everything else: the repo's already-resolved value, verbatim --
  const config: EffectiveConfig = {
    version: repo.version,
    features_dir: repo.features_dir,
    commands: repo.commands,
    context: repo.context,
    pipeline: repo.pipeline,
    limits: resolvedLimits as Limits,
    agents: resolvedAgents,
  };

  return {
    config: deepFreeze(config),
    report: { clamped, discarded },
  };
}
