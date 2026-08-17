import { describe, expect, it } from 'vitest';

import * as PluginSdk from '../src/index.js';
import * as CoreStage from '@adl/core/stage';
import * as CoreVerdict from '@adl/core/verdict';

/**
 * Reference identity, not structural equality.
 *
 * `toEqual` would pass just as happily against a duplicated definition, which is
 * the exact failure this package exists to prevent. `toBe` passes only if both
 * import paths reach the *same object* — that is, only if `@adl/plugin-sdk`
 * really is re-exporting rather than redeclaring.
 */
describe('@adl/plugin-sdk re-exports @adl/core by reference', () => {
  it.each([
    ['VerdictSchema', PluginSdk.VerdictSchema, CoreVerdict.VerdictSchema],
    ['FindingSchema', PluginSdk.FindingSchema, CoreVerdict.FindingSchema],
    ['CriterionRefSchema', PluginSdk.CriterionRefSchema, CoreVerdict.CriterionRefSchema],
    ['WaiverSchema', PluginSdk.WaiverSchema, CoreVerdict.WaiverSchema],
    ['StageErrorSchema', PluginSdk.StageErrorSchema, CoreStage.StageErrorSchema],
  ])('%s is the same object as the one @adl/core exports', (_name, fromSdk, fromCore) => {
    expect(fromSdk).toBe(fromCore);
  });

  it('re-exports functions by reference too', () => {
    expect(PluginSdk.consumesRound).toBe(CoreVerdict.consumesRound);
    expect(PluginSdk.fingerprintFinding).toBe(CoreVerdict.fingerprintFinding);
    expect(PluginSdk.stageErrorPolicy).toBe(CoreStage.stageErrorPolicy);
    expect(PluginSdk.isStageError).toBe(CoreStage.isStageError);
  });

  it('defines no schema of its own', () => {
    // Every runtime value the package exports must be traceable to @adl/core.
    // A value present here but in neither core barrel is, by definition, a
    // second definition of something.
    const coreValues = new Set<unknown>([
      ...Object.values(CoreVerdict),
      ...Object.values(CoreStage),
    ]);

    const orphans = Object.entries(PluginSdk)
      .filter(([, value]) => !coreValues.has(value))
      .map(([name]) => name);

    expect(orphans).toEqual([]);
  });

  it('publishes a usable surface — a harness can validate a verdict with it', () => {
    // The point of the package, exercised end to end through its own exports.
    const verdict = PluginSdk.VerdictSchema.parse({
      outcome: 'pass',
      summary: 'the licence scan found no incompatible dependency',
      checked: [{ kind: 'global', category: 'security' }],
    });

    expect(PluginSdk.consumesRound(verdict)).toBe(false);

    const broken = PluginSdk.StageErrorSchema.parse({
      kind: 'binary_missing',
      retryable: false,
      detail: 'semgrep is not installed on the worker',
    });

    // A broken gate is not a verdict, and never costs a round.
    expect(PluginSdk.VerdictSchema.safeParse(broken).success).toBe(false);
    expect(PluginSdk.stageErrorPolicy(broken.kind).consumesRound).toBe(false);
  });
});
