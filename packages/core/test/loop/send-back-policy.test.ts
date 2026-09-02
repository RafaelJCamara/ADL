import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COST_CLASS,
  costClassOf,
  onSendBackFor,
} from '../../src/loop/send-back-policy.js';
import {
  BUILT_IN_STAGE_IDS,
  type ResolvedStage,
} from '../../src/config/pipeline.js';

/**
 * The `on_send_back` policy (HARN-03, M07 step 7.2).
 *
 * The property that matters most is the **conservative default**: a build that
 * knows nothing about a stage must behave exactly as v1 did — stop on the first
 * `send_back` — so nothing changes for an adopter until either ADL ships a gate
 * it has priced or a maintainer writes `on_send_back` themselves. Everything
 * else here is that default being deliberately relaxed.
 */

function stage(overrides: Partial<ResolvedStage> = {}): ResolvedStage {
  return { id: 'test', source: 'built-in', ...overrides };
}

describe('costClassOf', () => {
  it('prices every built-in, so none of them falls through to the default', () => {
    // The vacuity control for the compile-time pairing in the source: a
    // `BUILT_IN_COST_CLASSES` that lost an entry would still compile if the
    // frozen list lost the same one, and this reads the list from outside.
    for (const id of BUILT_IN_STAGE_IDS) {
      expect(
        costClassOf(stage({ id })),
        `built-in stage "${id}" has no declared cost class`,
      ).toBeDefined();
    }
    expect(costClassOf(stage({ id: 'test' }))).toBe('cheap');
    expect(costClassOf(stage({ id: 'review' }))).toBe('expensive');
  });

  it('treats a harness this build did not supply as expensive', () => {
    // M13's tiers — an npm package and a repo-relative path. ADL has never seen
    // either and must not guess that they are cheap to re-run.
    expect(costClassOf(stage({ id: 'semgrep', source: 'npm' }))).toBe(
      DEFAULT_COST_CLASS,
    );
    expect(
      costClassOf(stage({ id: './gates/audit.js', source: 'repo-path' })),
    ).toBe(DEFAULT_COST_CLASS);
    expect(DEFAULT_COST_CLASS).toBe('expensive');
  });

  it('does not let a repo-path harness inherit a built-in’s price by naming itself after it', () => {
    // `id` is chosen by whoever wrote `adl.yml`; only `source: 'built-in'`
    // means ADL supplied the implementation. A harness at `./test` calling
    // itself `test` must not be assumed as cheap as the command gate.
    expect(costClassOf(stage({ id: 'test', source: 'repo-path' }))).toBe(
      'expensive',
    );
  });
});

describe('onSendBackFor', () => {
  it('defaults a cheap built-in to continue, so its findings merge with the next gate’s', () => {
    expect(onSendBackFor(stage({ id: 'test' }))).toBe('continue');
  });

  it('defaults an expensive built-in to stop, so nobody pays an agent to review doomed code', () => {
    expect(onSendBackFor(stage({ id: 'review' }))).toBe('stop');
  });

  it('defaults an unknown harness to stop — byte-identical to pre-7.2 behaviour', () => {
    // The property an adopter actually feels: upgrading into 7.2 changes
    // nothing about a pipeline made of harnesses ADL cannot price.
    expect(onSendBackFor(stage({ id: 'semgrep', source: 'npm' }))).toBe('stop');
  });

  it('lets an explicit adl.yml value win in BOTH directions', () => {
    // Not a ceiling. Unlike `limits`, where a repository may only lower the
    // daemon's value, this is a pipeline-shape decision and the pipeline is
    // already the repository's to write — so `continue` on an expensive gate is
    // permitted, not clamped.
    expect(onSendBackFor(stage({ id: 'review', onSendBack: 'continue' }))).toBe(
      'continue',
    );
    expect(onSendBackFor(stage({ id: 'test', onSendBack: 'stop' }))).toBe(
      'stop',
    );
  });
});
