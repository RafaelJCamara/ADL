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
const DEFAULT_AGENT_BLOCK = Object.freeze({
  backend: 'claude-code',
  model: 'default',
});

/**
 * ADL's documented defaults — the third and lowest-priority input to
 * {@link mergeConfig}. Used when a field is absent from both the daemon
 * config and the repo's `adl.yml`.
 *
 * `limits` is derived from {@link LimitsSchema}'s own per-field `.default()`
 * calls rather than restated as a second literal — two independently-edited
 * copies of the same three numbers can silently diverge (a daemon config
 * that omits `limits` entirely reads this object directly, while one that
 * specifies `limits` partially reads `LimitsSchema.partial()`'s own
 * defaults; only a single source of truth guarantees they always agree).
 */
export const DEFAULT_CONFIG = Object.freeze({
  limits: Object.freeze(LimitsSchema.parse({})) satisfies Limits,
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
  backend: z
    .string()
    .min(1)
    .describe('The agent backend id (e.g. "claude-code"). Daemon-only.'),
  model: z
    .string()
    .min(1)
    .describe('The model alias to run this role with. Daemon-only.'),
});

export type DaemonAgentBlock = z.infer<typeof DaemonAgentBlockSchema>;

// ---------------------------------------------------------------------------
// Phase 3 daemon-only fields (03-06): concurrency, API, GC, watched repos
// ---------------------------------------------------------------------------

/**
 * Concurrency caps (D-15). `global` protects the host; `per_repo` is the
 * additive escape hatch that stops one busy repository starving the others.
 * Neither has a repo-side counterpart in `adl.yml` — `mergeConfig` never
 * folds these, they are read straight off the parsed daemon config.
 */
export const ConcurrencySchema = z
  .strictObject({
    global: z
      .int()
      .min(1)
      .default(1)
      .describe(
        'The global cap on features in flight at once. Default: 1, matching the intended ' +
          'v1 behaviour while making scale-up a config change.',
      ),
    per_repo: z
      .int()
      .min(1)
      .optional()
      .describe(
        'An optional per-repository cap, stopping one busy repository starving the others. ' +
          'Default: unset (no per-repo limit beyond the global cap).',
      ),
  })
  .meta({ id: 'Concurrency' });

export type Concurrency = z.infer<typeof ConcurrencySchema>;

/** A TCP port, 1-65535. Local to this module — `adl-yml.ts`'s own `TcpPortSchema` is not exported. */
const ApiTcpPortSchema = z.int().min(1).max(65_535);

/**
 * The HTTP API's bind address, port, and bearer token (D-19). `host`
 * defaults to loopback; a daemon config may widen it, which this schema
 * accepts — the daemon records and warns on a non-loopback value rather
 * than rejecting it, so widening the bind is a deliberate, visible act
 * (T-3-30). `token` is optional here: the daemon mints one with
 * `crypto.randomBytes(32)` on first run when the config carries none
 * (03-06's `daemon-config.ts`), so a fresh install is zero-config.
 */
export const ApiConfigSchema = z
  .strictObject({
    host: z
      .string()
      .min(1)
      .default('127.0.0.1')
      .describe(
        'The address the HTTP API binds. Default: 127.0.0.1 (loopback). A non-loopback ' +
          'value parses but is recorded so the daemon can warn (T-3-30) — the bearer token ' +
          'means a widened bind is not an unauthenticated control plane.',
      ),
    port: ApiTcpPortSchema.default(4173).describe(
      'The port the HTTP API binds. Default: 4173.',
    ),
    token: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The bearer token every non-exempt route requires. No default: the daemon mints ' +
          'one with crypto.randomBytes(32) on first run when absent, so first run is ' +
          'zero-config (D-19).',
      ),
  })
  .meta({ id: 'ApiConfig' });

export type ApiConfig = z.infer<typeof ApiConfigSchema>;

/**
 * The GC sweep's cadence (D-34). Deliberately a separate, much longer
 * interval than the lease reaper's — the two sweeps share a scheduling
 * mechanism (Phase 3's manager owns both timers), not a cadence.
 */
export const GcConfigSchema = z
  .strictObject({
    interval_ms: z
      .int()
      .positive()
      .default(30 * 60 * 1000)
      .describe(
        'How often the worktree/scratch-home GC backstop sweeps, in milliseconds. ' +
          'Default: 1800000 (30 minutes) — orders of magnitude longer than the reaper’s ' +
          'lease-expiry cadence; the two sweeps share a scheduling mechanism, not a cadence.',
      ),
  })
  .meta({ id: 'GcConfig' });

export type GcConfig = z.infer<typeof GcConfigSchema>;

/**
 * One watched repository, declared in the daemon config and reconciled into
 * the `repos` table at startup (D-35). Fields correspond to `ReposTable`'s
 * columns, minus `created_at`/`updated_at` — those are the table's own
 * bookkeeping, not something a config file declares.
 */
