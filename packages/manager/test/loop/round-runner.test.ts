import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monotonicFactory, ulid } from 'ulid';
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
import { MAX_CONSECUTIVE_TRANSIENT_FAILURES } from '@adl/core/loop';
import type { Verdict } from '@adl/core/verdict';
import type { ManagerGitClient } from '@adl/workspace';
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
/**
 * A transcript root that exists but holds nothing (M06 step 6.8).
 *
 * The escalation comment's excerpt reader reports `absent` for a transcript
 * file that is not there, which is the honest state for every attempt in this
 * file — none of them runs a real worker, so none writes one. That path is
 * exercised on purpose here; `test/publish/on-escalation.test.ts` is where a
 * transcript with records in it is asserted.
 */
let logsRoot: string;

beforeEach(async () => {
  logsRoot = await mkdtemp(join(tmpdir(), 'adl-round-runner-logs-'));
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
  await rm(logsRoot, { recursive: true, force: true });
});

/** A snapshotted `EffectiveConfig`, reduced to what the loop actually reads. */
function snapshot(
  pipeline: readonly string[],
  maxRounds = 6,
  protectedPaths: readonly string[] = [],
  // `LimitsSchema`'s own default (M06 step 6.6) — every test in this file
  // reports one finding per round, never the same fingerprint twice, so this
  // only has to be *present* (repeatFindingThresholdOf's own degrade-on-absent
  // is 0, `maxRoundsOf`'s exact fail-closed shape, which would flag every
  // single-occurrence finding here as an instant stalemate).
  repeatFindingThreshold = 2,
): string {
  return JSON.stringify({
    pipeline,
    limits: {
      max_rounds: maxRounds,
      repeat_finding_threshold: repeatFindingThreshold,
    },
    protected_paths: protectedPaths,
  } as unknown as EffectiveConfig);
}

/**
 * A `ManagerGitClient` double for the round loop's own tests, which insert
 * `rounds`/`features` rows directly rather than running a real worker against
 * a real repository — there is no real commit behind `committed('deadbee')`
 * for a real `git diff` to run against. `diffNameOnly` is the only member the
 * round loop ever calls; every other member rejects loudly if a future case
 * starts calling one, rather than silently returning a plausible-looking
 * empty answer.
 */
