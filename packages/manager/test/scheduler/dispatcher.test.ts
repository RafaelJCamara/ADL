import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  DEFAULT_CONFIG,
  mergeConfig,
  type AdlYml,
} from '@adl/core/config';
import {
  featuresRepository,
  migrateToLatest,
  nowIso,
  usageRepository,
  type Database,
} from '@adl/db';
import type { Kysely } from 'kysely';
import type { SendBackBrief } from '@adl/core/verdict';
import { dispatchOnce } from '../../src/index.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * Phase 3 Plan 07, Task 1: the concurrency cap (D-15..17) — inclusive
 * ceiling, FIFO by ULID, drain on lower. `test/tracer/end-to-end.test.ts`
 * already covers `dispatchOnce`'s basic lease-acquire-and-transition path
 * with no cap in play; this file is the cap's own behavior surface.
 */

const ADL_YML_FIXTURE: AdlYml = AdlYmlSchema.parse({
  version: 1,
  commands: {
    build: { argv: ['true'] },
    start: { argv: ['true'] },
    test: { argv: ['true'] },
    teardown: { argv: ['true'] },
  },
  pipeline: ['develop', 'review', 'test'],
});

/** A real snapshotted `effective_config_json`, the shape a continuation dispatch reads. */
function snapshottedConfigJson(): string {
  const { config } = mergeConfig(
    DEFAULT_CONFIG,
    DaemonConfigSchema.parse({}),
    ADL_YML_FIXTURE,
  );
  return JSON.stringify(config);
}

