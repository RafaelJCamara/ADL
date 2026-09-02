import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as PluginSdk from '../src/index.js';
import * as CoreStage from '@adl/core/stage';
import * as CoreVerdict from '@adl/core/verdict';

/** The package's only source file, read as text by the redeclaration guard below. */
const SDK_SOURCE = fileURLToPath(new URL('../src/index.ts', import.meta.url));

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
    [
      'CriterionRefSchema',
      PluginSdk.CriterionRefSchema,
      CoreVerdict.CriterionRefSchema,
    ],
    ['WaiverSchema', PluginSdk.WaiverSchema, CoreVerdict.WaiverSchema],
    [
      'StageErrorSchema',
      PluginSdk.StageErrorSchema,
      CoreStage.StageErrorSchema,
    ],
  ])(
    '%s is the same object as the one @adl/core exports',
    (_name, fromSdk, fromCore) => {
      expect(fromSdk).toBe(fromCore);
    },
  );

  it.each([
    [
      'AGENT_EVENT_KINDS',
      PluginSdk.AGENT_EVENT_KINDS,
      CoreStage.AGENT_EVENT_KINDS,
    ],
    [
      'AgentCapabilitiesSchema',
      PluginSdk.AgentCapabilitiesSchema,
      CoreStage.AgentCapabilitiesSchema,
    ],
    [
      'StartedEventSchema',
      PluginSdk.StartedEventSchema,
      CoreStage.StartedEventSchema,
    ],
    ['TextEventSchema', PluginSdk.TextEventSchema, CoreStage.TextEventSchema],
    [
      'ThinkingEventSchema',
      PluginSdk.ThinkingEventSchema,
      CoreStage.ThinkingEventSchema,
    ],
    [
      'ToolCallEventSchema',
      PluginSdk.ToolCallEventSchema,
      CoreStage.ToolCallEventSchema,
    ],
    [
      'ToolResultEventSchema',
      PluginSdk.ToolResultEventSchema,
      CoreStage.ToolResultEventSchema,
    ],
    [
      'AgentUsageSchema',
      PluginSdk.AgentUsageSchema,
      CoreStage.AgentUsageSchema,
    ],
    [
      'UsageEventSchema',
      PluginSdk.UsageEventSchema,
      CoreStage.UsageEventSchema,
    ],
    [
      'AGENT_RESULT_OUTCOMES',
      PluginSdk.AGENT_RESULT_OUTCOMES,
      CoreStage.AGENT_RESULT_OUTCOMES,
    ],
    [
      'AgentResultOutcomeSchema',
      PluginSdk.AgentResultOutcomeSchema,
      CoreStage.AgentResultOutcomeSchema,
    ],
    [
      'ResultEventSchema',
      PluginSdk.ResultEventSchema,
      CoreStage.ResultEventSchema,
    ],
    [
      'ErrorEventSchema',
      PluginSdk.ErrorEventSchema,
      CoreStage.ErrorEventSchema,
    ],
    [
      'AgentEventSchema',
      PluginSdk.AgentEventSchema,
      CoreStage.AgentEventSchema,
    ],
    ['AgentTaskSchema', PluginSdk.AgentTaskSchema, CoreStage.AgentTaskSchema],
    [
      'AgentRunResultSchema',
      PluginSdk.AgentRunResultSchema,
      CoreStage.AgentRunResultSchema,
    ],
    [
      'AgentProbeSchema',
      PluginSdk.AgentProbeSchema,
      CoreStage.AgentProbeSchema,
    ],
    [
      'TranscriptRecordSchema',
      PluginSdk.TranscriptRecordSchema,
      CoreStage.TranscriptRecordSchema,
    ],
  ])(
    '%s (the AgentRunner surface, Phase 4) is the same object as the one @adl/core exports',
    (_name, fromSdk, fromCore) => {
      expect(fromSdk).toBe(fromCore);
    },
  );

  it('re-exports the gate contract’s member lists by reference (M07 step 7.1)', () => {
    // `GateContext` replaced `StageContext` as the published gate contract, and
    // its two member lists are the only *runtime* values in it — everything
    // else on the type erases. They are worth publishing rather than keeping
    // internal: a third-party harness can assert on the contract it was handed
    // instead of trusting a docblock, and ROLE-03's guarantee stops being
    // something a harness author has to take on faith.
    expect(PluginSdk.GATE_CONTEXT_MEMBERS).toBe(CoreStage.GATE_CONTEXT_MEMBERS);
    expect(PluginSdk.GATE_DIFF_MEMBERS).toBe(CoreStage.GATE_DIFF_MEMBERS);
  });

  it('no longer publishes StageContext or its forward declarations (M07 step 7.1)', async () => {
    // Stated as a prohibition rather than left as an absence. `StageContext`
    // and its four never-supplied placeholders — `FeatureView`, `StageConfig`,
    // `ArtifactSink`, `RoundSummary` — were exported from this package for six
    // milestones, and re-adding one would republish a hypothesis into the
    // third-party surface alongside the type that replaced it. They erase at
    // runtime, so the source text is what can be read.
    const source = await readFile(SDK_SOURCE, 'utf8');
    for (const retired of [
      'StageContext',
      'FeatureView',
      'ArtifactSink',
      'RoundSummary',
    ]) {
      expect(
        source.includes(`type ${retired},`),
        `@adl/plugin-sdk re-exports ${retired}, which M07 step 7.1 retired.`,
      ).toBe(false);
    }
  });

  it('re-exports NETWORK_POLICIES by reference, not as a copy of the tuple', () => {
    // The one runtime value in the workspace surface. A `toEqual` here would
    // pass against `Object.freeze(['full', 'none', 'allowlist'])` written out a
    // second time in this package, which is exactly the duplication the package
    // exists to prevent — and the copy would then silently keep the old
    // membership on the day the container backend adds a policy.
    expect(PluginSdk.NETWORK_POLICIES).toBe(CoreStage.NETWORK_POLICIES);
  });

  it('declares no type of its own — every export is a re-export', async () => {
    // The workspace types erase at runtime, so no `toBe` can reach them: a
    // redeclared `interface Workspace` with today's shape would satisfy every
    // assertion above and every typecheck, and would then drift the first time
    // @adl/core changed. What IS checkable is that this package declares
    // nothing — its whole source is `export { ... } from '@adl/core/*'`.
    const source = await readFile(SDK_SOURCE, 'utf8');
    // Strip block comments so prose about interfaces cannot trip the guard.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');

    const declarations = [
      ...code.matchAll(
        /^\s*(?:export\s+)?(?:declare\s+)?(interface|class|enum)\s+(\w+)/gm,
      ),
      // `export type X = ...` is a declaration; `export { type X } from '...'`
      // and `export type { X } from '...'` are re-exports and must not match.
      ...code.matchAll(/^\s*export\s+type\s+(\w+)\s*=/gm),
    ].map((match) => match[0].trim());

    expect(declarations).toEqual([]);
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
