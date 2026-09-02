/**
 * `@adl/core/config` — the `adl.yml` contract.
 *
 * Everything here is pure. Schemas validate strings and plain values; nothing
 * in this directory reads a file, spawns a process, or looks at the
 * environment. Reading `adl.yml` is the caller's job, and the purity is
 * enforced by lint rather than by convention.
 */

export { parseYamlDocument } from './yaml-parse.js';
export {
  DurationSchema,
  MAX_DURATION_MS,
  parseDuration,
  type Duration,
} from './duration.js';
export {
  isRepoRelativePath,
  RepoRelativePathSchema,
  type RepoRelativePath,
} from './path-guard.js';
export {
  ADL_YML_VERSION,
  AdlYmlSchema,
  AgentsConfigSchema,
  CommandSpecSchema,
  ContextConfigSchema,
  GROUP_SYNTAX_REJECTION,
  LimitsSchema,
  OnOverflowSchema,
  OnSendBackSchema,
  parseAdlYml,
  PipelineEntrySchema,
  ReadyProbeSchema,
  StartCommandSpecSchema,
  type AdlYml,
  type AgentsConfig,
  type CommandSpec,
  type ContextConfig,
  type Limits,
  type OnOverflow,
  type OnSendBack,
  type PipelineEntry,
  type ReadyProbe,
  type StartCommandSpec,
} from './adl-yml.js';
export {
  AGENT_ROLES,
  ApiConfigSchema,
  BACKEND_DEFAULT_MODEL,
  ConcurrencySchema,
  DAEMON_ONLY_FIELDS,
  DEFAULT_CONFIG,
  DaemonConfigSchema,
  EffectiveConfigSchema,
  GcConfigSchema,
  GithubAppConfigSchema,
  mergeConfig,
  PollConfigSchema,
  WatchedRepoSchema,
  type AgentRole,
  type ApiConfig,
  type ClampedField,
  type Concurrency,
  type DaemonAgentBlock,
  type DaemonConfig,
  type DefaultConfig,
  type DiscardedField,
  type EffectiveConfig,
  type GcConfig,
  type GithubAppConfig,
  type PollConfig,
  type MergeReport,
  type MergeResult,
  type ResolvedAgentBlock,
  type WatchedRepo,
} from './effective-config.js';
export {
  ADL_VARIABLES,
  interpolate,
  type AdlVariableName,
} from './interpolate.js';
export {
  CONTEXT_FILE_CASCADE,
  pickFirstPresent,
  resolveContextFiles,
  type ContextCascadeFile,
  type ContextFilesConfig,
} from './context-cascade.js';
export {
  BUILT_IN_STAGE_IDS,
  HarnessResolutionError,
  resolvePipeline,
  type BuiltInStageId,
  type HarnessRegistry,
  type HarnessSource,
  type PipelineEntryInput,
  type ResolvedStage,
} from './pipeline.js';