async function seedRepo(
  db: Kysely<Database>,
  id: string = ulid(),
): Promise<string> {
  const now = nowIso();
  await db
    .insertInto('repos')
    .values({
      id,
      remote_url: 'https://github.com/example/target-repo.git',
      default_branch: 'main',
      forge: 'github',
      features_dir: 'features',
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

interface SeedFeatureOptions {
  readonly repoId: string;
  readonly state?: 'queued' | 'leased' | 'developing' | 'gating';
  readonly id?: string;
  readonly currentStageIndex?: number;
  readonly effectiveConfigJson?: string;
}

async function seedFeature(
  db: Kysely<Database>,
  options: SeedFeatureOptions,
): Promise<string> {
  const featureId = options.id ?? ulid();
  const now = nowIso();
  const leased = (options.state ?? 'queued') === 'leased';

  await db
    .insertInto('features')
    .values({
      id: featureId,
      repo_id: options.repoId,
      path: `features/${featureId}`,
      state: options.state ?? 'queued',
      state_version: 1,
      round: 0,
      current_stage_index: options.currentStageIndex ?? 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: options.effectiveConfigJson ?? null,
      workspace_handle: null,
      lease_owner: leased ? 'manager' : null,
      lease_token: leased ? ulid() : null,
      lease_expires_at: leased
        ? new Date(Date.now() + 60_000).toISOString()
        : null,
      heartbeat_at: leased ? now : null,
      crash_count: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();

  return featureId;
}

/**
 * A `usage_events` row against a feature — `round_id`/`stage_attempt_id` are
 * both nullable FKs (`0002_contracts.ts`) and a null value is never checked,
 * so a unit test asserting only the budget arithmetic does not have to seed
 * the round/stage_attempt chain `packages/db/test/repos-usage.test.ts` needs
 * for its join.
 */
async function seedUsageEvent(
  db: Kysely<Database>,
  featureId: string,
  costUsd: number | null,
): Promise<void> {
  await usageRepository(db).record({
    id: ulid(),
    feature_id: featureId,
    round_id: null,
    stage_attempt_id: null,
    model_id: 'claude-sonnet-5',
    speed: 'standard',
    input_tokens: null,
    output_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cost_usd: costUsd,
    cost_source: costUsd === null ? 'unknown' : 'reported',
    cost_category: 'feature',
    at: nowIso(),
  });
}

function baseDeps(
  db: Kysely<Database>,
  daemonConfig: ReturnType<typeof DaemonConfigSchema.parse>,
) {
  return {
    db,
    leaseTtlMs: 60_000,
    heartbeatIntervalMs: 5_000,
    daemonConfig,
    resolveAdlYml: () => ADL_YML_FIXTURE,
    mainRepo: '/main/repo',
    scratchRoot: '/main/repo/.adl/scratch',
    spawnWorker: () => {
      /* no-op — this file never forks a real worker */
    },
  };
}

describe('dispatchOnce — the concurrency cap', () => {
  it('with cap 3 and 2 in flight, leases one more', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 3 },
      });
      const decision = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(decision.dispatched).toBe(true);
    });
  });

  it('with cap 3 and exactly 3 in flight, leases nothing and listLeased() still returns 3 rows — the boundary case', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 3 },
      });
      const decision = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(decision.dispatched).toBe(false);

      const leased = await featuresRepository(db).listLeased();
      expect(leased).toHaveLength(3);
    });
  });

  it('with cap 3 and 4 in flight (reachable only by lowering the cap mid-flight), leases nothing and revokes nothing', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 3 },
      });
      const decision = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(decision.dispatched).toBe(false);

      const leased = await featuresRepository(db).listLeased();
      expect(leased).toHaveLength(4);
    });
  });

  it('lowering the cap from 3 to 1 with 3 in flight leaves all 3 alive; as slots open, only one replacement is dispatched per call', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const leasedIds = [
        await seedFeature(db, { repoId, state: 'leased' }),
        await seedFeature(db, { repoId, state: 'leased' }),
        await seedFeature(db, { repoId, state: 'leased' }),
      ];
      for (let i = 0; i < 5; i += 1) {
        await seedFeature(db, { repoId, state: 'queued' });
      }

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 1 },
      });

      const blocked = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(blocked.dispatched).toBe(false);
      const stillLeased = await featuresRepository(db).listLeased();
      expect(stillLeased).toHaveLength(3);
      expect(stillLeased.map((row) => row.id).sort()).toEqual(
        [...leasedIds].sort(),
      );

      // Every held lease finishes — the in-flight count drops to 0.
      const repo = featuresRepository(db);
      for (const id of leasedIds) {
        const row = await repo.findById(id);
        await repo.releaseLease({ id, leaseToken: row!.lease_token! });
      }

      const decision = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(decision.dispatched).toBe(true);
      const afterOne = await featuresRepository(db).listLeased();
      expect(afterOne).toHaveLength(1);

      // A second call, with the one new lease still held, dispatches nothing
      // further — the cap of 1 admits exactly one replacement at a time.
      const second = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(second.dispatched).toBe(false);
      const afterTwo = await featuresRepository(db).listLeased();
      expect(afterTwo).toHaveLength(1);
    });
  });

  it('with per_repo 1 and two queued features in one repository, only one is leased even with global cap room', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'queued' });
      await seedFeature(db, { repoId, state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 5, per_repo: 1 },
      });

      const first = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(first.dispatched).toBe(true);

      const second = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(second.dispatched).toBe(false);

      const leased = await featuresRepository(db).listLeased();
      expect(leased).toHaveLength(1);
    });
  });

  it('with per_repo unset, only the global cap applies', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 5 },
      });
      const decision = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(decision.dispatched).toBe(true);
    });
  });

  it('with an empty daemon config, the effective global cap is 1', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'leased' });
      await seedFeature(db, { repoId, state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({});
      expect(daemonConfig.concurrency.global).toBe(1);

      const decision = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(decision.dispatched).toBe(false);
    });
  });

  it('given several queued features seeded out of id order, the one leased is the lowest id', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const ids = [ulid(), ulid(), ulid()].sort();
      // Insert deliberately out of sorted order.
      await seedFeature(db, { repoId, id: ids[2], state: 'queued' });
      await seedFeature(db, { repoId, id: ids[0], state: 'queued' });
      await seedFeature(db, { repoId, id: ids[1], state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 5 },
      });
      const decision = await dispatchOnce(baseDeps(db, daemonConfig));
      expect(decision.dispatched).toBe(true);
      expect(decision.featureId).toBe(ids[0]);
    });
  });
});

