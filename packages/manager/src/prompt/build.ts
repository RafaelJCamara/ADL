/**
 * `PromptBuilder` — the one module that renders a developer prompt
 * (`ARCHITECTURE.md` §4). Adapters never build prompts; `AgentTask.systemPrompt`
 * and `AgentTask.instructions` arrive at `@adl/agent-claude-code`'s backend
 * already rendered, and this module is the only place that rendering happens.
 *
 * ── Determinism (success criterion 4) ──────────────────────────────────────
 *
 * `buildDeveloperPrompt` is a **pure function of its input**: the same
 * `NormalizedSpec`/`EffectiveConfig`/`AgentCapabilities` triple produces
 * byte-identical output on every call, in this process or a fresh one.
 * Concretely, that means:
 *
 * - No timestamp, no random id, no absolute host path, no environment value.
 * - No iteration over an unordered collection — `acceptanceCriteria` is
 *   iterated in the array order `NormalizedSpec` already guarantees (D-01's
 *   positional `AC-n` numbering), never re-sorted or grouped through a `Map`
 *   or `Set` whose iteration order is not part of the input.
 * - The author's raw spec text is included **verbatim**, alongside the
 *   identified criteria checklist — `NormalizedSpec.raw`'s own docblock
 *   states why an agent must never see only the parsed form: tables, links,
 *   and nuance a criterion's own `text` slice does not carry.
 *
 * `04-09` is where the persisted prompt artefact and the byte-identity proof
 * across two real invocations lands; this module is the mechanism that proof
 * exercises.
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
import type { EffectiveConfig } from '@adl/core/config';
import type { AgentCapabilities } from '@adl/core/stage';
import type { AcceptanceCriterion, NormalizedSpec } from '@adl/core/spec';

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

export interface DeveloperPromptInput {
  readonly spec: NormalizedSpec;
  readonly effectiveConfig: EffectiveConfig;
  readonly capabilities: AgentCapabilities;
}

export interface RenderedPrompt {
  readonly systemPrompt: string;
  readonly instructions: string;
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

function readTemplate(): string {
  return readFileSync(TEMPLATE_PATH, 'utf8');
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
/**
 * `template.replace(literal, value)` is unsafe here: `String.prototype.replace`
 * interprets `$&`/`$$`/`$'`-style sequences in the REPLACEMENT string even
 * when the search value is a plain string, not a regex — and every value
 * substituted below (the spec title, the raw spec text, the criteria
 * checklist) is repo-supplied, untrusted content that could legitimately
 * contain a literal `$`. `split(literal).join(value)` performs a literal,
 * one-shot substitution with no special-sequence interpretation at all.
 */
function substitute(template: string, literal: string, value: string): string {
  return template.split(literal).join(value);
}

export function buildDeveloperPrompt(
  input: DeveloperPromptInput,
): RenderedPrompt {
  void input.capabilities;
  const template = readTemplate();
  const narrative = input.spec.narrative ?? '(no narrative provided)';
  let instructions = template;
  instructions = substitute(instructions, '{{title}}', input.spec.title);
  instructions = substitute(instructions, '{{narrative}}', narrative);
  instructions = substitute(
    instructions,
    '{{acceptanceCriteriaChecklist}}',
    renderAcceptanceCriteriaChecklist(input.spec.acceptanceCriteria),
  );
  instructions = substitute(instructions, '{{rawSpec}}', input.spec.raw);

  return { systemPrompt: DEVELOPER_SYSTEM_PROMPT, instructions };
}
