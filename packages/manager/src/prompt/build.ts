/**
 * `PromptBuilder` — the one module that renders a developer prompt
 * (`ARCHITECTURE.md` §4). Adapters never build prompts; `AgentTask.systemPrompt`
 * and `AgentTask.instructions` arrive at `@adl/agent-claude-code`'s backend
 * already rendered, and this module is the only place that rendering happens.
 *
 * ── Determinism (success criterion 4) ──────────────────────────────────────
 *
 * `buildDeveloperPrompt` is a **pure function of its input**: the same
 * `NormalizedSpec`/`EffectiveConfig`/`AgentCapabilities`/`workspaceRoot`
 * quadruple produces byte-identical output on every call, in this process or
 * a fresh one, on one commit. Concretely, that means:
 *
 * - No timestamp, no random id, no environment value.
 * - No absolute host path **in the rendered output** — `workspaceRoot` is an
 *   absolute path and IS used, exactly the way `TEMPLATE_PATH` below already
 *   is: to locate a file to read. Neither value is ever interpolated into the
 *   text a caller receives. Only the declared, repo-relative path of a
 *   context file appears in the render — see "The explicit-context surface"
 *   below.
 * - No iteration over an unordered collection — `acceptanceCriteria` is
 *   iterated in the array order `NormalizedSpec` already guarantees (D-01's
 *   positional `AC-n` numbering), and declared context files are iterated in
 *   `effectiveConfig.context.files`'s own declared order — never re-sorted or
 *   grouped through a `Map`/`Set` whose iteration order is not part of the
 *   input.
 * - The author's raw spec text is included **verbatim**, alongside the
 *   identified criteria checklist — `NormalizedSpec.raw`'s own docblock
 *   states why an agent must never see only the parsed form: tables, links,
 *   and nuance a criterion's own `text` slice does not carry.
 *
 * `04-09` is where the persisted prompt artefact and the byte-identity proof
 * across two real invocations lands; this module is the mechanism that proof
 * exercises, and `04-09`'s own Task 2 is what enforces the rule list above —
 * see that module's docblock.
 *
 * ── The explicit-context surface (04-09 success criterion 4) ───────────────
 *
 * With repository-level config auto-discovery disabled on the agent CLI's own
 * invocation (`@adl/agent-claude-code`'s `--bare`, pinned by
 * `packages/agent-claude-code/test/argv.test.ts`), anything ADL wants the
 * agent to have must be handed over deliberately. This module is that
 * deliberate hand-over for repository files: it reads exactly the paths
 * declared in `effectiveConfig.context.files` — never anything merely
 * *present* on disk — and renders each one's declared path and content, in
 * declared order. A repository's own instruction file (`AGENTS.md`,
 * `CLAUDE.md`, ...) is admitted only when it appears in that declared list;
 * presence on disk is not consent. The context-file *cascade*
 * (`@adl/core/config`'s `resolveContextFiles`, which falls back through that
 * same four-file list when nothing is declared) is a separate, not-yet-wired
 * concern — deliberately out of this module's scope; see `04-09-PLAN.md`
 * Task 1's own `read_first` list, which does not name it.
 *
 * A declared file larger than `effectiveConfig.context.max_bytes` is
 * truncated head-and-tail with an explicit elision marker
 * ({@link truncateHeadAndTail}) so a reader can tell a truncated file from a
 * short one, unless `effectiveConfig.context.on_overflow` is `'error'`, in
 * which case rendering refuses outright ({@link PromptContextOverflowError})
 * — `ContextConfigSchema`'s own comment on `on_overflow` names silent
 * truncation as "exactly the quiet degradation this project is designed
 * against", so an explicit `'error'` choice is honoured, not paved over.
 *
 * ── The template file ───────────────────────────────────────────────────────
 *
 * Stored as markdown under `templates/`, per `04-RESEARCH.md`'s Open
 * Question 1 recommendation — a file is the most diffable and PR-reviewable
 * option, matching PROJECT.md's "reasoning visible" value. Loaded relative to
 * THIS module (`import.meta.url`), never to `process.cwd()`, so the same
 * template resolves regardless of where the daemon process was started from.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EffectiveConfig, OnOverflow } from '@adl/core/config';
import type { AgentCapabilities } from '@adl/core/stage';
import type { AcceptanceCriterion, NormalizedSpec } from '@adl/core/spec';
import { resolveWithinRoot } from '@adl/workspace';

const TEMPLATE_PATH = fileURLToPath(
  new URL('./templates/developer.md', import.meta.url),
);

/**
 * The developer role's fixed system prompt. A constant, not a template — it
 * carries nothing that varies between two runs on the same commit, so there
 * is no rendering step for it to go through. States the identity contract
 * `worker-entry/stage-runner.ts` (Task 2) actually enforces via the exec
 * spec's environment: the agent is expected to commit its own work, and its
 * commit identity is supplied, not theirs to choose.
 */