describe('dispatchOnce — forge.pushCredential (M05 step 5.10)', () => {
  it('mints a push credential and threads it onto assign.pushUrl', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'queued' });

      let capturedPushUrl: string | undefined;
      const daemonConfig = DaemonConfigSchema.parse({});
      const decision = await dispatchOnce({
        ...baseDeps(db, daemonConfig),
        forge: {
          pushCredential: async () =>
            'https://x-access-token:tok@github.com/example/target-repo.git',
        },
        spawnWorker: (call) => {
          capturedPushUrl = call.assign.pushUrl;
        },
      });

      expect(decision.dispatched).toBe(true);
      expect(capturedPushUrl).toBe(
        'https://x-access-token:tok@github.com/example/target-repo.git',
      );
    });
  });

  it('degrades to no pushUrl, without failing dispatch, when minting the credential throws', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'queued' });

      let sawAssign = false;
      const daemonConfig = DaemonConfigSchema.parse({});
      const decision = await dispatchOnce({
        ...baseDeps(db, daemonConfig),
        forge: {
          pushCredential: async () => {
            throw new Error('installation token exchange failed');
          },
        },
        spawnWorker: (call) => {
          sawAssign = true;
          expect(call.assign.pushUrl).toBeUndefined();
        },
      });

      expect(decision.dispatched).toBe(true);
      expect(sawAssign).toBe(true);
    });
  });

  it('carries no pushUrl at all when no forge is configured', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'queued' });

      let sawAssign = false;
      const daemonConfig = DaemonConfigSchema.parse({});
      const decision = await dispatchOnce({
        ...baseDeps(db, daemonConfig),
        spawnWorker: (call) => {
          sawAssign = true;
          expect(call.assign.pushUrl).toBeUndefined();
        },
      });

      expect(decision.dispatched).toBe(true);
      expect(sawAssign).toBe(true);
    });
  });
});

describe('dispatchOnce — the send-back brief (LOOP-02, M05 step 5.15)', () => {
  const BRIEF: SendBackBrief = {
    findings: [
      {
        fingerprint: 'a'.repeat(64),
        severity: 'blocker',
        title: 'the test command failed (exit 1)',
        detail: 'FAIL: 1 test failed',
        criterionRef: { kind: 'global', category: 'build' },
      },
    ],
  };

  it("threads the prior round's brief onto assign.sendBackBriefJson for round 2's developer dispatch", async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, {
        repoId,
        state: 'developing',
        currentStageIndex: 0,
        effectiveConfigJson: snapshottedConfigJson(),
      });

      await featuresRepository(db).insertRound({
        id: ulid(),
        feature_id: featureId,
        number: 1,
        outcome: 'send_back',
        outcome_json: JSON.stringify({ kind: 'send_back', brief: BRIEF }),
        head_sha: null,
        started_at: nowIso(),
        ended_at: nowIso(),
      });

      let captured: string | undefined;
      const daemonConfig = DaemonConfigSchema.parse({});
      const decision = await dispatchOnce({
        ...baseDeps(db, daemonConfig),
        spawnWorker: (call) => {
          captured = call.assign.sendBackBriefJson;
        },
      });

      expect(decision.dispatched).toBe(true);
      expect(captured).toBeDefined();
      expect(JSON.parse(captured!)).toEqual(BRIEF);
    });
  });

  it('carries no brief on a fresh (round 1) dispatch', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      await seedFeature(db, { repoId, state: 'queued' });

      let sawAssign = false;
      const daemonConfig = DaemonConfigSchema.parse({});
      const decision = await dispatchOnce({
        ...baseDeps(db, daemonConfig),
        spawnWorker: (call) => {
          sawAssign = true;
          expect(call.assign.sendBackBriefJson).toBeUndefined();
        },
      });

      expect(decision.dispatched).toBe(true);
      expect(sawAssign).toBe(true);
    });
  });

  it('carries no brief on a continuation dispatch to a gate stage (index > 0), even with a send_back round in this feature’s history', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, {
        repoId,
        state: 'gating',
        currentStageIndex: 1,
        effectiveConfigJson: snapshottedConfigJson(),
      });

      await featuresRepository(db).insertRound({
        id: ulid(),
        feature_id: featureId,
        number: 1,
        outcome: 'send_back',
        outcome_json: JSON.stringify({ kind: 'send_back', brief: BRIEF }),
        head_sha: null,
        started_at: nowIso(),
        ended_at: nowIso(),
      });
      // The round this gate dispatch belongs to (round 2) — still open.
      await featuresRepository(db).insertRound({
        id: ulid(),
        feature_id: featureId,
        number: 2,
        outcome: null,
        outcome_json: null,
        head_sha: null,
        started_at: nowIso(),
        ended_at: null,
      });

      let sawAssign = false;
      const daemonConfig = DaemonConfigSchema.parse({});
      const decision = await dispatchOnce({
        ...baseDeps(db, daemonConfig),
        spawnWorker: (call) => {
          sawAssign = true;
          expect(call.assign.sendBackBriefJson).toBeUndefined();
        },
      });

      expect(decision.dispatched).toBe(true);
      expect(sawAssign).toBe(true);
    });
  });

  it("still finds round 1's closed brief when round 2 already has its own open row — the crash-recovery retry case", async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, {
        repoId,
        state: 'developing',
        currentStageIndex: 0,
        effectiveConfigJson: snapshottedConfigJson(),
      });

      await featuresRepository(db).insertRound({
        id: ulid(),
        feature_id: featureId,
        number: 1,
        outcome: 'send_back',
        outcome_json: JSON.stringify({ kind: 'send_back', brief: BRIEF }),
        head_sha: null,
        started_at: nowIso(),
        ended_at: nowIso(),
      });
      // Round 2 already opened by the attempt this dispatch is retrying —
      // `latestRound` would return this row (open); `latestClosedRound` must
      // skip past it to round 1.
      await featuresRepository(db).insertRound({
        id: ulid(),
        feature_id: featureId,
        number: 2,
        outcome: null,
        outcome_json: null,
        head_sha: null,
        started_at: nowIso(),
        ended_at: null,
      });

      let captured: string | undefined;
      const daemonConfig = DaemonConfigSchema.parse({});
      const decision = await dispatchOnce({
        ...baseDeps(db, daemonConfig),
        spawnWorker: (call) => {
          captured = call.assign.sendBackBriefJson;
        },
      });

      expect(decision.dispatched).toBe(true);
      expect(captured).toBeDefined();
      expect(JSON.parse(captured!)).toEqual(BRIEF);
    });
  });
});

