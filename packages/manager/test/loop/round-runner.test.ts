import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import {
  featuresRepository,
  migrateToLatest,
  nowIso,
  type Database,
  type FeaturesTable,
} from '@adl/db';
import { githubForgeAdapter } from '@adl/forge-github';
import type { EffectiveConfig } from '@adl/core/config';
import type { Verdict } from '@adl/core/verdict';
import { openAttempt } from '../../src/bookkeeping/attempt.js';
import { onStageCompleted } from '../../src/loop/round-runner.js';
import type { StageRunnerVerdict } from '../../src/ipc/stage-verdict.js';
import {
  MIGRATIONS_DIR,
  withTempDb,
} from '../../../db/test/helpers/temp-db.js';
import {
  startMockGithubServer,
  type MockGithubServer,
} from '../../../forge-github/test/helpers/mock-github-server.js';
import { throwawayPrivateKeyPem } from '../../../forge-github/test/helpers/throwaway-key.js';
import { createCapturingLogger } from '../helpers/capturing-logger.js';

/**
 * The round loop against a real database (M05 step 5.13).
 *
 * `@adl/core/loop`'s own suite proves the decision; this file proves the
 * consequences — which rows move, which do not, and what happens when a write
 * loses a race. The four properties worth the most here:
 *
 * 1. **A round's outcome reaches `rounds.outcome_json`**, which is what closes
 *    `docs/plan/DEBT.md` D-5-11-1's headline half: a prior round rendered from
 *    the database alone now says what it decided.
 * 2. **`crash_count` is reset by the same transaction that closes the round**
 *    (D-11) — `resetCrashCountOnSuccess`'s first caller since M03.
 * 3. **The judgement is recorded before the state write**, so a lost CAS race
 *    costs a transition and never the verdict a pull request renders from.
 * 4. **A stale lease token writes nothing at all** (D-06's fence, applied once
 *    more at the write site rather than only at the message).
 */

const FORGE_REPO = { owner: 'adl-test-org', repo: 'demo-repo' };
const CRITERION = { kind: 'global', category: 'other' } as const;

let server: MockGithubServer;
let forge: ReturnType<typeof githubForgeAdapter>;

beforeEach(async () => {
  server = await startMockGithubServer();
  forge = githubForgeAdapter({
    appId: 'adl-test-app',
    privateKey: throwawayPrivateKeyPem(),
    installationId: 1,
    baseUrl: server.url,
    disablePacingForTests: true,
  });
});

afterEach(async () => {
  await server.close();
});

/** A snapshotted `EffectiveConfig`, reduced to what the loop actually reads. */
function snapshot(pipeline: readonly string[], maxRounds = 6): string {
  return JSON.stringify({
    pipeline,
    limits: { max_rounds: maxRounds },
  } as unknown as EffectiveConfig);
}

interface Seeded {
  readonly feature: FeaturesTable;
  readonly leaseToken: string;
}

async function seedFeature(
  db: Kysely<Database>,
  overrides: Partial<FeaturesTable> = {},
): Promise<Seeded> {
  const now = nowIso();
  const repoId = ulid();
  await db
    .insertInto('repos')
    .values({
      id: repoId,
      remote_url: 'https://github.com/adl-test-org/demo-repo.git',
      default_branch: 'main',
      forge: 'github',
      features_dir: 'features',
      created_at: now,
      updated_at: now,
    })
    .execute();

  const id = ulid();
  const leaseToken = ulid();
  await db
    .insertInto('features')
    .values({
      id,
      repo_id: repoId,
      path: 'features/dark-mode',
      state: 'leased',
      state_version: 1,
      round: 1,
      current_stage_index: 0,
      spec_hash: 'a'.repeat(64),
      effective_config_json: snapshot(['develop', 'review', 'test']),
      workspace_handle: 'features/dark-mode',
      lease_owner: 'manager',
      lease_token: leaseToken,
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      heartbeat_at: now,
      crash_count: 2,
      created_at: now,
      updated_at: now,
      ...overrides,
    })
    .execute();

  return {
    feature: (await featuresRepository(db).findById(id))!,
    leaseToken: (overrides.lease_token as string | undefined) ?? leaseToken,
  };
}

function committed(sha = 'abc1234'): string {
  return JSON.stringify({
    kind: 'developer_outcome',
    outcome: { kind: 'committed', sha },
  } satisfies StageRunnerVerdict);
}

function gateVerdict(verdict: Verdict): string {
  return JSON.stringify({
    kind: 'verdict',
    verdict,
  } satisfies StageRunnerVerdict);
}

