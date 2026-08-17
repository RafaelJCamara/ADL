import * as z from 'zod';

import { LoadError } from '../errors.js';
import { DurationSchema } from './duration.js';
import { RepoRelativePathSchema } from './path-guard.js';
import { parseYamlDocument } from './yaml-parse.js';

/**
 * `adl.yml` — the maintainer's side of the bargain (SPEC-03, SPEC-04).
 *
 * `.planning/REQUIREMENTS.md` § Out of Scope rules out auto-detecting build
 * and run commands: it is non-deterministic exactly where it matters most, so
 * this file is explicit by design. D-22 records that its content is untrusted
 * input under the stated trust boundary — anyone who can push a file into a
 * watched repository controls it — which makes this schema a security
 * boundary as much as an ergonomics one, not merely a config-parsing
 * convenience.
 *
 * Every object below is a `z.strictObject`, so a typo'd key is an
 * `unrecognized_keys` issue naming the offender rather than a setting the
 * maintainer believes is in effect and is not — and a permissive object would
 * also carry a prototype-polluting key through (01-RESEARCH.md § Security
 * Domain). Every constraint that could conceivably be published as JSON
 * Schema is expressed structurally (`z.literal`, `.regex()`, `.min()`,
 * `.max()`), per Pattern 1 — the one exception is the `ready` ⇒
 * `ready_timeout` cross-field rule below, which is safe precisely *because*
 * `adl.yml` is not published as JSON Schema.
 *
 * Every field below carries a `.describe()` string doing double duty as its
 * own reference documentation — what it does, its default, and where its
 * ceiling comes from, when it has one. That is a deliberate substitute for a
 * separate markdown reference: a description travels with the field, appears
 * in any generated output, and cannot be edited in one place while the schema
 * changes in another.
 *
 * ## Four promises this schema keeps
 *
 * An adopter relies on these, and a later phase must not break any of them
 * without deliberately incrementing {@link ADL_YML_VERSION}.
 *
 * 1. **`version: 1` is narrow.** Within a major version, ADL only adds
 *    optional keys; a removed or renamed key requires a new version number
 *    (01-RESEARCH.md § Open Questions 2).
 * 2. **Interpolation is a closed set of ADL-provided variables, never general
 *    shell expansion.** The variables are `ADL_PORT`, `ADL_FEATURE_ID`,
 *    `ADL_ROUND`, and `ADL_VERDICT_FILE`, substituted only where this schema
 *    documents an interpolatable string — currently the `http` readiness
 *    probe's `url` field. An unknown variable name is a **validation error**,
 *    never an empty-string substitution (D-21, 01-RESEARCH.md § Pitfall 10).
 *    Plan 01-08 implements the substitution; this promise is the contract it
 *    implements against.
 * 3. **`limits` may only be lowered from the daemon's ceiling, and backend
 *    and credential selection is daemon-only (D-22).** A budget the watched
 *    repository can raise is not a budget, and a backend it can choose is a
 *    credential-selection primitive. This schema validates the repo-supplied
 *    value's own shape; the daemon-side clamp is 01-08's `EffectiveConfig`.
 * 4. **Commands are explicit by design and are never auto-detected**
 *    (`.planning/REQUIREMENTS.md` § Out of Scope) — auto-detection is
 *    non-deterministic exactly where it matters most, so `commands` has no
 *    default and every `adl.yml` must declare all four lifecycle commands.
 *
 * ## A complete `adl.yml`
 *
 * Kept honest by execution: `adl-yml.test.ts` extracts this block verbatim
 * and parses it through {@link parseAdlYml}. A documentation example that has
 * never been validated is a bug report waiting to be filed.
 *
 * ```yaml
 * version: 1
 * features_dir: features
 *
 * commands:
 *   build:
 *     argv: [npm, ci]
 *     timeout: 10m
 *   start:
 *     argv: [npm, run, dev]
 *     timeout: 2m
 *     ready:
 *       kind: http
 *       url: "http://127.0.0.1:${ADL_PORT}/health"
 *       expect: 200
 *     ready_timeout: 30s
 *   test:
 *     argv: [npm, test]
 *     timeout: 15m
 *   teardown:
 *     argv: [docker, compose, down]
 *
 * context:
 *   files: [README.md, docs/architecture.md]
 *   max_bytes: 200000
 *   on_overflow: truncate
 *
 * pipeline:
 *   - develop
 *   - review
 *   - harness: security
 *   - test
 *
 * limits:
 *   max_rounds: 6
 *   budget_usd: 15
 *   repeat_finding_threshold: 2
 *
 * agents:
 *   developer:
 *     backend: claude-code
 *     model: default
 *   reviewer:
 *     backend: claude-code
 *     model: default
 *   tester:
 *     backend: claude-code
 *     model: default
 * ```
 */