describe('dispatchOnce — the per-feature budget (LOOP-04, M06 step 6.4)', () => {
  // `ADL_YML_FIXTURE` sets no `limits`, so `snapshottedConfigJson()` resolves
  // `budget_usd` to `LimitsSchema`'s own default — 15 — through both the
  // daemon ceiling and the repo request. Restated here as a constant so a
  // test that changes the default doesn't have to be found by a failing
  // assertion whose "15" looks like a magic number.
  const BUDGET_USD = 15;

  it('escalates a continuation candidate whose confirmed spend exceeds its snapshotted budget, and does not dispatch it', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, {
        repoId,
        state: 'gating',
        currentStageIndex: 1,
        effectiveConfigJson: snapshottedConfigJson(),
      });
      await seedUsageEvent(db, featureId, BUDGET_USD + 5);

      const { logger, logs } = createCapturingLogger();
      const daemonConfig = DaemonConfigSchema.parse({});
      const decision = await dispatchOnce({
        ...baseDeps(db, daemonConfig),
        logger,
      });

      expect(decision.dispatched).toBe(false);

      const row = (await featuresRepository(db).findById(featureId))!;
      expect(row.state).toBe('escalated');
      expect(row.lease_token).toBeNull();
      // The escalating edge moves no counter (`NO_COUNTER_CHANGE`) — the
      // feature is left exactly where its spend tipped it over, ready for a
      // human `resume` to re-lease from the same stage.
      expect(row.round).toBe(0);
      expect(row.current_stage_index).toBe(1);

      const events = await featuresRepository(db).listEvents(featureId);
      const limitEvent = events.find(
        (event) =>
          (JSON.parse(event.event_json) as { t: string }).t ===
          'limit_exceeded',
      );
      expect(limitEvent).toBeDefined();
      expect(JSON.parse(limitEvent!.event_json)).toEqual({
        t: 'limit_exceeded',
        reason: 'budget_limit',
      });

      expect(
        logs.some(
          (log) =>
            log.msg ===
              'dispatch: feature exceeded its per-feature budget — escalating rather than dispatching another round' &&
            log.featureId === featureId,
        ),
      ).toBe(true);
    });
  });

  it('dispatches normally when confirmed spend stays under the snapshotted budget', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, {
        repoId,
        state: 'gating',
        currentStageIndex: 1,
        effectiveConfigJson: snapshottedConfigJson(),
      });
      await seedUsageEvent(db, featureId, BUDGET_USD - 5);

      const daemonConfig = DaemonConfigSchema.parse({});
      const decision = await dispatchOnce(baseDeps(db, daemonConfig));

      expect(decision.dispatched).toBe(true);
      expect(decision.featureId).toBe(featureId);

      const row = (await featuresRepository(db).findById(featureId))!;
      expect(row.state).not.toBe('escalated');
    });
  });

  it('logs the degradation but still dispatches when an unpriced event leaves confirmed spend under budget', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const featureId = await seedFeature(db, {
        repoId,
        state: 'gating',
        currentStageIndex: 1,
        effectiveConfigJson: snapshottedConfigJson(),
      });
      await seedUsageEvent(db, featureId, BUDGET_USD - 5);
      // No confirmed cost — a backend that reported nothing usable
      // (5.18's `cost_source: 'unknown'`). Never folded into the total as
      // zero (D-31), so it must not silently vanish from what the operator
      // sees either.
      await seedUsageEvent(db, featureId, null);

      const { logger, logs } = createCapturingLogger();
      const daemonConfig = DaemonConfigSchema.parse({});
      const decision = await dispatchOnce({
        ...baseDeps(db, daemonConfig),
        logger,
      });

      expect(decision.dispatched).toBe(true);

      const row = (await featuresRepository(db).findById(featureId))!;
      expect(row.state).not.toBe('escalated');

      expect(
        logs.some(
          (log) =>
            log.msg ===
              'dispatch: budget check ran against incomplete cost data — some usage events reported no confirmed cost, so enforcement for this feature relies on the round ceiling for the unconfirmed portion' &&
            log.featureId === featureId &&
            log.unpricedEvents === 1,
        ),
      ).toBe(true);
    });
  });

  it('never budget-checks a fresh queued candidate, even against usage rows already recorded for it', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      // A `queued` row has no snapshot yet — this dispatch is what creates
      // one. The usage row below could only exist for a feature that has
      // already run at least once, which a fresh `queued` row never has;
      // seeding it anyway proves the guard is the state/snapshot check, not
      // an accident of no test having produced this shape yet.
      const featureId = await seedFeature(db, { repoId, state: 'queued' });
      await seedUsageEvent(db, featureId, BUDGET_USD + 100);

      const daemonConfig = DaemonConfigSchema.parse({});
      const decision = await dispatchOnce(baseDeps(db, daemonConfig));

      expect(decision.dispatched).toBe(true);
      expect(decision.featureId).toBe(featureId);
    });
  });

  it('skips an over-budget candidate and dispatches the next admissible one', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const ids = [ulid(), ulid()].sort();
      const overBudgetId = await seedFeature(db, {
        repoId,
        id: ids[0],
        state: 'gating',
        currentStageIndex: 1,
        effectiveConfigJson: snapshottedConfigJson(),
      });
      const underBudgetId = await seedFeature(db, {
        repoId,
        id: ids[1],
        state: 'gating',
        currentStageIndex: 1,
        effectiveConfigJson: snapshottedConfigJson(),
      });
      await seedUsageEvent(db, overBudgetId, BUDGET_USD + 5);
      await seedUsageEvent(db, underBudgetId, BUDGET_USD - 5);

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 5 },
      });
      const decision = await dispatchOnce(baseDeps(db, daemonConfig));

      expect(decision.dispatched).toBe(true);
      expect(decision.featureId).toBe(underBudgetId);

      const overBudgetRow =
        (await featuresRepository(db).findById(overBudgetId))!;
      expect(overBudgetRow.state).toBe('escalated');
    });
  });
});