function stageError(kind: 'provider_error' | 'auth', detail = 'broke'): string {
  return JSON.stringify({
    kind: 'stage_error',
    error: { kind, retryable: kind === 'provider_error', detail },
  } satisfies StageRunnerVerdict);
}

function deps(db: Kysely<Database>, withForge = false) {
  const { logger } = createCapturingLogger();
  return {
    db,
    logger,
    ...(withForge ? { forge: { adapter: forge, repo: FORGE_REPO } } : {}),
  };
}

/**
 * One stage, start to finish: lease the feature the way `dispatchOnce` would,
 * open a real attempt for `stageIndex`, then report `verdictJson` against it.
 *
 * The re-lease is not test scaffolding — it is the production shape. The loop
 * hands the lease back when a stage finishes, so a second stage in the same
 * round arrives under a *new* lease that a continuation dispatch acquired.
 * Reporting under the old one is exactly the stale result D-06's fence exists
 * to drop, which is what `options.leaseToken` lets a test present on purpose.
 */
async function report(
  db: Kysely<Database>,
  seeded: Seeded,
  stageIndex: number,
  stageId: string,
  verdictJson: string,
  options: { readonly withForge?: boolean; readonly leaseToken?: string } = {},
): Promise<{ roundId: string; stageAttemptId: string }> {
  let leaseToken = options.leaseToken;
  if (leaseToken === undefined) {
    const current = await reload(db, seeded.feature.id);
    leaseToken = current.lease_token ?? ulid();
    await db
      .updateTable('features')
      .set({
        lease_owner: 'manager',
        lease_token: leaseToken,
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .where('id', '=', seeded.feature.id)
      .execute();
  }

  const attempt = await openAttempt(
    { db },
    { featureId: seeded.feature.id, stageId, stageIndex },
  );
  await onStageCompleted(deps(db, options.withForge ?? false), {
    feature: seeded.feature,
    leaseToken,
    roundId: attempt.roundId,
    stageAttemptId: attempt.stageAttemptId,
    stageId,
    stageIndex,
    verdictJson,
  });
  return attempt;
}

async function reload(
  db: Kysely<Database>,
  id: string,
): Promise<FeaturesTable> {
  return (await featuresRepository(db).findById(id))!;
}

describe('the round loop — the developer stage', () => {
  it('advances a committed round to the first gate and releases the lease', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db);

      await report(db, seeded, 0, 'develop', committed('deadbee'));

      const row = await reload(db, seeded.feature.id);
      expect(row.state).toBe('gating');
      expect(row.current_stage_index).toBe(1);
      expect(row.round).toBe(1);
      // The worker is exiting; a lease held by nobody is what the reaper
      // collects, so the loop hands it back rather than letting it time out.
      expect(row.lease_token).toBeNull();

      const events = await featuresRepository(db).listEvents(seeded.feature.id);
      expect(events.map((event) => event.to_state)).toEqual([
        'developing',
        'gating',
      ]);
      // `workspace_ready` has never had a production emitter — a stage that
      // ran at all is the proof, so the audit trail records the state the
      // feature was really in rather than skipping it.
      expect(JSON.parse(events[0]!.event_json)).toEqual({
        t: 'workspace_ready',
      });
      expect(JSON.parse(events[1]!.event_json)).toEqual({
        t: 'dev_committed',
        sha: 'deadbee',
      });
    });
  });

  it('leaves the round open while the pipeline still has gates to run', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db);

      const { roundId } = await report(db, seeded, 0, 'develop', committed());

      const round = await db
        .selectFrom('rounds')
        .selectAll()
        .where('id', '=', roundId)
        .executeTakeFirst();
      expect(round?.outcome).toBeNull();
      expect(round?.outcome_json).toBeNull();
      expect(round?.ended_at).toBeNull();
      // Not a completed round, so the crash streak is not broken yet either.
      expect((await reload(db, seeded.feature.id)).crash_count).toBe(2);
    });
  });

  it('escalates a pipeline of develop alone rather than reporting a verified round', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, {
        effective_config_json: snapshot(['develop']),
      });

      const { roundId } = await report(db, seeded, 0, 'develop', committed());

      const row = await reload(db, seeded.feature.id);
      expect(row.state).toBe('escalated');

      const round = await db
        .selectFrom('rounds')
        .selectAll()
        .where('id', '=', roundId)
        .executeTakeFirst();
      expect(round?.outcome).toBe('escalate');
      expect(JSON.parse(round!.outcome_json!)).toMatchObject({
        kind: 'escalate',
      });
    });
  });
});