/**
 * The literal, current `adl.yml` schema version.
 *
 * The promise this validates is narrow: **within a major version, ADL only
 * adds optional keys; a removed or renamed key requires a new version
 * number.** A file declaring `version: 2` therefore fails loudly rather than
 * being silently accepted and misread against the wrong shape.
 */
export const ADL_YML_VERSION = 1;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** An environment-variable name: letters, digits, and underscores, not starting with a digit. */
const EnvVarNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/**
 * A lifecycle command: `argv` and nothing but `argv` is required.
 *
 * `argv` is a non-empty array of non-empty strings — never a shell string.
 * No shell means no quoting bugs and no injection surface from repo config,
 * and it keeps the shape compatible with the `ExecSpec` the workspace layer
 * runs in Phase 2 (ARCHITECTURE.md §5, threat T-1-01).
 */
export const CommandSpecSchema = z.strictObject({
  argv: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'The command as an argv array — never a shell string. No default: required, and ' +
        'must have at least one non-empty element.',
    ),
  cwd: RepoRelativePathSchema.optional().describe(
    'Working directory, relative to the repo root. Default: the repo root.',
  ),
  env: z
    .record(EnvVarNameSchema, z.string())
    .optional()
    .describe('Extra environment variables for this command. Default: none.'),
  timeout: DurationSchema.optional().describe(
    'How long this command may run before ADL kills it, as a duration string (e.g. "10m"). ' +
      'Default: no timeout enforced by this schema; ceiling is 24h (MAX_DURATION_MS).',
  ),
});

export type CommandSpec = z.infer<typeof CommandSpecSchema>;

// ---------------------------------------------------------------------------
// Readiness probes (D-20)
// ---------------------------------------------------------------------------

/**
 * A URL that may contain ADL's restricted `${VAR}` interpolation (D-21) — most
 * commonly `${ADL_PORT}` in the `start` command's own probe. Interpolation
 * itself is 01-08's job; this schema only validates that the string has the
 * shape of an HTTP(S) URL. `z.url()` is deliberately not used here: it
 * rejects `${ADL_PORT}` as an invalid host, which is exactly the value every
 * realistic fixture needs to write.
 */
