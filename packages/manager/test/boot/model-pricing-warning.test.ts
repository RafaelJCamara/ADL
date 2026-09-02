import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import {
  AdlYmlSchema,
  DaemonConfigSchema,
  type AdlYml,
} from '@adl/core/config';
import { migrateToLatest } from '@adl/db';
import { startDaemon } from '../../src/daemon.js';
import { warnUnpricedRoleModels } from '../../src/boot/model-pricing-warning.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * The unpriceable-model warning (BACK-10, M06 step 6.10).
 *
 * The property under test is not "a log line appears" — it is that the one
 * configuration mistake which silently disables 6.4's per-feature budget and
 * 6.5's global cap is *visible at boot*. D-31 deliberately keeps an unpriced
 * usage event out of the compared total rather than pricing it at zero, so a
 * role configured onto a model with no `model_prices` row spends real money
 * that no gate ever sees. Nothing else in the system reports that.
 *
 * The price rows here are the real seeded ones from migration `0003`, never a
 * fixture table: the check is only worth anything if it agrees with what an
 * adopter's database actually contains.
 */
describe('warnUnpricedRoleModels', () => {
  it('warns for a role configured onto a model with no price row, naming the role and the model', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { logger, logs } = createCapturingLogger();

      const unpriced = await warnUnpricedRoleModels({
        db,
        daemonConfig: DaemonConfigSchema.parse({
          agents: {
            developer: {
              backend: 'claude-code',
              model: 'claude-not-a-real-model',
            },
          },
        }),
        logger,
      });

      expect(unpriced).toEqual([
        { role: 'developer', modelId: 'claude-not-a-real-model' },
      ]);

      const warnings = logs.filter((log) => log.level >= 40);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.role).toBe('developer');
      expect(warnings[0]?.modelId).toBe('claude-not-a-real-model');
      // The consequence, not just the fact: an operator who reads only the
      // message has to learn that their budget stopped seeing this spend.
      expect(warnings[0]?.msg).toContain('budget');
    });
  });

  it('is silent for a model the seeded price table can price', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { logger, logs } = createCapturingLogger();

      const unpriced = await warnUnpricedRoleModels({
        db,
        daemonConfig: DaemonConfigSchema.parse({
          agents: {
            developer: { backend: 'claude-code', model: 'claude-haiku-4-5' },
          },
        }),
        logger,
      });

      expect(unpriced).toEqual([]);
      expect(logs.filter((log) => log.level >= 40)).toEqual([]);
    });
  });

  it('is silent under the default sentinel — nothing was selected, so there is nothing to price', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { logger, logs } = createCapturingLogger();

      // A daemon config naming no agents at all: every role resolves to
      // `BACKEND_DEFAULT_MODEL`. This is the default installation, and it
      // must not warn — a warning on every default boot is a warning nobody
      // reads by the time a real one arrives.
      const unpriced = await warnUnpricedRoleModels({
        db,
        daemonConfig: DaemonConfigSchema.parse({}),
        logger,
      });

      expect(unpriced).toEqual([]);
      expect(logs.filter((log) => log.level >= 40)).toEqual([]);
    });
  });

  it('warns for every unpriceable role independently, not just the developer', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { logger, logs } = createCapturingLogger();

      const unpriced = await warnUnpricedRoleModels({
        db,
        daemonConfig: DaemonConfigSchema.parse({
          agents: {
            developer: { backend: 'claude-code', model: 'claude-haiku-4-5' },
            reviewer: { backend: 'claude-code', model: 'reviewer-only-model' },
            tester: { backend: 'claude-code', model: 'tester-only-model' },
          },
        }),
        logger,
      });

      // The developer is priceable and the other two are not — which is the
      // configuration a maintainer trying out a new model for review would
      // actually produce, and the one a developer-only check would miss
      // entirely.
      expect(unpriced).toEqual([
        { role: 'reviewer', modelId: 'reviewer-only-model' },
        { role: 'tester', modelId: 'tester-only-model' },
      ]);
      expect(logs.filter((log) => log.level >= 40)).toHaveLength(2);
    });
  });

  it('does not count a price row that is not effective yet', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const { logger } = createCapturingLogger();

      // `claude-sonnet-5`'s second seeded row takes effect 2026-09-01. Read
      // as of a date before EVERY row for that model, the model prices
      // nothing — the same temporal rule `priceAt` applies, asserted here so
      // the boot check and the ledger cannot disagree about what "priceable"
      // means.
      const unpriced = await warnUnpricedRoleModels({
        db,
        daemonConfig: DaemonConfigSchema.parse({
          agents: {
            developer: { backend: 'claude-code', model: 'claude-sonnet-5' },
          },
        }),
        logger,
        at: '2025-12-31T00:00:00.000Z',
      });

      expect(unpriced).toEqual([
        { role: 'developer', modelId: 'claude-sonnet-5' },
      ]);
    });
  });
});

/**
 * The wiring, separately from the logic — `test/boot/adl-yml-gate.test.ts`'s
 * precedent for its own sibling gate. A check `startDaemon` never calls warns
 * nobody, and nothing above this line would notice.
 */
describe('startDaemon wires the unpriceable-model warning', () => {
  // An explicit timeout, on `test/scenario/*`'s precedent rather than the
  // other files in this directory: those boot gates refuse before any real
  // work happens, while this one boots a daemon all the way up — migrations,
  // a real host git workspace, a bound port. Under the 5s default it is the
  // machine's load, not the code, that decides whether it passes.
  it(
    'warns at boot for a role configured onto an unpriceable model, and still starts',
    { timeout: 60_000 },
    async () => {
      await withTempDb(async ({ db, filePath }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);

        await withTempRepo(async ({ mainRepo, scratchRoot }) => {
          const { logger, logs } = createCapturingLogger();
          const adlYml: AdlYml = AdlYmlSchema.parse({
            version: 1,
            commands: {
              build: { argv: ['true'] },
              start: { argv: ['true'] },
              test: { argv: ['true'] },
              teardown: { argv: ['true'] },
            },
            pipeline: ['develop'],
          });

          const handle = await startDaemon({
            dbFilePath: filePath,
            port: 0,
            apiToken: `test-token-${ulid()}`,
            migrationsDir: MIGRATIONS_DIR,
            leaseTtlMs: 30_000,
            heartbeatIntervalMs: 10_000,
            daemonConfig: DaemonConfigSchema.parse({
              agents: {
                reviewer: {
                  backend: 'claude-code',
                  model: 'not-priced-anywhere',
                },
              },
            }),
            resolveAdlYml: () => adlYml,
            mainRepo,
            scratchRoot,
            logger,
          });

          try {
            const pricingWarnings = logs.filter(
              (log) =>
                typeof log.msg === 'string' &&
                log.msg.startsWith('model pricing:'),
            );
            expect(pricingWarnings).toHaveLength(1);
            expect(pricingWarnings[0]?.role).toBe('reviewer');
            expect(pricingWarnings[0]?.modelId).toBe('not-priced-anywhere');
            // A warning, never a refusal: the daemon is up and serving. An
            // unpriceable model is a ledger gap, not a broken installation.
            expect(handle.port).toBeGreaterThan(0);
          } finally {
            await handle.stop();
          }
        });
      });
    },
  );
});