describe('the round loop — closing a round', () => {
  it('writes the whole RoundOutcome into rounds.outcome_json (DEBT D-5-11-1)', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, {
        state: 'gating',
        current_stage_index: 2,
      });

      const { roundId } = await report(
        db,
        seeded,
        2,
        'test',
        gateVerdict({
          outcome: 'send_back',
          summary: 'the suite is red',
          findings: [
            {
              fingerprint: 'b'.repeat(64),
              severity: 'blocker',
              title: 'two tests fail',
              detail: 'npm test exited 1',
              criterionRef: CRITERION,
            },
          ],
        }),
      );

      const round = await db
        .selectFrom('rounds')
        .selectAll()
        .where('id', '=', roundId)
        .executeTakeFirst();
      expect(round?.outcome).toBe('send_back');
      expect(round?.ended_at).not.toBeNull();
      // The whole payload, not just the kind: the brief is what the next
      // developer round and the pull-request rollup both read.
      expect(JSON.parse(round!.outcome_json!)).toMatchObject({
        kind: 'send_back',
        brief: { findings: [{ title: 'two tests fail' }] },
      });

      const row = await reload(db, seeded.feature.id);
      expect(row.state).toBe('developing');
      expect(row.round).toBe(2);
      expect(row.current_stage_index).toBe(0);
    });
  });

  it('resets crash_count when the round completes (D-11, resetCrashCountOnSuccess’s first caller)', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, {
        state: 'gating',
        current_stage_index: 2,
        crash_count: 2,
      });

      await report(
        db,
        seeded,
        2,
        'test',
        gateVerdict({
          outcome: 'pass',
          summary: 'green',
          checked: [CRITERION],
        }),
      );

      expect((await reload(db, seeded.feature.id)).crash_count).toBe(0);
    });
  });

  it('records the gate’s verdict and findings so the round is evidence, not a claim', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, {
        state: 'gating',
        current_stage_index: 1,
      });

      const { stageAttemptId } = await report(
        db,
        seeded,
        1,
        'review',
        gateVerdict({
          outcome: 'send_back',
          summary: 'one thing',
          findings: [
            {
              fingerprint: 'c'.repeat(64),
              severity: 'major',
              title: 'missing null check',
              detail: 'line 12',
              criterionRef: CRITERION,
              location: { path: 'src/app.ts', line: 12 },
            },
          ],
        }),
      );

      const verdict = await db
        .selectFrom('verdicts')
        .selectAll()
        .where('stage_attempt_id', '=', stageAttemptId)
        .executeTakeFirst();
      expect(verdict?.outcome).toBe('send_back');

      const findings = await db
        .selectFrom('findings')
        .selectAll()
        .where('verdict_id', '=', verdict!.id)
        .execute();
      expect(findings).toHaveLength(1);
      expect(findings[0]?.path).toBe('src/app.ts');
      expect(findings[0]?.line).toBe(12);
    });
  });

  it('aggregates every verdict in the round, not only the last one', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, {
        state: 'gating',
        current_stage_index: 1,
      });

      // Round 1's review gate could not tell. It does not stop the pipeline.
      await report(
        db,
        seeded,
        1,
        'review',
        gateVerdict({
          outcome: 'inconclusive',
          summary: 'the app never started',
          reason: 'the readiness probe timed out',
        }),
      );

      const afterReview = await reload(db, seeded.feature.id);
      expect(afterReview.state).toBe('gating');
      expect(afterReview.current_stage_index).toBe(2);

      // The last gate passes — but the round is NOT green, because the
      // inconclusive is still in it.
      const { roundId } = await report(
        db,
        { feature: afterReview, leaseToken: seeded.leaseToken },
        2,
        'test',
        gateVerdict({
          outcome: 'pass',
          summary: 'green',
          checked: [CRITERION],
        }),
      );

      const round = await db
        .selectFrom('rounds')
        .selectAll()
        .where('id', '=', roundId)
        .executeTakeFirst();
      expect(round?.outcome).toBe('unverified');
      expect((await reload(db, seeded.feature.id)).state).toBe('escalated');
    });
  });
});

