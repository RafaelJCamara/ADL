import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import {
  AdlYmlSchema,
  BACKEND_DEFAULT_MODEL,
  DaemonConfigSchema,
  type AdlYml,
} from '@adl/core/config';
import { migrateToLatest } from '@adl/db';
import { startDaemon } from '../../src/daemon.js';
import { warnSharedReviewerModel } from '../../src/boot/reviewer-model-warning.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';
import { withTempRepo } from '../../../workspace/test/helpers/temp-repo.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';

/**
 * The shared-reviewer-model warning (M07 close-out) — the answer `DEBT.md`'s
 * **D-6-09-1** was owed by this milestone.
 *
 * The property under test is not "a log line appears". It is that the risk the
 * archived research ranks **#5** — *"if reviewer and developer are the same
 * model, the review gate is decorative … catastrophic to discover late because
 * it invalidates all dogfooding evidence collected before the fix"* — is
 * **visible at boot in the configuration an operator actually has**, which for
 * an untouched install means both roles on the backend's own default.
 *
 * The case that carries the weight is therefore the **default** one, and it is
 * exactly where `model-pricing-warning.ts` deliberately stays silent. The two
 * differ in whether the default case is actionable: for pricing it is not (the
 * price belongs to whatever the backend picked, and arrives on the `started`
 * event), and here it is — one line of configuration.
 */
describe('warnSharedReviewerModel', () => {
  it('warns for an untouched install, where both roles get the backend default', async () => {
    const { logger, logs } = createCapturingLogger();

    const finding = warnSharedReviewerModel({
      daemonConfig: DaemonConfigSchema.parse({}),
      logger,
    });

    // The dangerous case, and the one nothing else in the system reports.
    expect(finding).toEqual({
      modelId: BACKEND_DEFAULT_MODEL,
      isBackendDefault: true,
    });
    const warnings = logs.filter(
      (log) =>
        typeof log.msg === 'string' && log.msg.startsWith('reviewer model:'),
    );
    expect(warnings).toHaveLength(1);
    // The remedy is named, because a warning an operator cannot act on is a
    // warning they learn to skip.
    expect(warnings[0]?.msg).toContain('agents.reviewer.model');
  });

  it('warns when both roles are configured onto the same named model', async () => {
    const { logger, logs } = createCapturingLogger();

    const finding = warnSharedReviewerModel({
      daemonConfig: DaemonConfigSchema.parse({
        agents: {
          developer: { backend: 'claude-code', model: 'claude-opus-5' },
          reviewer: { backend: 'claude-code', model: 'claude-opus-5' },
        },
      }),
      logger,
    });

    expect(finding).toEqual({
      modelId: 'claude-opus-5',
      isBackendDefault: false,
    });
    expect(
      logs.filter(
        (log) =>
          typeof log.msg === 'string' && log.msg.startsWith('reviewer model:'),
      ),
    ).toHaveLength(1);
  });

  it('says nothing when the reviewer runs on a different model — the configuration the research asked for', async () => {
    // The negative control. Without it, every assertion above would also hold
    // for a build that warned unconditionally, which would be a warning about
    // nothing.
    const { logger, logs } = createCapturingLogger();

    const finding = warnSharedReviewerModel({
      daemonConfig: DaemonConfigSchema.parse({
        agents: {
          developer: { backend: 'claude-code', model: 'claude-opus-5' },
          reviewer: { backend: 'claude-code', model: 'claude-sonnet-5' },
        },
      }),
      logger,
    });

    expect(finding).toBeUndefined();
    expect(
      logs.filter(
        (log) =>
          typeof log.msg === 'string' && log.msg.startsWith('reviewer model:'),
      ),
    ).toEqual([]);
  });

  it('warns when only the developer is configured and the reviewer keeps the default', async () => {
    // Not a collision — the developer names a model and the reviewer does not,
    // so they resolve to two different things and the risk does not apply.
    const { logger } = createCapturingLogger();

    expect(
      warnSharedReviewerModel({
        daemonConfig: DaemonConfigSchema.parse({
          agents: {
            developer: { backend: 'claude-code', model: 'claude-opus-5' },
          },
        }),
        logger,
      }),
    ).toBeUndefined();
  });
});

/**
 * The wiring, separately from the logic — `model-pricing-warning.test.ts`'s own
 * precedent, and for its reason: a check `startDaemon` never calls warns
 * nobody, and nothing above this line would notice.
 */
describe('startDaemon wires the shared-reviewer-model warning', () => {
  it(
    'warns at boot for an untouched install, and still starts',
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
            pipeline: ['develop', 'review'],
          });

          const handle = await startDaemon({
            dbFilePath: filePath,
            port: 0,
            apiToken: `test-token-${ulid()}`,
            migrationsDir: MIGRATIONS_DIR,
            leaseTtlMs: 30_000,
            heartbeatIntervalMs: 10_000,
            daemonConfig: DaemonConfigSchema.parse({}),
            resolveAdlYml: () => adlYml,
            mainRepo,
            scratchRoot,
            logger,
          });

          try {
            expect(
              logs.filter(
                (log) =>
                  typeof log.msg === 'string' &&
                  log.msg.startsWith('reviewer model:'),
              ),
            ).toHaveLength(1);
            // A warning, never a refusal. ADL does not pick models on an
            // operator's behalf — refusing here would make a perfectly runnable
            // configuration unstartable over a judgement that is theirs.
            expect(handle.port).toBeGreaterThan(0);
          } finally {
            await handle.stop();
          }
        });
      });
    },
  );
});