describe('dispatchOnce — the global spend cap (LOOP-05, M06 step 6.5)', () => {
  // A `leased` feature never appears in `listDispatchable()` (it matches
  // neither of that method's two branches), so it is a clean place to attach
  // fleet-wide `usage_events` rows without the sink itself becoming a
  // dispatch candidate — `totalSpend()` sums across every feature regardless
  // of state, exactly what makes this cap fleet-wide rather than per-feature.
  async function seedSpendSink(
    db: Kysely<Database>,
    repoId: string,
  ): Promise<string> {
    return seedFeature(db, { repoId, state: 'leased' });
  }

  it('halts new dispatch entirely once fleet-wide confirmed spend exceeds the cap, leaving the candidate untouched', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const sinkId = await seedSpendSink(db, repoId);
      await seedUsageEvent(db, sinkId, 120);
      const candidateId = await seedFeature(db, { repoId, state: 'queued' });

      const { logger, logs } = createCapturingLogger();
      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 5 },
        global_budget_usd: 100,
      });
      const decision = await dispatchOnce({
        ...baseDeps(db, daemonConfig),
        logger,
      });

      expect(decision.dispatched).toBe(false);

      // The halt is fleet-wide, not a judgement on this candidate — it is
      // left exactly as it was, unlike LOOP-04's per-feature escalation.
      const row = (await featuresRepository(db).findById(candidateId))!;
      expect(row.state).toBe('queued');

      expect(
        logs.some(
          (log) =>
            log.msg ===
            'dispatch: the global spend cap is exceeded — halting new dispatch across every feature until it is raised or the spend is investigated',
        ),
      ).toBe(true);
    });
  });

  it('dispatches normally when fleet-wide spend stays under the global cap', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const sinkId = await seedSpendSink(db, repoId);
      await seedUsageEvent(db, sinkId, 50);
      const candidateId = await seedFeature(db, { repoId, state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 5 },
        global_budget_usd: 100,
      });
      const decision = await dispatchOnce(baseDeps(db, daemonConfig));

      expect(decision.dispatched).toBe(true);
      expect(decision.featureId).toBe(candidateId);
    });
  });

  it('logs budget.warn once fleet-wide spend crosses 80% of the cap, without halting dispatch', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const sinkId = await seedSpendSink(db, repoId);
      await seedUsageEvent(db, sinkId, 85);
      const candidateId = await seedFeature(db, { repoId, state: 'queued' });

      const { logger, logs } = createCapturingLogger();
      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 5 },
        global_budget_usd: 100,
      });
      const decision = await dispatchOnce({
        ...baseDeps(db, daemonConfig),
        logger,
      });

      expect(decision.dispatched).toBe(true);
      expect(decision.featureId).toBe(candidateId);

      expect(
        logs.some(
          (log) =>
            log.event === 'budget.warn' &&
            log.spendUsd === 85 &&
            log.globalBudgetUsd === 100,
        ),
      ).toBe(true);
    });
  });

  it('logs the degradation warning when fleet-wide spend includes an unpriced event, without halting', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const sinkId = await seedSpendSink(db, repoId);
      await seedUsageEvent(db, sinkId, 10);
      await seedUsageEvent(db, sinkId, null);
      const candidateId = await seedFeature(db, { repoId, state: 'queued' });

      const { logger, logs } = createCapturingLogger();
      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 5 },
        global_budget_usd: 100,
      });
      const decision = await dispatchOnce({
        ...baseDeps(db, daemonConfig),
        logger,
      });

      expect(decision.dispatched).toBe(true);
      expect(decision.featureId).toBe(candidateId);

      expect(
        logs.some(
          (log) =>
            log.msg ===
              'dispatch: the global spend check ran against incomplete cost data — some usage events reported no confirmed cost, so fleet-wide enforcement for the unconfirmed portion relies on each feature’s own round ceiling' &&
            log.unpricedEvents === 1,
        ),
      ).toBe(true);
    });
  });

  it('never reads fleet-wide spend at all when no global_budget_usd is configured', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const repoId = await seedRepo(db);
      const sinkId = await seedSpendSink(db, repoId);
      await seedUsageEvent(db, sinkId, 1_000_000);
      const candidateId = await seedFeature(db, { repoId, state: 'queued' });

      const daemonConfig = DaemonConfigSchema.parse({
        concurrency: { global: 5 },
      });
      expect(daemonConfig.global_budget_usd).toBeUndefined();

      const decision = await dispatchOnce(baseDeps(db, daemonConfig));

      expect(decision.dispatched).toBe(true);
      expect(decision.featureId).toBe(candidateId);
    });
  });
});