const InterpolatableUrlSchema = z.string().regex(/^https?:\/\/[^\s\0"'<>\\^`|]+$/);

/** HTTP status codes are 100–599. */
const HttpStatusSchema = z.int().min(100).max(599);

/** TCP ports are 1–65535; port 0 ("any free port") is not a probe target. */
const TcpPortSchema = z.int().min(1).max(65_535);

const HttpReadyProbeSchema = z
  .strictObject({
    kind: z.literal('http'),
    url: InterpolatableUrlSchema.describe(
      'The URL to poll until it responds. May reference ${ADL_PORT} — the one place this ' +
        'schema documents ADL-provided interpolation (promise 2).',
    ),
    expect: HttpStatusSchema.optional().describe(
      'The HTTP status code that counts as ready. Default: any response counts as ready. ' +
        'Bounded 100–599 (valid HTTP status codes).',
    ),
  })
  .meta({ id: 'HttpReadyProbe' });

const TcpReadyProbeSchema = z
  .strictObject({
    kind: z.literal('tcp'),
    port: TcpPortSchema.describe('The port to poll until it accepts a connection. Bounded 1–65535.'),
  })
  .meta({ id: 'TcpReadyProbe' });

const LogReadyProbeSchema = z
  .strictObject({
    kind: z.literal('log'),
    pattern: z.string().min(1).describe('A literal substring to wait for in the started process\'s output.'),
  })
  .meta({ id: 'LogReadyProbe' });

/**
 * The universal escape hatch (D-20): its own argv, run through
 * `workspace.exec` per WORK-02 once Phase 2 lands it. This is what covers a
 * database (`pg_isready`) or a queue worker with no HTTP surface at all —
 * ROLE-07 promises ADL owns the lifecycle for any app, not only HTTP ones.
 */
const ExecReadyProbeSchema = z
  .strictObject({
    kind: z.literal('exec'),
    argv: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        'A command to run repeatedly until it exits zero — the universal escape hatch ' +
          '(e.g. pg_isready) for an app with no HTTP or TCP surface.',
      ),
  })
  .meta({ id: 'ExecReadyProbe' });

/**
 * A readiness signal, one of four kinds. New kinds are additive, which is why
 * this is a discriminated union rather than a string field with a lookup
 * table — an unrecognised `kind` fails with `invalid_union` naming all four
 * that exist.
 */
export const ReadyProbeSchema = z
  .discriminatedUnion('kind', [
    HttpReadyProbeSchema,
    TcpReadyProbeSchema,
    LogReadyProbeSchema,
    ExecReadyProbeSchema,
  ])
  .meta({ id: 'ReadyProbe' });

export type ReadyProbe = z.infer<typeof ReadyProbeSchema>;

/**
 * The single message every rejected `group:` entry carries — parse-and-reject
 * per D-23, so the pipeline file format does not have to change when parallel
 * stages land. `v2` unlocks it once `mutates` and `Workspace.snapshot()`
 * exist (ARCHITECTURE.md §3).
 */
const GROUP_SYNTAX_REJECTION =
  'Parallel stage groups ("group:") are a recognised future capability and are not yet supported. ' +
  'List each stage separately until v2 parallel pipelines ship.';

/**
 * `start` is every other command plus an optional readiness contract.
 *
 * `ready` and `ready_timeout` are **both-or-neither** (Assumption A7): SPEC-04
 * says "an explicit readiness signal *and* timeout", which reads as a pair,
 * not two independently optional fields. This is a `.superRefine()` rather
 * than a structural constraint — the one place in this file that is safe,
 * because `adl.yml` is not published as JSON Schema (unlike the verdict
 * layer), so the emission hazard Pattern 1 warns about does not apply here.
 */
export const StartCommandSpecSchema = CommandSpecSchema.extend({
  ready: ReadyProbeSchema.optional().describe(
    'A readiness probe — one of four kinds. Default: no probe (the tester races the server; ' +
      'prefer declaring one). Required together with ready_timeout: both or neither.',
  ),
  ready_timeout: DurationSchema.optional().describe(
    'How long to wait for ready before giving up, as a duration string. Required together ' +
      'with ready: both or neither. Ceiling is 24h (MAX_DURATION_MS).',
  ),
}).superRefine((value, ctx) => {
  if (value.ready !== undefined && value.ready_timeout === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['ready_timeout'],
      message: 'ready and ready_timeout are required together: ready_timeout is missing.',
    });
  }
  if (value.ready === undefined && value.ready_timeout !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['ready'],
      message: 'ready and ready_timeout are required together: ready is missing.',
    });
  }
});

export type StartCommandSpec = z.infer<typeof StartCommandSpecSchema>;

const CommandsSchema = z.strictObject({
  build: CommandSpecSchema,
  start: StartCommandSpecSchema,
  test: CommandSpecSchema,
  teardown: CommandSpecSchema,
});

// ---------------------------------------------------------------------------
// Context (SPEC-05)
// ---------------------------------------------------------------------------

/** Overflow policy when the assembled context exceeds `max_bytes`. */
export const OnOverflowSchema = z.enum(['truncate', 'error']);
export type OnOverflow = z.infer<typeof OnOverflowSchema>;

/**
 * Which repo files feed the agent prompts, and how big that can get.
 *
 * Phase 1 defines the field and its validation only; Phase 4's PromptBuilder
 * implements head-and-tail truncation, because Phase 1 reads no files and so
 * cannot truncate anything (01-RESEARCH.md § Open Questions 3). Making
 * `'error'` an available option — rather than always truncating — matters:
 * silently truncating an oversized context file and proceeding is exactly the
 * quiet degradation this project is designed against.
 *
 * `files` deliberately carries **no default value** — SPEC-05's four-file
 * context cascade (`AGENTS.md` → `CLAUDE.md` →
 * `.github/copilot-instructions.md` → `README.md`, plan 01-08's
 * `context-cascade.ts`) is itself the fallback for "nothing declared", and a
 * schema-level default of `['README.md']` would make an undeclared
 * `context.files` indistinguishable from one explicitly set to
 * `['README.md']` — silently defeating the cascade before 01-08 ever sees
 * the value. `resolveContextFiles` applies the cascade exactly when this
 * field is `undefined`.
 */