describe('the round loop — stage errors (CORE-06)', () => {
  it('records a non-retryable failure on the attempt and escalates the round', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, {
        state: 'gating',
        current_stage_index: 1,
      });

      const { stageAttemptId, roundId } = await report(
        db,
        seeded,
        1,
        'review',
        stageError('auth', 'the key was rejected'),
      );

      const attempt = await db
        .selectFrom('stage_attempts')
        .selectAll()
        .where('id', '=', stageAttemptId)
        .executeTakeFirst();
      // `error`, never `verdict`: this attempt broke, it did not judge.
      expect(attempt?.status).toBe('error');
      expect(attempt?.error_kind).toBe('auth');
      expect(attempt?.error_retryable).toBe(0);

      const round = await db
        .selectFrom('rounds')
        .selectAll()
        .where('id', '=', roundId)
        .executeTakeFirst();
      expect(round?.outcome).toBe('escalate');
      expect((await reload(db, seeded.feature.id)).state).toBe('escalated');
    });
  });

  it('recovers a retryable failure through the crash path, and records no round at all', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, {
        state: 'gating',
        current_stage_index: 1,
        crash_count: 0,
      });

      const { roundId } = await report(
        db,
        seeded,
        1,
        'review',
        stageError('provider_error', '503 from the provider'),
      );

      const row = await reload(db, seeded.feature.id);
      expect(row.state).toBe('queued');
      // Routed through `reapOne`, so the consecutive-failure ceiling applies
      // and a provider outage cannot retry forever.
      expect(row.crash_count).toBe(1);

      const round = await db
        .selectFrom('rounds')
        .selectAll()
        .where('id', '=', roundId)
        .executeTakeFirst();
      // Nothing was judged, so there is no round outcome to record (LOOP-07).
      expect(round?.outcome).toBeNull();
    });
  });

  it('treats an unreadable stage result as a failure, never as a verdict', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, {
        state: 'gating',
        current_stage_index: 2,
      });

      const { roundId } = await report(
        db,
        seeded,
        2,
        'test',
        '{"kind":"nope"}',
      );

      const round = await db
        .selectFrom('rounds')
        .selectAll()
        .where('id', '=', roundId)
        .executeTakeFirst();
      expect(round?.outcome).toBe('escalate');
      expect((await reload(db, seeded.feature.id)).state).toBe('escalated');
    });
  });
});

describe('the round loop — the fence (D-06)', () => {
  it('drops a result presenting a lease token the row no longer holds', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db);

      const { roundId } = await report(db, seeded, 0, 'develop', committed(), {
        leaseToken: 'a-token-this-row-never-held',
      });

      const row = await reload(db, seeded.feature.id);
      // Nothing moved: not the state, not the round, not the lease.
      expect(row.state).toBe('leased');
      expect(row.lease_token).toBe(seeded.leaseToken);
      const round = await db
        .selectFrom('rounds')
        .selectAll()
        .where('id', '=', roundId)
        .executeTakeFirst();
      expect(round?.outcome).toBeNull();
      expect(
        await featuresRepository(db).listEvents(seeded.feature.id),
      ).toHaveLength(0);
    });
  });
});

describe('the round loop — green promotes the change request (FORGE-05)', () => {
  it('promotes the draft to ready and moves the feature to pr_open', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, {
        state: 'gating',
        current_stage_index: 2,
      });
      // The branch a real dispatch for this feature pushes — the same
      // composition `publish/branch.ts` recomputes from the row.
      const head = `adl/dark-mode--${seeded.feature.id}`;
      await forge.openChangeRequest({
        repo: FORGE_REPO,
        head,
        base: 'main',
        title: 'ADL: dark-mode',
        body: 'body',
        draft: true,
      });

      await report(
        db,
        seeded,
        2,
        'test',
        gateVerdict({
          outcome: 'pass',
          summary: 'green',
          checked: [CRITERION],
        }),
        { withForge: true },
      );

      const open = await forge.listOpenChangeRequests(FORGE_REPO);
      expect(open[0]?.draft).toBe(false);

      const row = await reload(db, seeded.feature.id);
      expect(row.state).toBe('pr_open');
    });
  });

  it('never promotes a change request for a round that was not green', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, {
        state: 'gating',
        current_stage_index: 2,
      });
      const head = `adl/dark-mode--${seeded.feature.id}`;
      await forge.openChangeRequest({
        repo: FORGE_REPO,
        head,
        base: 'main',
        title: 'ADL: dark-mode',
        body: 'body',
        draft: true,
      });

      await report(
        db,
        seeded,
        2,
        'test',
        gateVerdict({
          outcome: 'send_back',
          summary: 'not yet',
          findings: [
            {
              fingerprint: 'd'.repeat(64),
              severity: 'blocker',
              title: 'still red',
              detail: 'x',
              criterionRef: CRITERION,
            },
          ],
        }),
        { withForge: true },
      );

      const open = await forge.listOpenChangeRequests(FORGE_REPO);
      expect(open[0]?.draft).toBe(true);
    });
  });
});
