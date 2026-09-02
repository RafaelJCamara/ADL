/**
 * `on_send_back` — whether one gate's `send_back` stops the pipeline where it
 * stands, or lets the remaining gates run first (HARN-03, M07 step 7.2).
 *
 * ## Why this arrives now and not in M01
 *
 * `.planning/research/ARCHITECTURE.md` §3 defined the policy as per-stage and
 * defaulted **by cost class** — cheap gates continue and merge their findings
 * into one send-back, expensive ones stop. `OnSendBackSchema` and
 * `ResolvedStage.onSendBack` have carried the *shape* since M01, and
 * `round-step.ts` said in its own docblock that it read neither, because
 * `Stage.costClass` had no implementations to carry it and *half a policy is
 * worse than none*.
 *
 * M07 is the milestone that supplies a second gate, which is the condition
 * that statement was waiting on. This module is the other half.
 *
 * ## What the developer actually gets out of it
 *
 * With `stop`, a feature whose lint fails and whose tests also fail learns
 * about the lint failure, fixes it, spends a round, and *then* learns about the
 * tests. With `continue`, both arrive in one send-back and cost one round. That
 * is the whole benefit, and it is why the split is by cost: running a cheap
 * gate on code already known to need changes costs almost nothing and buys a
 * merged brief, while running an *expensive* one — an agent reviewer — buys
 * the same brief for real money, on code that is about to change anyway.
 *
 * ## The conservative default is `stop`, and that is deliberate
 *
 * {@link DEFAULT_COST_CLASS} is `expensive`, so a stage this build knows
 * nothing about — every `npm`- and `repo-path`-sourced harness, which is
 * M13's tier — keeps v1's behaviour exactly. A third-party gate opts into
 * `continue` by declaring `on_send_back: continue` in `adl.yml`, which is a
 * maintainer's decision about their own pipeline rather than ADL guessing what
 * someone else's gate costs to run.
 */
import {
  BUILT_IN_STAGE_IDS,
  type BuiltInStageId,
  type ResolvedStage,
} from '../config/pipeline.js';
import type { OnSendBack } from '../config/adl-yml.js';
import type { CostClass } from '../stage/stage.js';

/**
 * What a stage this build knows nothing about is assumed to cost.
 *
 * `expensive`, so an unknown harness defaults to `stop` — byte-identical to
 * pre-7.2 behaviour. The alternative, guessing `cheap`, would make ADL pay for
 * a third-party gate it has never seen on code already known to need changes,
 * on the strength of an assumption nobody made explicitly.
 */
export const DEFAULT_COST_CLASS: CostClass = 'expensive';

/**
 * What each built-in stage costs to run.
 *
 * `develop` is here for completeness rather than use — index 0 is the mutator
 * and produces a `DeveloperOutcome`, not a verdict, so no `send_back` policy
 * ever applies to it. `review` is an agent (M07 step 7.4) and `test` runs
 * `adl.yml`'s test command, which is the distinction the cost class exists to
 * draw.
 *
 * Keyed by `BuiltInStageId` and machine-checked against the frozen
 * `BUILT_IN_STAGE_IDS` below, so a fourth built-in fails the **build** rather
 * than silently inheriting {@link DEFAULT_COST_CLASS} — an implicit `stop` for
 * a stage ADL itself ships would be a policy nobody chose.
 */
const BUILT_IN_COST_CLASSES = Object.freeze({
  develop: 'expensive',
  review: 'expensive',
  test: 'cheap',
}) satisfies Record<BuiltInStageId, CostClass>;

/**
 * Compile-time proof the map above covers `BUILT_IN_STAGE_IDS` — the frozen
 * list's half of convention 7's pairing.
 */
type _EveryBuiltInPriced =
  Exclude<
    (typeof BUILT_IN_STAGE_IDS)[number],
    keyof typeof BUILT_IN_COST_CLASSES
  > extends never
    ? true
    : never;
const _everyBuiltInPriced: _EveryBuiltInPriced = true;
void _everyBuiltInPriced;

/**
 * Roughly what running this stage costs — a built-in's declared class, or
 * {@link DEFAULT_COST_CLASS} for anything else.
 *
 * Keyed on the resolved stage's `source` as well as its id, so a repo-path
 * harness that happens to be *named* `test` does not inherit the built-in
 * command gate's `cheap`. A pipeline entry's id is chosen by whoever wrote
 * `adl.yml`; only `source: 'built-in'` means ADL is the one that supplied it.
 */
export function costClassOf(stage: ResolvedStage): CostClass {
  if (stage.source !== 'built-in') return DEFAULT_COST_CLASS;
  return (
    BUILT_IN_COST_CLASSES[stage.id as BuiltInStageId] ?? DEFAULT_COST_CLASS
  );
}

/**
 * The `on_send_back` policy in force for one stage: what `adl.yml` declared,
 * or the default its cost class implies.
 *
 * The explicit value always wins, including when it is the *less* conservative
 * `continue` — unlike `limits`, this is not a ceiling a repository may only
 * lower. It is a pipeline-shape decision, and the pipeline is already the
 * repository's to write: a maintainer who has declared the stage order has
 * already decided what runs after what.
 */
export function onSendBackFor(stage: ResolvedStage): OnSendBack {
  if (stage.onSendBack !== undefined) return stage.onSendBack;
  // Written as "only `expensive` stops" rather than "`cheap` continues", so a
  // fourth cost class added to the union lands on the *conservative* side by
  // construction instead of quietly joining the continue group.
  return costClassOf(stage) === 'expensive' ? 'stop' : 'continue';
}
