import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FEATURE_STATES } from '../../src/state/feature-state.js';
import {
  resolvePipeline,
  type HarnessRegistry,
} from '../../src/config/pipeline.js';

/**
 * The mechanical proof EXEC-07 rests on (01-RESEARCH.md § Code Examples 5,
 * ARCHITECTURE.md §2): adding a gate to the pipeline is a configuration
 * change, position is a list index, and neither the lifecycle transition
 * function nor the migration set has to move for it.
 *
 * This file necessarily reads files — hashing `transition.ts`, counting
 * `packages/db/migrations/`, and scanning the migration sources' text — which
 * is exactly why it lives under `test/`, not `src/`: plan 01-03's purity
 * rule scopes to `src/**`, and the proof of a purity-adjacent property
 * necessarily touches the filesystem. Do not "fix" this by moving it.
 *
 * `@adl/core` declares no dependency on `@adl/db` (D-28) — the migration
 * cross-check below reads `packages/db/migrations/*.ts` as plain text, never
 * by importing `@adl/db`.
 */

const TRANSITION_PATH = fileURLToPath(
  new URL('../../src/state/transition.ts', import.meta.url),
);
const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../db/migrations', import.meta.url),
);

function hashTransitionModule(): string {
  return createHash('sha256')
    .update(readFileSync(TRANSITION_PATH))
    .digest('hex');
}

function migrationFileNames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.endsWith('.d.ts'))
    .sort();
}

function readAllMigrationsText(): string {
  return migrationFileNames()
    .map((f) => readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8'))
    .join('\n---\n');
}

function registryWithSecurityHarness(): HarnessRegistry {
  return {
    builtIns: new Set(['develop', 'review', 'test']),
    npmPackages: new Set(),
    repoPaths: new Set(['security']),
  };
}

describe('EXEC-07 — adding a gate stage changes neither transition() nor the migration set', () => {
  it('resolving a longer pipeline leaves transition.ts and the migration count untouched', () => {
    const transitionHashBefore = hashTransitionModule();
    const migrationCountBefore = migrationFileNames().length;

    const three = resolvePipeline(
      ['develop', 'review', 'test'],
      registryWithSecurityHarness(),
    );
    const four = resolvePipeline(
      ['develop', 'review', { harness: 'security' }, 'test'],
      registryWithSecurityHarness(),
    );

    // The added stage is a list index, never a state:
    expect(four).toHaveLength(three.length + 1);
    expect(new Set(four.map((s) => s.id)).size).toBe(four.length);

    // Self-relative comparisons — before vs. after, within this run — so a
    // legitimate migration another plan adds in the same wave cannot make
    // this test fail for the wrong reason.
    expect(hashTransitionModule()).toBe(transitionHashBefore);
    expect(migrationFileNames().length).toBe(migrationCountBefore);
  });
});

describe('EXEC-07 — the state-machine persistence contract seam (plans 01-09 and 01-02/01-10)', () => {
  /**
   * A cheap textual guard, standing in for a schema-level one until Phase 3
   * has a running daemon to assert against. `FEATURE_STATES` and the
   * `features` table's own state enumeration were written by different
   * plans in different waves; nothing else in the repository checks that
   * they agree.
   */
  const migrationsText = readAllMigrationsText();

  // Matches `check (state in ('a', 'b', ...))` however it is wrapped across
  // lines — the constraint 01-08 added in `0004_feature_state_constraint.ts`.
  const STATE_CHECK_PATTERN =
    /state\s+text\s+not\s+null\s+check\s*\(\s*state\s+in\s*\(([^)]*)\)\)/;

  it('a state CHECK constraint on the features table exists in the migration sources', () => {
    expect(migrationsText).toMatch(STATE_CHECK_PATTERN);
  });

  it('every literal in FEATURE_STATES appears in the features-table state constraint', () => {
    const match = STATE_CHECK_PATTERN.exec(migrationsText);
    expect(
      match,
      'no features.state CHECK constraint found in packages/db/migrations/',
    ).not.toBeNull();
    const constraintText = match![1] ?? '';

    for (const state of FEATURE_STATES) {
      expect(
        constraintText.includes(`'${state}'`),
        `FEATURE_STATES contains "${state}", which is missing from the features.state CHECK constraint`,
      ).toBe(true);
    }
  });

  it('no state appears in the constraint that is absent from FEATURE_STATES', () => {
    const match = STATE_CHECK_PATTERN.exec(migrationsText);
    expect(match).not.toBeNull();
    const constraintText = match![1] ?? '';

    const constraintStates = [...constraintText.matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    expect(constraintStates.length).toBeGreaterThan(0);

    for (const state of constraintStates) {
      expect(
        (FEATURE_STATES as readonly string[]).includes(
          state as (typeof FEATURE_STATES)[number],
        ),
        `the features.state CHECK constraint names "${state}", which is absent from FEATURE_STATES`,
      ).toBe(true);
    }
  });

  it('a state_version column is declared on the features table', () => {
    expect(migrationsText).toMatch(/state_version\s+integer\s+not\s+null/);
  });
});