export const WatchedRepoSchema = z
  .strictObject({
    id: z.string().min(1).describe('The repository identifier, unique across watched repos.'),
    remote_url: z.string().min(1).describe('The git remote URL to clone/fetch from.'),
    default_branch: z
      .string()
      .min(1)
      .describe('The branch ADL treats as the target for pull requests.'),
    forge: z
      .string()
      .min(1)
      .describe('The forge adapter id (e.g. "github") this repository uses.'),
    features_dir: RepoRelativePathSchema.default('features').describe(
      'The directory, relative to the repo root, ADL watches for feature folders. ' +
        'Default: "features", matching adl.yml’s own default (D-16).',
    ),
  })
  .meta({ id: 'WatchedRepo' });

export type WatchedRepo = z.infer<typeof WatchedRepoSchema>;

/**
 * What a daemon administrator may configure.
 *
 * `limits` here is a **ceiling**, not a value that reaches `EffectiveConfig`
 * directly: a field present here is the maximum the repo may request; a
 * field absent falls back to {@link DEFAULT_CONFIG}'s ceiling. `agents` is
 * the daemon's own backend/model selection per role, optional per role for
 * the same reason — absence falls back to {@link DEFAULT_CONFIG}.
 *
 * The Phase 3 fields below (`lease_ttl_ms` through `repos`) are daemon-only
 * in a different sense: they have **no repo-side counterpart at all** —
 * `adl.yml` never mentions concurrency, API ports, or watched repositories —
 * so `mergeConfig`'s clamp-and-reject fold does not touch them; they are
 * read straight off the parsed daemon config. Do not go looking for the fold
 * that is deliberately absent (03-RESEARCH.md Pitfall 4).
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
    lease_ttl_ms: z
      .int()
      .positive()
      .default(30_000)
      .describe(
        'Lease TTL in milliseconds — how long a worker may go without heartbeating before ' +
          'the reaper reclaims its lease. Default: 30000 (D-02). Must be at least 3x ' +
          'heartbeat_interval_ms.',
      ),
    heartbeat_interval_ms: z
      .int()
      .positive()
      .default(10_000)
      .describe(
        'How often a worker heartbeats over IPC, in milliseconds. Default: 10000 (D-02).',
      ),
    worker_stop_grace_ms: z
      .int()
      .positive()
      .default(10_000)
      .describe(
        'How long a worker gets to react to a soft_stop IPC message before the manager ' +
          'escalates to SIGKILL. Default: 10000 (D-28).',
      ),
    // `.default(Schema.parse({}))`, not `.default({})`: zod v4 requires the
    // default value to match the schema's fully-resolved *output* shape
    // rather than deriving it through the nested schema's own per-field
    // defaults, so the empty-object literal is parsed once here to produce
    // the concrete default instead of duplicating each field's value.
    concurrency: ConcurrencySchema.default(ConcurrencySchema.parse({})),
    api: ApiConfigSchema.default(ApiConfigSchema.parse({})),
    gc: GcConfigSchema.default(GcConfigSchema.parse({})),
    repos: z
      .array(WatchedRepoSchema)
      .default([])
      .describe(
        'Watched repositories, reconciled into the repos table at startup (D-35). ' +
          'Default: [] (no repositories watched).',
      ),
  })
  .meta({ id: 'DaemonConfig' })
  .superRefine((value, ctx) => {
    // D-02: 3x headroom absorbs a GC pause or a slow disk without a false
    // expiry; a config that violates it produces spurious lease expiries
    // that look exactly like worker crashes. One issue naming both fields
    // and both values, matching adl-yml.ts's `.superRefine()` convention.
    if (value.lease_ttl_ms < 3 * value.heartbeat_interval_ms) {
      ctx.addIssue({
        code: 'custom',
        path: ['lease_ttl_ms'],
        message:
          `lease_ttl_ms (${value.lease_ttl_ms}) must be at least 3x ` +
          `heartbeat_interval_ms (${value.heartbeat_interval_ms}): a config that ` +
          'violates the 3x rule produces spurious lease expiries indistinguishable ' +
          'from worker crashes.',
      });
    }
  });

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
  AGENT_ROLES.flatMap((role) => [
    `agents.${role}.backend`,
    `agents.${role}.model`,
  ]),
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
export function mergeConfig(
  defaults: DefaultConfig,
  daemon: DaemonConfig,
  repo: AdlYml,
): MergeResult {
  const clamped: ClampedField[] = [];
  const discarded: DiscardedField[] = [];

  // --- limits: clamp, never merge -------------------------------------
  const limitsCeiling: Limits = {
    max_rounds: daemon.limits.max_rounds ?? defaults.limits.max_rounds,
    budget_usd: daemon.limits.budget_usd ?? defaults.limits.budget_usd,
    repeat_finding_threshold:
      daemon.limits.repeat_finding_threshold ??
      defaults.limits.repeat_finding_threshold,
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
      discarded.push({
        field: `agents.${role}.backend`,
        requested: repoBlock.backend,
      });
    }
    if (repoBlock?.model !== undefined) {
      discarded.push({
        field: `agents.${role}.model`,
        requested: repoBlock.model,
      });
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