function stubGitClient(
  diffNameOnly: ManagerGitClient['diffNameOnly'] = () => Promise.resolve([]),
): ManagerGitClient {
  const notUsed = (member: string) => () =>
    Promise.reject(new Error(`${member} is not used by this test`));
  return {
    status: notUsed('status'),
    revParse: notUsed('revParse'),
    branches: notUsed('branches'),
    effectiveConfig: notUsed('effectiveConfig'),
    listFiles: notUsed('listFiles'),
    diffNameOnly,
    push: notUsed('push'),
  };
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

function stageError(
  kind: 'provider_error' | 'timeout' | 'auth',
  detail = 'broke',
): string {
  return JSON.stringify({
    kind: 'stage_error',
    error: { kind, retryable: kind !== 'auth', detail },
  } satisfies StageRunnerVerdict);
}

/**
 * Put finished attempts on a feature's record the way a run of provider
 * outages would have left them (LOOP-07).
 *
 * They go in a **closed** round so `openAttempt` opens a fresh one rather than
 * reusing this, which keeps the seeded history out of the way of the attempt
 * the test then reports against — including its `unique (round_id,
 * stage_index, attempt)` constraint.
 */
async function seedAttemptHistory(
  db: Kysely<Database>,
  featureId: string,
  attempts: readonly { status: string; errorKind: string | null }[],
): Promise<void> {
  const at = nowIso();
  const roundId = ulid();
  await db
    .insertInto('rounds')
    .values({
      id: roundId,
      feature_id: featureId,
      number: 99,
      outcome: 'escalate',
      outcome_json: JSON.stringify({ kind: 'escalate', reason: 'seeded' }),
      head_sha: null,
      started_at: at,
      ended_at: at,
    })
    .execute();

  // Strictly increasing ids — see the identical note in
  // `test/loop/transient-retry.test.ts`: the read these rows feed is ordered
  // newest-first by id, and plain `ulid()` does not guarantee that within a
  // single millisecond.
  const nextId = monotonicFactory();
  let ordinal = 0;
  for (const attempt of attempts) {
    ordinal += 1;
    await db
      .insertInto('stage_attempts')
      .values({
        id: nextId(),
        round_id: roundId,
        stage_id: 'review',
        stage_index: 1,
        attempt: ordinal,
        status: attempt.status,
        error_kind: attempt.errorKind,
        error_retryable: attempt.errorKind === null ? null : 1,
        error_raw_ref: null,
        started_at: at,
        ended_at: at,
      })
      .execute();
  }
}

/** `n` consecutive transient failures, as `seedAttemptHistory` rows. */
function transientRun(
  n: number,
): readonly { status: string; errorKind: string | null }[] {
  return Array.from({ length: n }, () => ({
    status: 'error',
    errorKind: 'provider_error',
  }));
}

function deps(
  db: Kysely<Database>,
  withForge = false,
  git: ManagerGitClient = stubGitClient(),
) {
  const { logger } = createCapturingLogger();
  return {
    db,
    logger,
    git,
    ...(withForge
      ? { forge: { adapter: forge, repo: FORGE_REPO, logsRoot } }
      : {}),
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
  options: {
    readonly withForge?: boolean;
    readonly leaseToken?: string;
    readonly git?: ManagerGitClient;
  } = {},
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
  await onStageCompleted(
    deps(db, options.withForge ?? false, options.git ?? stubGitClient()),
    {
      feature: seeded.feature,
      leaseToken,
      roundId: attempt.roundId,
      stageAttemptId: attempt.stageAttemptId,
      stageId,
      stageIndex,
      verdictJson,
    },
  );
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

describe('the round loop — protected-path enforcement (ROLE-11)', () => {
  it('hard-fails a round whose commit touched adl.yml, never sending it back', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db);

      const { roundId } = await report(
        db,
        seeded,
        0,
        'develop',
        committed('deadbee'),
        { git: stubGitClient(() => Promise.resolve(['adl.yml'])) },
      );

      const row = await reload(db, seeded.feature.id);
      expect(row.state).toBe('escalated');
      // Not sent back for another attempt: escalated is terminal, and the
      // whole point is that another round cannot be trusted to fix this.
      expect(row.round).toBe(1);

      const round = await db
        .selectFrom('rounds')
        .selectAll()
        .where('id', '=', roundId)
        .executeTakeFirst();
      expect(round?.outcome).toBe('escalate');
      expect(round?.head_sha).toBe('deadbee');
      const outcome = JSON.parse(round!.outcome_json!) as {
        kind: string;
        reason: string;
      };
      expect(outcome.kind).toBe('escalate');
      expect(outcome.reason).toContain('adl.yml');

      // The real commit is still on the audit trail — ROLE-11 hard-fails the
      // round, it does not pretend the developer never committed.
      const events = await featuresRepository(db).listEvents(seeded.feature.id);
      expect(events.map((event) => event.event_json)).toEqual([
        JSON.stringify({ t: 'workspace_ready' }),
        JSON.stringify({ t: 'dev_committed', sha: 'deadbee' }),
        expect.stringContaining('"t":"unrecoverable"') as unknown as string,
      ]);

      // A completed round, not a crash — the counter resets exactly as it
      // does for any other round that reached an outcome.
      expect(row.crash_count).toBe(0);
      expect(row.lease_token).toBeNull();
    });
  });

  it('hard-fails a round whose commit touched a maintainer-configured protected path', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, {
        effective_config_json: snapshot(['develop', 'test'], 6, ['tests/**']),
      });

      await report(db, seeded, 0, 'develop', committed('deadbee'), {
        git: stubGitClient(() => Promise.resolve(['tests/widgets.spec.ts'])),
      });

      expect((await reload(db, seeded.feature.id)).state).toBe('escalated');
    });
  });

  it('never protects a spec folder or test path the developer did not touch', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db);

      await report(db, seeded, 0, 'develop', committed('deadbee'), {
        git: stubGitClient(() => Promise.resolve(['src/app.ts'])),
      });

      // An ordinary, unrelated diff advances exactly as it would with no
      // protected-path check at all — the same shape the first test in this
      // file asserts.
      const row = await reload(db, seeded.feature.id);
      expect(row.state).toBe('gating');
      expect(row.current_stage_index).toBe(1);
      expect(row.lease_token).toBeNull();
    });
  });

  it('retries rather than judging, when the diff itself cannot be computed', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, { crash_count: 0 });

      const { roundId } = await report(
        db,
        seeded,
        0,
        'develop',
        committed('deadbee'),
        {
          git: stubGitClient(() =>
            Promise.reject(new Error('git diff exploded')),
          ),
        },
      );

      const row = await reload(db, seeded.feature.id);
      // Routed through the same crash-recovery path a retryable stage error
      // takes — never a fail-open "no violation found" and never a round
      // spent on an infrastructure problem.
      expect(row.state).toBe('queued');
      expect(row.crash_count).toBe(1);

      const round = await db
        .selectFrom('rounds')
        .selectAll()
        .where('id', '=', roundId)
        .executeTakeFirst();
      expect(round?.outcome).toBeNull();
    });
  });
});

