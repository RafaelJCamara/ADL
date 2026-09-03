/**
 * The shared-reviewer-model warning (M07 close-out) — the answer `DEBT.md`'s
 * **D-6-09-1** was owed by this milestone.
 *
 * ## The risk, and why it needed a decision rather than a note
 *
 * `.planning/research/PITFALLS.md` ranks *"reviewer rubber-stamping via
 * self-preference"* **#5** in its own risk table: *"If reviewer and developer
 * are the same model, the review gate is decorative. Cheap to fix (role/model
 * separation + evidence-bearing verdicts), catastrophic to discover late
 * because it invalidates all dogfooding evidence collected before the fix."*
 * It prescribes two mitigations. The first — fresh context — became **ROLE-03**
 * and shipped in 5.17, proven end to end in M07 step 7.5. The second — *"make
 * cross-model review a first-class config, and the recommended default"* — did
 * not survive into `docs/plan/`, which is what D-6-09-1 recorded.
 *
 * M06 steps 6.9–6.11 made per-role model selection actually **work**, so
 * cross-model review became *expressible*. Nothing made it happen, and
 * `DEFAULT_AGENT_BLOCK` gives all three roles the identical
 * `{ backend: 'claude-code', model: 'default' }` — so in an install nobody has
 * configured, the reviewer judges its own author's work.
 *
 * **Maintainer decision, 2026-09-03: warn, including the default case.** ADL
 * does not pick models on an operator's behalf — a refusal would make a
 * perfectly runnable configuration unstartable over a judgement call that is
 * the operator's — but it does not stay silent about the one risk whose whole
 * danger is that it is invisible until the evidence is already worthless.
 *
 * ## Why this warns for the sentinel and `model-pricing-warning.ts` does not
 *
 * That module skips {@link BACKEND_DEFAULT_MODEL} deliberately, and says why:
 * the sentinel means *"ADL selected no model"*, so there is nothing to price
 * under that name and never will be — warning about it *"would fire on every
 * default installation and train the operator to ignore this log line"*.
 *
 * The reasoning does not transfer, because the two cases differ in the one
 * thing that decides whether a warning earns its place: **whether it is
 * actionable.** For pricing, the default case has no remedy — the price
 * belongs to whatever the backend picked, and arrives on the `started` event.
 * Here the default case is *exactly* the dangerous one and its remedy is one
 * line of configuration. A warning that fired only on a deliberate same-model
 * collision would be silent for every operator who is actually at risk.
 *
 * ## What this cannot see, stated rather than left to be discovered
 *
 * **It does not know whether any pipeline contains a `review` stage.** A
 * pipeline is a property of each repository's own `adl.yml`, read per feature
 * at admission (`EffectiveConfig.pipeline` comes from `repo.pipeline` and from
 * nowhere else), so at boot there is no pipeline to consult for every caller —
 * and a warning that fired in production but not under an injected
 * `resolveAdlYml` would be worse than one extra line. The condition it cannot
 * check is therefore named in the message rather than guessed at. Narrowing it
 * once pipelines are boot-visible is recorded in `DEBT.md`.
 */
import type { Logger } from 'pino';
import { DEFAULT_CONFIG, type DaemonConfig } from '@adl/core/config';

/** What {@link warnSharedReviewerModel} found, returned so a caller — and a test — can read it as a value rather than by scraping the log. */
export interface SharedReviewerModel {
  /**
   * The model id both roles resolve to, or `BACKEND_DEFAULT_MODEL` when
   * neither names one — in which case both roles get whatever the backend
   * chooses, which is the same model by construction.
   */
  readonly modelId: string;
  /** True when the collision is the untouched default rather than a configured one. */
  readonly isBackendDefault: boolean;
}

export interface ReviewerModelWarningDeps {
  readonly daemonConfig: DaemonConfig;
  readonly logger: Logger;
}

function modelFor(
  daemonConfig: DaemonConfig,
  role: 'developer' | 'reviewer',
): string {
  return daemonConfig.agents[role]?.model ?? DEFAULT_CONFIG.agents[role].model;
}

/**
 * Warn when the reviewer would run on the developer's model.
 *
 * Returns `undefined` when the two differ — the configuration the research
 * asked for — and the collision otherwise.
 */
export function warnSharedReviewerModel(
  deps: ReviewerModelWarningDeps,
): SharedReviewerModel | undefined {
  const developer = modelFor(deps.daemonConfig, 'developer');
  const reviewer = modelFor(deps.daemonConfig, 'reviewer');
  if (developer !== reviewer) return undefined;

  // Compared against `DEFAULT_CONFIG`'s own value rather than against the
  // imported sentinel, so this cannot drift from what the two roles actually
  // resolved to above (rule 8: derive, never restate).
  const isBackendDefault = reviewer === DEFAULT_CONFIG.agents.reviewer.model;

  deps.logger.warn(
    { modelId: reviewer, isBackendDefault },
    isBackendDefault
      ? 'reviewer model: the reviewer and the developer both run on the backend’s own ' +
          'default model, so any `review` stage in a pipeline is judging work its own ' +
          'model wrote — models prefer their own output, which makes the gate decorative. ' +
          'Set agents.reviewer.model to a different model family.'
      : 'reviewer model: the reviewer and the developer are configured onto the same ' +
          'model, so any `review` stage in a pipeline is judging work its own model wrote ' +
          '— models prefer their own output, which makes the gate decorative. Set ' +
          'agents.reviewer.model to a different model family.',
  );

  return { modelId: reviewer, isBackendDefault };
}