export const ContextConfigSchema = z.strictObject({
  files: z
    .array(RepoRelativePathSchema)
    .optional()
    .describe(
      'Repo-relative paths fed into every agent prompt. No default here: when absent, ' +
        "resolveContextFiles (01-08) falls back through SPEC-05's four-file cascade.",
    ),
  max_bytes: z
    .int()
    .positive()
    .max(2_000_000)
    .default(200_000)
    .describe(
      'Ceiling on the assembled context, in bytes. Default: 200000. Ceiling: 2000000 — ' +
        'past this the field itself is rejected rather than accepted at an absurd size.',
    ),
  on_overflow: OnOverflowSchema.default('truncate').describe(
    'What happens when the assembled context exceeds max_bytes. Default: "truncate" ' +
      '(head+tail, Phase 4). "error" is available so an oversized file is never silently cut.',
  ),
});

export type ContextConfig = z.infer<typeof ContextConfigSchema>;

// ---------------------------------------------------------------------------
// Pipeline (EXEC-07, D-23)
// ---------------------------------------------------------------------------

/** A stage or harness identifier: lowercase, digits, and hyphens, starting with a letter. */
const StageIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

/** Policy for what happens after a `send_back` from this stage; Phase 7 implements it. */
export const OnSendBackSchema = z.enum(['continue', 'stop']);
export type OnSendBack = z.infer<typeof OnSendBackSchema>;

/**
 * A configured harness stage: `harness:` names an id resolved through the
 * registry (built-in id, then npm package, then repo-relative path) — that
 * resolution is 01-08's job, this schema validates shape only, so unknown ids
 * fail at config validation rather than mid-run.
 */
const HarnessEntrySchema = z.strictObject({
  harness: StageIdSchema.describe(
    'The harness id, resolved (01-08) as a built-in id, then an npm package, then a ' +
      'repo-relative path. Unrecognised ids fail at config validation, not mid-run.',
  ),
  with: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Harness-specific configuration, passed through opaquely. Default: none.'),
  on_send_back: OnSendBackSchema.optional().describe(
    'Whether a send_back from this stage continues the pipeline or stops it (Phase 7). ' +
      'Default: derived from the stage\'s cost class at runtime, not by this schema.',
  ),
});

/**
 * Accepted structurally and then always rejected, naming itself as a future
 * capability (D-23) — so the file format does not have to change when v2
 * parallel stages land.
 */
const GroupEntrySchema = z
  .strictObject({
    group: z.array(z.unknown()).min(1),
  })
  .superRefine((_value, ctx) => {
    ctx.addIssue({ code: 'custom', message: GROUP_SYNTAX_REJECTION });
  });

/**
 * One pipeline entry: a bare string names a built-in stage; an object either
 * configures a harness or (structurally, and only structurally) declares a
 * `group:`. Position in the array is the stage's position in the pipeline —
 * this is EXEC-07's entire mechanism (ARCHITECTURE.md §3).
 */
export const PipelineEntrySchema = z.union([StageIdSchema, HarnessEntrySchema, GroupEntrySchema]);

export type PipelineEntry = z.infer<typeof PipelineEntrySchema>;

// ---------------------------------------------------------------------------
// Limits (D-22)
// ---------------------------------------------------------------------------

/**
 * Ceilings on the loop's cost. Every field is bounded, because the YAML
 * parser silently rounds an oversized integer rather than rejecting it
 * (01-RESEARCH.md § Pitfall 11) — an unbounded field would accept an absurd
 * value at a rounded magnitude instead of refusing it outright.
 *
 * `EffectiveConfig`'s daemon-side clamp — `limits.*` may only be *lowered*
 * from the daemon's ceiling, never raised (D-22) — is 01-08's job. This
 * schema validates the repo-supplied value's own shape.
 */
export const LimitsSchema = z.strictObject({
  max_rounds: z
    .int()
    .positive()
    .max(50)
    .default(6)
    .describe(
      'How many develop/gate rounds a feature may run before escalating to a human. ' +
        'Default: 6. Ceiling: 50 — needing more is a signal the feature is too large, ' +
        'not that the limit should rise.',
    ),
  budget_usd: z
    .number()
    .positive()
    .max(10_000)
    .default(15)
    .describe(
      'Spend ceiling for one feature, in USD. Default: 15. Ceiling: 10000 — protects ' +
        'against a config typo (an extra zero), not a real budget policy signal.',
    ),
  repeat_finding_threshold: z
    .int()
    .positive()
    .max(20)
    .default(2)
    .describe(
      'How many rounds the same finding fingerprint may recur before stall detection ' +
        'escalates (LOOP-06). Default: 2. Ceiling: 20 — recurring that often means the ' +
        'developer is stuck, not that the threshold needs to go higher.',
    ),
});