export const DEVELOPER_SYSTEM_PROMPT: string =
  'You are the ADL developer agent, running inside a git worktree ADL created for one feature. ' +
  'Implement the feature described in your instructions so that every acceptance criterion is ' +
  'satisfiable, then commit your work. Your commit author and committer identity has already been ' +
  'supplied to you as environment values (GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, ' +
  'GIT_COMMITTER_EMAIL) — do not override it. A run that produces no commit will be reported ' +
  'honestly as such, never as a silent pass.';

/**
 * One repository file ADL declared as context, resolved relative to
 * {@link DeveloperPromptInput.workspaceRoot}.
 */
export interface DeveloperPromptInput {
  readonly spec: NormalizedSpec;
  readonly effectiveConfig: EffectiveConfig;
  readonly capabilities: AgentCapabilities;
  /**
   * The feature's workspace root — the git worktree `effectiveConfig.context
   * .files` entries are resolved against. Always an absolute host path, used
   * ONLY to locate and read a declared file's content; the value itself never
   * appears in the rendered output (see the module docblock's determinism
   * rules) — only a declared file's own repo-relative path does.
   */
  readonly workspaceRoot: string;
}

export interface RenderedPrompt {
  readonly systemPrompt: string;
  readonly instructions: string;
}

/** Thrown when a declared `context.files` entry cannot be read from the workspace. */
export class PromptContextFileError extends Error {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(
      `declared context file "${path}" could not be read from the workspace: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PromptContextFileError';
    this.path = path;
  }
}

/**
 * Thrown when a declared context file exceeds `context.max_bytes` and
 * `context.on_overflow` is `'error'` — the explicit "never silently degrade"
 * choice `ContextConfigSchema`'s own comment documents.
 */
export class PromptContextOverflowError extends Error {
  readonly path: string;
  readonly byteLength: number;
  readonly maxBytes: number;

  constructor(path: string, byteLength: number, maxBytes: number) {
    super(
      `declared context file "${path}" is ${String(byteLength)} bytes, exceeding the ` +
        `configured ${String(maxBytes)}-byte cap, and context.on_overflow is "error" — ` +
        'refusing to truncate silently.',
    );
    this.name = 'PromptContextOverflowError';
    this.path = path;
    this.byteLength = byteLength;
    this.maxBytes = maxBytes;
  }
}

/** The verbatim criterion text for either `AcceptanceCriterion` member, per `types.ts`'s own shape. */
function criterionText(criterion: AcceptanceCriterion): string {
  return criterion.text;
}

/** A deterministic, positionally-ordered checklist — never re-sorted, never grouped through an unordered collection. */
function renderAcceptanceCriteriaChecklist(
  criteria: readonly AcceptanceCriterion[],
): string {
  if (criteria.length === 0) {
    // Structurally shouldn't happen — both spec loaders refuse to produce a
    // NormalizedSpec with zero criteria — but a template that silently
    // rendered nothing here would be a worse failure than one that says so.
    return '(no acceptance criteria — this spec should not have loaded)';
  }
  return criteria
    .map((criterion) => `- **${criterion.id}**: ${criterionText(criterion)}`)
    .join('\n');
}

/**
 * Head-and-tail elision, byte-budgeted against `maxBytes` (which bounds the
 * WHOLE result, marker included, not just the kept content). Operates on
 * `Buffer` byte offsets rather than string character offsets — the same
 * "measure in bytes, not characters" discipline `ndjson-log-store.ts` uses —
 * so the cap is honoured against what actually reaches the model, not an
 * approximation of it. A cut may land inside a multi-byte UTF-8 sequence;
 * `Buffer.toString('utf8')` replaces an incomplete trailing/leading sequence
 * with U+FFFD rather than throwing, which keeps this function total (it never
 * fails on the file it is asked to truncate) at the cost of at most one
 * replacement character at either seam — an acceptable, visible artifact
 * given the alternative is a thrown exception mid-render.
 */
function truncateHeadAndTail(content: string, maxBytes: number): string {
  const marker =
    `\n\n[... elided: content exceeds the configured ${String(maxBytes)}-byte cap; ` +
    'head and tail shown ...]\n\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const buffer = Buffer.from(content, 'utf8');
  const budget = Math.max(maxBytes - markerBytes, 0);
  const headBytes = Math.ceil(budget / 2);
  const tailBytes = budget - headBytes;
  const head = buffer.subarray(0, headBytes).toString('utf8');
  const tail =
    tailBytes > 0
      ? buffer.subarray(buffer.byteLength - tailBytes).toString('utf8')
      : '';
  return `${head}${marker}${tail}`;
}

/** One declared context file, rendered as its own labelled section. */
function renderContextFileEntry(
  workspaceRoot: string,
  declaredPath: string,
  maxBytes: number,
  onOverflow: OnOverflow,
): string {
  // The lexical containment guard `transcript-path.ts` and `artifact.ts` both
  // reuse — a defence-in-depth backstop, since `RepoRelativePathSchema`
  // already refused a `..`/absolute/UNC-shaped path at config-parse time.
  const absolutePath = resolveWithinRoot(workspaceRoot, declaredPath);

  let content: string;
  try {
    content = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new PromptContextFileError(declaredPath, error);
  }

  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > maxBytes) {
    if (onOverflow === 'error') {
      throw new PromptContextOverflowError(declaredPath, byteLength, maxBytes);
    }
    content = truncateHeadAndTail(content, maxBytes);
  }

  return `### ${declaredPath}\n\n${content}`;
}

/**
 * The declared-context-files section: one labelled block per declared path,
 * in declared order — never anything merely present on disk (see the module
 * docblock's "explicit-context surface" section).
 */
function renderDeclaredContextFiles(
  workspaceRoot: string,
  files: readonly string[],
  maxBytes: number,
  onOverflow: OnOverflow,
): string {
  if (files.length === 0) {
    return '(no repository context files declared)';
  }
  return files
    .map((path) =>
      renderContextFileEntry(workspaceRoot, path, maxBytes, onOverflow),
    )
    .join('\n\n');
}

function readTemplate(): string {
  return readFileSync(TEMPLATE_PATH, 'utf8');
}

const PLACEHOLDER_PATTERN = /\{\{(\w+)\}\}/g;

/**
 * Single-pass placeholder substitution over the ORIGINAL template string.
 *
 * Two hazards this replaces the previous per-placeholder `split(literal)
 * .join(value)` loop to close, both load-bearing now that a declared context
 * file's content — untrusted repository input — is one of the values:
 *
 * 1. **`String.prototype.replace(pattern, value)` with a STRING second
 *    argument** interprets `$&`/`$$`/`$'`-style sequences in that string even
 *    when `pattern` is a plain string, not a regex — and every value
 *    substituted here (the spec title, the raw spec text, a criterion's text,
 *    a declared context file's content) is repo-supplied and could
 *    legitimately contain a literal `$`. Passing a FUNCTION as the second
 *    argument (as this does) sidesteps that entirely: a function replacer's
 *    return value is inserted literally, with no special-sequence
 *    reinterpretation at all.
 * 2. **Substituting placeholders one at a time, in a loop, re-scans the
 *    ALREADY-SUBSTITUTED result on every subsequent call.** If an earlier
 *    substitution's value happened to contain the literal text of a LATER
 *    placeholder (e.g. the spec narrative containing the string
 *    `{{rawSpec}}`), the old loop would replace that occurrence too on the
 *    later call — untrusted content that is supposed to be inert becoming a
 *    second substitution point. A single `replace()` call with a GLOBAL regex
 *    processes matches against the ORIGINAL string only; `String.replace`
 *    never re-scans a callback's return value for further matches, so a
 *    value can never be reinterpreted as containing more placeholder syntax,
 *    no matter what it contains.
 */
function render(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    if (!(key in values)) {
      throw new Error(
        `prompt template references undeclared placeholder "{{${key}}}"`,
      );
    }
    return values[key]!;
  });
}

