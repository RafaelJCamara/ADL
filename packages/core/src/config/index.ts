/**
 * `@adl/core/config` — the `adl.yml` contract.
 *
 * Everything here is pure. Schemas validate strings and plain values; nothing
 * in this directory reads a file, spawns a process, or looks at the
 * environment. Reading `adl.yml` is the caller's job, and the purity is
 * enforced by lint rather than by convention.
 */

export { parseYamlDocument } from './yaml-parse.js';
export { DurationSchema, MAX_DURATION_MS, parseDuration, type Duration } from './duration.js';
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
