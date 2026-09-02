/**
 * The unpriceable-model warning (BACK-10, M06 step 6.10) — the accounting
 * half of per-role model selection.
 *
 * ── Why an unpriceable model is a budget defect, not a cosmetic one ────────
 *
 * D-31 keeps an unpriced usage event out of the compared total rather than
 * pricing it at zero: `priceUsageEvent` records `costUsd: null` /
 * `costSource: 'unknown'`, and `spendByCategory` counts it in
 * `unpricedEvents` instead of adding it to `total`. That is the right call —
 * a budget that prices an unknown model at zero has stopped enforcing without
 * saying so — but it has a consequence a daemon operator will not discover on
 * their own: **configuring a role onto a model with no `model_prices` row
 * silently removes that role's entire spend from 6.4's per-feature budget and
 * 6.5's global cap.** The gates keep running; they just stop seeing the money.
 *
 * This module is what makes that visible at boot, once, instead of never.
 *
 * ── A warning, never a refusal ─────────────────────────────────────────────
 *
 * Deliberately not the shape of `runStartupGate` or `runBackendPreflight`,
 * which return a `refused` outcome `startDaemon` turns into a thrown error.
 * A model is usable before it is priced: a new Anthropic release is
 * runnable the day it ships, and the price row for it arrives in a later
 * migration. Refusing to start would make ADL unusable for exactly as long
 * as it took the maintainer to cut a release — for a condition whose real
 * cost is a temporarily incomplete ledger. So this reports and returns.
 *
 * ── Why the check is "any row for this model id", not `priceAt` ────────────
 *
 * `priceAt` needs a speed tier (`standard` / `fast`), and the tier is not
 * knowable at boot: it is a property of the invocation the backend reports,
 * not of the configuration. Asking `priceAt` for `standard` would warn
 * falsely about a model priced only for `fast`. "Is there any row at all for
 * this model id, effective by now?" is the question configuration can
 * actually answer, and it is the one whose false answer is the defect above.
 *
 * The {@link BACKEND_DEFAULT_MODEL} sentinel is skipped rather than warned
 * about, and that is not an exemption. It means "ADL selected no model", so
 * there is nothing to price under that name and never will be — the price
 * belongs to whatever the backend picked on its own, which arrives on the
 * `started` event and is priced then. Warning about it would fire on every
 * default installation and train the operator to ignore this log line.
 */
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import {
  AGENT_ROLES,
  BACKEND_DEFAULT_MODEL,
  DEFAULT_CONFIG,
  type AgentRole,
  type DaemonConfig,
} from '@adl/core/config';
import { usageRepository, type Database } from '@adl/db';

/** One role whose configured model has no price row this daemon could use. */
export interface UnpricedRoleModel {
  readonly role: AgentRole;
  readonly modelId: string;
}

export interface ModelPricingWarningDeps {
  readonly db: Kysely<Database>;
  readonly daemonConfig: DaemonConfig;
  readonly logger: Logger;
  /**
   * The instant the price table is read as of. Defaults to now. A row whose
   * `effective_from` is still in the future prices nothing today, so it must
   * not count as coverage — the same temporal rule `priceAt` applies.
   */
  readonly at?: string;
}

/**
 * Warn for every agent role configured onto a model `model_prices` cannot
 * price. Returns what it warned about so a caller — and a test — can read
 * the finding as a value rather than by scraping the log.
 */
export async function warnUnpricedRoleModels(
  deps: ModelPricingWarningDeps,
): Promise<readonly UnpricedRoleModel[]> {
  const at = deps.at ?? new Date().toISOString();
  const onDate = at.slice(0, 10);

  // One read for every role, rather than one per role: three roles will
  // usually name one or two distinct models, and the table is small enough
  // that the whole of it is cheaper than three round trips.
  const prices = await usageRepository(deps.db).listPrices();
  const priceable = new Set(
    prices
      .filter((price) => price.effective_from <= onDate)
      .map((price) => price.model_id),
  );

  const unpriced: UnpricedRoleModel[] = [];
  for (const role of AGENT_ROLES) {
    const modelId =
      deps.daemonConfig.agents[role]?.model ??
      DEFAULT_CONFIG.agents[role].model;
    if (modelId === BACKEND_DEFAULT_MODEL) continue;
    if (priceable.has(modelId)) continue;
    unpriced.push({ role, modelId });
  }

  for (const finding of unpriced) {
    deps.logger.warn(
      { role: finding.role, modelId: finding.modelId, at },
      "model pricing: no price row for this role's configured model — its spend " +
        'will be recorded as unpriced and will NOT count against the per-feature ' +
        'budget or the global spend cap',
    );
  }

  return unpriced;
}