export type Limits = z.infer<typeof LimitsSchema>;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * Per-role agent configuration. **Backend and credential selection is
 * daemon-only (D-22):** a budget the watched repo can raise is not a budget,
 * and a backend it can choose is a credential-selection primitive. This field
 * exists so a daemon-level config can use the same shape; 01-08 strips or
 * rejects a repo-supplied value against `EffectiveConfig`'s daemon side. That
 * clamp is not this schema's job — this schema validates shape only.
 */
const AgentBlockSchema = z.strictObject({
  backend: z
    .string()
    .min(1)
    .describe(
      'The agent backend id (e.g. "claude-code"). No default. Shape-only: daemon-only ' +
        'per D-22, and 01-08 clamps or rejects a repo-supplied value.',
    ),
  model: z.string().min(1).describe('The model alias to run this role with. No default.'),
  prompt_template: RepoRelativePathSchema.optional().describe(
    'A repo-relative override of the default prompt template for this role. Default: none.',
  ),
});

export const AgentsConfigSchema = z.strictObject({
  developer: AgentBlockSchema.optional(),
  reviewer: AgentBlockSchema.optional(),
  tester: AgentBlockSchema.optional(),
});

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

// ---------------------------------------------------------------------------
// The root schema
// ---------------------------------------------------------------------------

export const AdlYmlSchema = z
  .strictObject({
    version: z
      .literal(ADL_YML_VERSION)
      .describe(
        'The adl.yml schema version. No default — every file must state it explicitly. ' +
          'Must equal 1; within a major version ADL only adds optional keys, so a file ' +
          'declaring version 2 fails loudly rather than being misread against the wrong shape.',
      ),
    features_dir: RepoRelativePathSchema.default('features').describe(
      'The directory, relative to the repo root, ADL watches for feature folders ' +
        '(features/<id>/, D-16). Default: "features".',
    ),
    commands: CommandsSchema.describe(
      'The four lifecycle commands — build, start, test, teardown — each an argv array, ' +
        'never a shell string. No default: every field is required.',
    ),
    context: ContextConfigSchema.default({
      max_bytes: 200_000,
      on_overflow: 'truncate',
    }).describe(
      'Which repo files feed the agent prompts, and the overflow policy if they exceed ' +
        'max_bytes. Default: { max_bytes: 200000, on_overflow: "truncate" } — files is left ' +
        "undeclared so 01-08's context cascade applies.",
    ),
    pipeline: z
      .array(PipelineEntrySchema)
      .min(1)
      .describe(
        'The ordered list of stages a feature passes through — built-in stage names, ' +
          'configured harnesses, or (parsed and rejected) v2 stage groups. No default: at ' +
          'least one stage is required.',
      ),
    limits: LimitsSchema.default({
      max_rounds: 6,
      budget_usd: 15,
      repeat_finding_threshold: 2,
    }).describe(
      'Ceilings on this loop\'s cost, clamped down — never up — by the daemon\'s own ' +
        'ceiling (D-22). Default: { max_rounds: 6, budget_usd: 15, repeat_finding_threshold: 2 }; ' +
        'see LimitsSchema for each field\'s individual documented ceiling.',
    ),
    agents: AgentsConfigSchema.default({}).describe(
      'Per-role model selection, shape-only — backend and credential selection is ' +
        'daemon-only (D-22) and a repo-supplied value here is clamped by EffectiveConfig, ' +
        'not by this schema. Default: {} (no role overrides).',
    ),
  })
  .meta({ id: 'AdlYml' });

export type AdlYml = z.infer<typeof AdlYmlSchema>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Renders a Zod issue as `path: message`, or bare `message` at the root. */
function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join('.');
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Parse and validate an `adl.yml` source string.
 *
 * Composes {@link parseYamlDocument} with {@link AdlYmlSchema}. Takes the file
 * *contents* as a string — reading the file is the caller's job, per this
 * package's purity claim.
 *
 * @returns the validated config, or a {@link LoadError} — carrying the YAML
 * position when the failure was syntactic, or every offending field path when
 * it was semantic. Returned rather than thrown, so a caller validating a
 * batch of repo configs is not forced into try/catch per file.
 */
export function parseAdlYml(source: string): AdlYml | LoadError {
  let raw: unknown;
  try {
    raw = parseYamlDocument(source);
  } catch (error) {
    if (error instanceof LoadError) return error;
    throw error;
  }

  const result = AdlYmlSchema.safeParse(raw);
  if (!result.success) {
    return new LoadError(result.error.issues.map(formatIssue).join('; '));
  }

  return result.data;
}
