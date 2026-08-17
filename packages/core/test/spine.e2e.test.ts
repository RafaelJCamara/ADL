import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadAdlTemplateSpec } from '../src/spec/index.js';
import {
  aggregate,
  consumesRound,
  fingerprintFinding,
  VerdictSchema,
  type Verdict,
} from '../src/verdict/index.js';

/**
 * The tracer: one real ADL-template spec carried through every layer Phase 1
 * builds — parse, addressable criteria, six-outcome verdict validation, and
 * aggregation to a round outcome.
 *
 * This test is thin in *coverage*, not in quality. Plans 01-04 and 01-06 widen
 * each leg; this one proves the legs connect.
 *
 * `node:fs` appears here and nowhere in `packages/core/src/` — reading the file
 * is the caller's job, which is exactly the boundary this test demonstrates.
 */
const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/spec/good/spec.md', import.meta.url),
);
const RAW = readFileSync(FIXTURE_PATH, 'utf8');

describe('spine: spec.md -> criteria -> verdicts -> round outcome', () => {
  it('parses the ADL template into addressable AC-n criteria in document order', () => {
    const spec = loadAdlTemplateSpec(RAW, 'feature-branch-cleanup');

    expect(spec.sourceFormat).toBe('adl-template');
    expect(spec.title).toBe('Feature Branch Cleanup');
    expect(spec.id).toBe('feature-branch-cleanup');

    // Three top-level bullets, so three criteria — the two nested sub-bullets
    // under the second one are detail, not criteria of their own (D-19).
    expect(spec.acceptanceCriteria.map((c) => c.id)).toEqual([
      'AC-1',
      'AC-2',
      'AC-3',
    ]);

    const [ac1, ac2, ac3] = spec.acceptanceCriteria;
    expect(ac1?.kind).toBe('statement');
    expect(ac1?.text).toContain('reached a terminal state is removed');
    expect(ac2?.text).toContain(
      'never removes a worktree belonging to a feature',
    );
    expect(ac3?.text).toContain('--dry-run');

    // The nested bullets live INSIDE AC-2's text rather than beside it. This is
    // the assertion that would fail if the loader ever flattened nested lists,
    // which would renumber every criterion after it — and D-01 says renumbering
    // means re-running every agent prompt.
    expect(ac2?.text).toContain('An expired lease means the worker died');
    expect(ac2?.text).toContain(
      'Recovery re-attaches to the existing worktree',
    );
    expect(ac1?.text).not.toContain('An expired lease means the worker died');
    expect(ac3?.text).not.toContain('An expired lease means the worker died');
  });

  it('retains each criterion verbatim as a contiguous source slice, and raw unchanged', () => {
    const spec = loadAdlTemplateSpec(RAW, 'feature-branch-cleanup');

    // CORE-05: `raw` is always the verbatim source.
    expect(spec.raw).toBe(RAW);

    for (const criterion of spec.acceptanceCriteria) {
      if (criterion.kind !== 'statement') continue;

      // A byte-exact slice of the source — not a re-serialisation of the AST.
      // Re-serialising would lose inline formatting and whitespace, and the
      // textHash would then change when the serialiser changed rather than
      // when the author's meaning changed.
      const offset = RAW.indexOf(criterion.text);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(RAW.slice(offset, offset + criterion.text.length)).toBe(
        criterion.text,
      );
    }
  });

  it('validates six-outcome verdicts and aggregates a satisfied round to green', () => {
    const spec = loadAdlTemplateSpec(RAW, 'feature-branch-cleanup');
    const [ac1, ac2] = spec.acceptanceCriteria;
    expect(ac1).toBeDefined();
    expect(ac2).toBeDefined();

    const passVerdict: Verdict = VerdictSchema.parse({
      outcome: 'pass',
      summary:
        'Terminal-state worktrees are collected and running features are left alone.',
      checked: [
        { kind: 'criterion', id: ac1?.id },
        { kind: 'criterion', id: ac2?.id },
      ],
    });

    const warnVerdict: Verdict = VerdictSchema.parse({
      outcome: 'warn',
      summary: 'One non-blocking observation.',
      findings: [
        {
          fingerprint: fingerprintFinding({
            stageId: 'review',
            title: 'gc interval is hardcoded',
            location: { path: 'src/workspace/gc.ts' },
          }),
          severity: 'nit',
          title: 'gc interval is hardcoded',
          detail: 'The hourly interval should come from configuration.',
          criterionRef: { kind: 'global', category: 'code_quality' },
          location: { path: 'src/workspace/gc.ts', line: 12 },
        },
      ],
    });

    // Only send_back consumes a round — an honest exit is never charged for.
    expect(consumesRound(passVerdict)).toBe(false);
    expect(consumesRound(warnVerdict)).toBe(false);

    const outcome = aggregate([passVerdict, warnVerdict]);
    expect(outcome.kind).toBe('green');
  });

  it('is not green once any gate says it could not tell', () => {
    const spec = loadAdlTemplateSpec(RAW, 'feature-branch-cleanup');
    const [ac1] = spec.acceptanceCriteria;

    const passVerdict: Verdict = VerdictSchema.parse({
      outcome: 'pass',
      summary: 'Terminal-state worktrees are collected.',
      checked: [{ kind: 'criterion', id: ac1?.id }],
    });

    // The same round as above, with the warn swapped for an inconclusive: the
    // behaviour tester could not start the app, so it does not know whether the
    // criteria hold. This is the case the entire project exists to get right —
    // "we could not tell" must never render as "verified".
    const inconclusiveVerdict: Verdict = VerdictSchema.parse({
      outcome: 'inconclusive',
      summary: 'Could not exercise the gc pass.',
      reason: 'The app did not become ready within the readiness timeout.',
    });

    const outcome = aggregate([passVerdict, inconclusiveVerdict]);

    expect(outcome.kind).not.toBe('green');
    expect(outcome.kind).toBe('unverified');
    if (outcome.kind === 'unverified') {
      expect(outcome.inconclusive).toHaveLength(1);
      expect(outcome.inconclusive[0]?.reason).toContain('readiness timeout');
    }

    // And it stays not-green regardless of where the inconclusive sits.
    expect(aggregate([inconclusiveVerdict, passVerdict]).kind).not.toBe(
      'green',
    );
  });

  it('rejects a seventh outcome, naming the six that exist', () => {
    const result = VerdictSchema.safeParse({
      outcome: 'approved',
      summary: 'looks fine',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue?.code).toBe('invalid_union');
      // This `options` array is what D-13's single repair reprompt quotes back
      // to a model that invented an outcome.
      expect((issue as { options?: unknown }).options).toEqual([
        'pass',
        'send_back',
        'fail',
        'inconclusive',
        'warn',
        'skip',
      ]);
    }
  });
});
