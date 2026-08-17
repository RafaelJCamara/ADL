import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';

import { loadAdlTemplateSpec } from '@adl/core/spec';
import { aggregate, VerdictSchema, type Verdict } from '@adl/core/verdict';

import { migrateToLatest } from '../src/index.js';
import { MIGRATIONS_DIR, withTempDb } from './helpers/temp-db.js';

/**
 * The last leg of the tracer: the spine ends in persistence rather than in
 * memory.
 *
 * This lives in `@adl/db` rather than in `@adl/core`'s suite on purpose.
 * `@adl/core` must not depend on `@adl/db` — it never learns a database exists
 * (D-28) — and a test importing `@adl/db` from inside the core package would
 * cross exactly the dependency edge the lint rule in plan 01-03 forbids. The
 * loader is reached through the published `@adl/core/spec` subpath, which also
 * proves the export map resolves.
 */
const FIXTURE_PATH = fileURLToPath(
  new URL('../../core/test/fixtures/spec/good/spec.md', import.meta.url),
);
const RAW = readFileSync(FIXTURE_PATH, 'utf8');

const NOW = '2026-08-17T12:00:00.000Z';

describe('spine: spec -> verdicts -> round outcome -> persisted rows', () => {
  it('round-trips the spec hash and the round outcome through a real SQLite file', async () => {
    const spec = loadAdlTemplateSpec(RAW, 'feature-branch-cleanup');
    expect(spec.acceptanceCriteria.length).toBeGreaterThanOrEqual(3);

    const verdicts: Verdict[] = [
      VerdictSchema.parse({
        outcome: 'pass',
        summary: 'Every acceptance criterion is implemented and covered.',
        checked: spec.acceptanceCriteria.map((c) => ({ kind: 'criterion', id: c.id })),
      }),
      VerdictSchema.parse({
        outcome: 'skip',
        reason: 'No security harness is configured for this repository.',
      }),
    ];

    const outcome = aggregate(verdicts);
    expect(outcome.kind).toBe('green');

    await withTempDb(async ({ db }) => {
      const migration = await migrateToLatest(db, MIGRATIONS_DIR);
      expect(migration.error).toBeUndefined();

      const repoId = ulid();
      const featureId = ulid();

      await db
        .insertInto('repos')
        .values({
          id: repoId,
          remote_url: 'https://github.com/example/target-repo.git',
          default_branch: 'main',
          forge: 'github',
          features_dir: 'features',
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();

      await db
        .insertInto('features')
        .values({
          id: featureId,
          repo_id: repoId,
          path: `features/${spec.id}`,
          state: 'gating',
          state_version: 1,
          round: 1,
          current_stage_index: 2,
          // The value the loader produced, carried through unmodified.
          spec_hash: spec.specHash,
          effective_config_json: null,
          workspace_handle: null,
          lease_owner: null,
          lease_token: null,
          lease_expires_at: null,
          heartbeat_at: null,
          crash_count: 0,
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();

      await db
        .insertInto('feature_events')
        .values({
          id: ulid(),
          feature_id: featureId,
          seq: 1,
          from_state: 'gating',
          to_state: 'ready_for_pr',
          event_json: JSON.stringify({ kind: 'round_completed', outcome: outcome.kind }),
          actor: 'manager',
          at: NOW,
        })
        .execute();

      const feature = await db
        .selectFrom('features')
        .selectAll()
        .where('id', '=', featureId)
        .executeTakeFirstOrThrow();

      // Byte-identical, not merely equal-ish. The spec hash is the identity of
      // the spec revision a run was leased against; a hash that changed in
      // transit would silently mis-join every downstream artifact.
      expect(feature.spec_hash).toBe(spec.specHash);
      expect(feature.spec_hash).toHaveLength(64);
      expect(feature.state_version).toBe(1);

      const event = await db
        .selectFrom('feature_events')
        .selectAll()
        .where('feature_id', '=', featureId)
        .where('seq', '=', 1)
        .executeTakeFirstOrThrow();

      expect(JSON.parse(event.event_json)).toEqual({
        kind: 'round_completed',
        outcome: 'green',
      });
    });
  });

  it('refuses a second feature_event with the same sequence number', async () => {
    await withTempDb(async ({ db }) => {
      await migrateToLatest(db, MIGRATIONS_DIR);

      const repoId = ulid();
      const featureId = ulid();

      await db
        .insertInto('repos')
        .values({
          id: repoId,
          remote_url: 'https://github.com/example/target-repo.git',
          default_branch: 'main',
          forge: 'github',
          features_dir: 'features',
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();

      await db
        .insertInto('features')
        .values({
          id: featureId,
          repo_id: repoId,
          path: 'features/feature-branch-cleanup',
          state: 'queued',
          state_version: 1,
          round: 0,
          current_stage_index: 0,
          spec_hash: 'a'.repeat(64),
          effective_config_json: null,
          workspace_handle: null,
          lease_owner: null,
          lease_token: null,
          lease_expires_at: null,
          heartbeat_at: null,
          crash_count: 0,
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();

      const event = {
        feature_id: featureId,
        seq: 1,
        from_state: null,
        to_state: 'gating',
        event_json: '{}',
        actor: 'manager',
        at: NOW,
      };

      await db
        .insertInto('feature_events')
        .values({ id: ulid(), ...event })
        .execute();

      // The append-only log is only trustworthy if the sequence is unique per
      // feature — otherwise two workers racing could both claim round 1.
      await expect(
        db
          .insertInto('feature_events')
          .values({ id: ulid(), ...event })
          .execute(),
      ).rejects.toThrow(/UNIQUE/i);
    });
  });
});