/**
 * Render the developer role's prompt for one invocation.
 *
 * A pure function of `input` — see the module docblock's determinism
 * section. `capabilities` is accepted (per this task's own signature) but
 * intentionally interpolates nothing today: the developer template has no
 * capability-conditional section yet, and adding one is a natural follow-up
 * once a backend without incremental events needs a different instruction
 * shape. Accepting the parameter now, unused in the rendered text, keeps the
 * signature stable for that follow-up rather than adding it as a breaking
 * change later.
 */
export function buildDeveloperPrompt(
  input: DeveloperPromptInput,
): RenderedPrompt {
  void input.capabilities;
  const template = readTemplate();
  const narrative = input.spec.narrative ?? '(no narrative provided)';
  const declaredContextFiles = renderDeclaredContextFiles(
    input.workspaceRoot,
    input.effectiveConfig.context.files ?? [],
    input.effectiveConfig.context.max_bytes,
    input.effectiveConfig.context.on_overflow,
  );

  const instructions = render(template, {
    title: input.spec.title,
    narrative,
    acceptanceCriteriaChecklist: renderAcceptanceCriteriaChecklist(
      input.spec.acceptanceCriteria,
    ),
    declaredContextFiles,
    rawSpec: input.spec.raw,
  });

  return { systemPrompt: DEVELOPER_SYSTEM_PROMPT, instructions };
}