describe('the round loop — stalemate detection (LOOP-06, M06 step 6.6)', () => {
  const recurringFinding = {
    fingerprint: 'e'.repeat(64),
    severity: 'blocker' as const,
    title: 'the same thing keeps failing',
    detail: 'npm test exited 1',
    criterionRef: CRITERION,
  };

  it('sends back on a finding’s first occurrence — under the threshold, ordinary handling', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, {
        state: 'gating',
        current_stage_index: 1,
        effective_config_json: snapshot(['develop', 'test'], 6, [], 2),
      });

      const { roundId } = await report(
        db,
        seeded,
        1,
        'test',
        gateVerdict({
          outcome: 'send_back',
          summary: 'changes required',
          findings: [recurringFinding],
        }),
      );

      const row = await reload(db, seeded.feature.id);
      // The finding has occurred once — under `repeat_finding_threshold: 2`
      // — so this is `planRoundStep`'s own ordinary decision, not LOOP-06's
      // override.
      expect(row.state).toBe('developing');

      const round = await db
        .selectFrom('rounds')
        .selectAll()
        .where('id', '=', roundId)
        .executeTakeFirst();
      expect(round?.outcome).toBe('send_back');
    });
  });

  it('escalates once a finding has recurred repeat_finding_threshold times, never sending back again', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, {
        state: 'gating',
        current_stage_index: 1,
        effective_config_json: snapshot(['develop', 'test'], 6, [], 2),
      });

      // Round 1: the finding's first occurrence.
      await report(
        db,
        seeded,
        1,
        'test',
        gateVerdict({
          outcome: 'send_back',
          summary: 'changes required',
          findings: [recurringFinding],
        }),
      );
      expect((await reload(db, seeded.feature.id)).state).toBe('developing');

      // Round 2's developer commits again, reaching the same gate stage —
      // `openAttempt` opens a fresh round since round 1's own is closed.
      await report(db, seeded, 0, 'develop', committed('feed000'));
      expect((await reload(db, seeded.feature.id)).state).toBe('gating');

      // Round 2's gate reports the identical finding — its second
      // occurrence, which meets the threshold this feature was leased under.
      const { roundId } = await report(
        db,
        seeded,
        1,
        'test',
        gateVerdict({
          outcome: 'send_back',
          summary: 'changes required',
          findings: [recurringFinding],
        }),
      );

      const row = await reload(db, seeded.feature.id);
      expect(row.state).toBe('escalated');

      const round = await db
        .selectFrom('rounds')
        .selectAll()
        .where('id', '=', roundId)
        .executeTakeFirst();
      // `stalemateStep` overrides `planRoundStep`'s own `aggregate()`-driven
      // decision — this round closes as `escalate`, not the `send_back` its
      // own gate verdict would ordinarily have produced.
      expect(round?.outcome).toBe('escalate');
      const outcome = JSON.parse(round!.outcome_json!) as {
        kind: string;
        reason: string;
      };
      expect(outcome.kind).toBe('escalate');
      expect(outcome.reason).toContain('stalemate');
      expect(outcome.reason).toContain('the same thing keeps failing');

      // A completed round, not a crash.
      expect(row.crash_count).toBe(0);
      expect(row.lease_token).toBeNull();
    });
  });

  it('never checks a warn verdict — only send_back consumes a round', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      // A three-stage pipeline so the `warn` below lands on a *non-last*
      // gate — it neither stops the pipeline (`stopsPipeline` is false for
      // `warn`) nor closes the round on its own, so this test's assertion
      // rests only on whether LOOP-06 was ever consulted, not on what
      // `aggregate()` would have decided had the round actually closed.
      const seeded = await seedFeature(db, {
        state: 'gating',
        current_stage_index: 1,
        effective_config_json: snapshot(
          ['develop', 'review', 'test'],
          6,
          [],
          1,
        ),
      });

      // `repeat_finding_threshold: 1` — the most aggressive setting there is
      // — and a single `warn` carrying this finding. If `warn` were checked
      // the same as `send_back`, this would already escalate on its first
      // appearance; it must not, because a `warn` never consumes a round.
      await report(
        db,
        seeded,
        1,
        'review',
        gateVerdict({
          outcome: 'warn',
          summary: 'non-blocking observation',
          findings: [recurringFinding],
        }),
      );

      const row = await reload(db, seeded.feature.id);
      expect(row.state).toBe('gating');
      expect(row.current_stage_index).toBe(2);
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

  /**
   * LOOP-07 (M06 step 6.7).
   *
   * Before this step every retryable stage error was routed through `reapOne`,
   * so a provider outage recovered to `queued` **and incremented
   * `crash_count`** — sharing a three-attempt ceiling with real worker
   * crashes, and resetting `current_stage_index` to 0, which on a gate failure
   * re-runs the developer agent. Both of those contradict LOOP-07's "consumes
   * neither a round nor budget": re-running the developer is real spend, and
   * escalating for the provider's downtime tells a human something untrue
   * about their code.
   */
  describe('transient provider failures (LOOP-07)', () => {
    it('resumes the same stage, spending no crash, no round and no stage index', async () => {
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
        // The state is deliberately untouched. `listDispatchable()` picks up
        // an unleased `developing`/`gating` row, so handing the lease back and
        // changing nothing else re-runs the stage that broke, at the index it
        // broke at, under the configuration it was admitted under.
        expect(row.state).toBe('gating');
        expect(row.current_stage_index).toBe(1);
        expect(row.lease_token).toBeNull();
        // The header property: a provider outage is not the feature crashing.
        expect(row.crash_count).toBe(0);
        expect(row.round).toBe(seeded.feature.round);

        const round = await db
          .selectFrom('rounds')
          .selectAll()
          .where('id', '=', roundId)
          .executeTakeFirst();
        // Nothing was judged, so there is no round outcome to record (CORE-06).
        expect(round?.outcome).toBeNull();
      });
    });

    it('requeues a failure that broke before the feature entered the loop, still without a crash', async () => {
      await withTempDb(async ({ db }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);
        // Still `leased`: nothing has applied `workspace_ready` yet, and
        // `listDispatchable()` does not include `leased` — so handing the
        // lease back here would strand the row where neither a dispatch nor
        // the reaper could see it again.
        const seeded = await seedFeature(db, {
          state: 'leased',
          current_stage_index: 0,
          crash_count: 0,
        });

        await report(
          db,
          seeded,
          0,
          'develop',
          stageError('timeout', 'the provider timed out'),
        );

        const row = await reload(db, seeded.feature.id);
        expect(row.state).toBe('queued');
        expect(row.current_stage_index).toBe(0);
        expect(row.lease_token).toBeNull();
        expect(row.crash_count).toBe(0);
      });
    });

    it('escalates once the transient budget is spent, rather than waiting forever', async () => {
      await withTempDb(async ({ db }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);
        const seeded = await seedFeature(db, {
          state: 'gating',
          current_stage_index: 1,
          crash_count: 0,
        });
        // One short of the ceiling already on record, so the failure reported
        // below is the one that reaches it. Derived from the exported ceiling
        // rather than restating the number (rule 8).
        await seedAttemptHistory(
          db,
          seeded.feature.id,
          transientRun(MAX_CONSECUTIVE_TRANSIENT_FAILURES - 1),
        );

        const { roundId } = await report(
          db,
          seeded,
          1,
          'review',
          stageError('provider_error', '503 from the provider'),
        );

        const row = await reload(db, seeded.feature.id);
        expect(row.state).toBe('escalated');
        // Escalating on the transient budget still never touches the crash
        // ceiling — the two counters stay independent in both directions.
        expect(row.crash_count).toBe(0);

        const round = await db
          .selectFrom('rounds')
          .selectAll()
          .where('id', '=', roundId)
          .executeTakeFirst();
        expect(round?.outcome).toBe('escalate');
        expect(round?.outcome_json).toContain('transient-failure ceiling');
      });
    });

    it('does not accumulate across an attempt that judged — the count is consecutive', async () => {
      await withTempDb(async ({ db }) => {
        await migrateToLatest(db, MIGRATIONS_DIR);
        const seeded = await seedFeature(db, {
          state: 'gating',
          current_stage_index: 1,
          crash_count: 0,
        });
        // Far past the ceiling in total, but the newest attempt on record
        // judged — so the run is broken and the count starts again. A feature
        // that hits one rate limit per round, forever, is making progress and
        // must never accumulate its way to an escalation.
        await seedAttemptHistory(db, seeded.feature.id, [
          ...transientRun(MAX_CONSECUTIVE_TRANSIENT_FAILURES + 3),
          { status: 'verdict', errorKind: null },
        ]);

        await report(
          db,
          seeded,
          1,
          'review',
          stageError('provider_error', '503 from the provider'),
        );

        const row = await reload(db, seeded.feature.id);
        expect(row.state).toBe('gating');
        expect(row.crash_count).toBe(0);
      });
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

/**
 * LOOP-08 (M06 step 6.8) — the round loop's half of "escalation posts to the
 * pull request".
 *
 * Before this step the only thing that ever published was a real commit
 * (`onDeveloperCommitted`), so every escalation the loop produces closed its
 * round in the database and put nothing anywhere a reviewer would look. The
 * two properties worth the most:
 *
 * 1. **The trigger is the state the feature reached, not the outcome kind.**
 *    A round that hits the round ceiling closes as `send_back` and lands in
 *    `escalated`, because `transition()` diverts the edge (LOOP-03, step 6.2).
 *    A condition written over `RoundOutcome` passes every other test in this
 *    block and silently misses the first limit LOOP-08 names.
 * 2. **A round that did not escalate posts nothing** — the negative half, and
 *    the one that stops this from becoming the comment spam FORGE-06 exists to
 *    prevent.
 */
describe('the round loop — escalation posts to the change request (LOOP-08)', () => {
  /** The escalation comment on this feature's change request, if one exists. */
  async function escalationComment(
    featureId: string,
  ): Promise<string | undefined> {
    const open = await forge.listOpenChangeRequests(FORGE_REPO);
    const cr = open.find((candidate) => candidate.head.includes(featureId));
    if (cr === undefined) return undefined;
    const comments = server.state.commentsByIssue.get(cr.number) ?? [];
    return comments.find((comment) =>
      comment.body.includes('<!-- adl:role=escalation -->'),
    )?.body;
  }

  it('posts the escalation when a gate’s verdict escalates the round', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, {
        state: 'gating',
        current_stage_index: 2,
      });
      // A round that committed, so a branch (and therefore a change request)
      // exists for the escalation to land on.
      await db
        .updateTable('rounds')
        .set({ head_sha: 'deadbee' })
        .where('feature_id', '=', seeded.feature.id)
        .execute();
      const attempt = await openAttempt(
        { db },
        { featureId: seeded.feature.id, stageId: 'develop', stageIndex: 0 },
      );
      await featuresRepository(db).recordRoundHeadSha({
        id: attempt.roundId,
        headSha: 'deadbee',
      });

      await report(
        db,
        seeded,
        2,
        'test',
        gateVerdict({
          outcome: 'fail',
          summary: 'cannot proceed',
          reason: 'the harness will never pass with this schema',
        }),
        { withForge: true },
      );

      expect((await reload(db, seeded.feature.id)).state).toBe('escalated');
      const body = await escalationComment(seeded.feature.id);
      expect(body).toContain('Escalated');
      expect(body).toContain('the harness will never pass with this schema');
    });
  });

  it('posts the escalation when the ROUND CEILING diverts a send_back', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      // `maxRounds` of 1 with the feature already on round 1: the send-back
      // below would hand out round 2, so `transition()` escalates instead.
      const seeded = await seedFeature(db, {
        state: 'gating',
        current_stage_index: 2,
        effective_config_json: snapshot(['develop', 'review', 'test'], 1),
      });
      const attempt = await openAttempt(
        { db },
        { featureId: seeded.feature.id, stageId: 'develop', stageIndex: 0 },
      );
      await featuresRepository(db).recordRoundHeadSha({
        id: attempt.roundId,
        headSha: 'deadbee',
      });

      const { roundId } = await report(
        db,
        seeded,
        2,
        'test',
        gateVerdict({
          outcome: 'send_back',
          summary: 'not yet',
          findings: [
            {
              fingerprint: 'e'.repeat(64),
              severity: 'blocker',
              title: 'still red',
              detail: 'x',
              criterionRef: CRITERION,
            },
          ],
        }),
        { withForge: true },
      );

      // The round closed as `send_back` — its own decision was to send back —
      // and the feature is nonetheless escalated. That divergence is the whole
      // reason the publish trigger reads the state rather than the outcome.
      const round = await db
        .selectFrom('rounds')
        .selectAll()
        .where('id', '=', roundId)
        .executeTakeFirst();
      expect(round?.outcome).toBe('send_back');
      expect((await reload(db, seeded.feature.id)).state).toBe('escalated');

      const body = await escalationComment(seeded.feature.id);
      expect(body).toContain('Escalated');
      expect(body).toContain('the round limit was reached');
      expect(body).toContain('1 finding');
    });
  });

  it('posts nothing for a round that sent back normally', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);
      const seeded = await seedFeature(db, {
        state: 'gating',
        current_stage_index: 2,
      });
      const attempt = await openAttempt(
        { db },
        { featureId: seeded.feature.id, stageId: 'develop', stageIndex: 0 },
      );
      await featuresRepository(db).recordRoundHeadSha({
        id: attempt.roundId,
        headSha: 'deadbee',
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
              fingerprint: 'f'.repeat(64),
              severity: 'blocker',
              title: 'still red',
              detail: 'x',
              criterionRef: CRITERION,
            },
          ],
        }),
        { withForge: true },
      );

      // The loop working as designed is not an escalation, and must not read
      // as one on the pull request.
      expect((await reload(db, seeded.feature.id)).state).toBe('developing');
      expect(await escalationComment(seeded.feature.id)).toBe(undefined);
    });
  });
});
