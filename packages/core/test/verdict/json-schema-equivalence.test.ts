import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { emitVerdictSchema } from '../../scripts/emit-json-schema.js';
import { VerdictSchema } from '../../src/verdict/verdict.js';

/**
 * The equivalence contract between the enforced Zod schema and the published
 * JSON Schema (CORE-04, D-26, 01-RESEARCH.md § Pitfall 1).
 *
 * `VerdictSchema.parse()` rejects a payload, but if the published schema
 * *accepts* it, a well-behaved third-party gate validates locally, sees
 * green, and ADL's loader then rejects it as malformed — routing an honest
 * gate down the CORE-06 infrastructure-failure path and blaming the gate
 * author for ADL's own drift. This is the only test that catches that.
 *
 * `ajv` is loaded from `ajv/dist/2020`, not the package's default export —
 * the default is the draft-07 validator class, and this schema is emitted as
 * draft 2020-12 (01-01-SUMMARY.md § 4a).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, '..', '..', 'schema', 'verdict.schema.json');

const committedSchema: unknown = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

// `strict: true` is what makes `additionalProperties: false` (and every other
// constraint) actually enforced rather than silently ignored. `ajv-formats`
// is required here, not merely convenient: without it, strict mode throws at
// *compile time* on the unrecognised `format: "date-time"` this schema emits
// for `Waiver.at` (verified — 01-01-SUMMARY.md § 4c's pre-approval condition:
// "ONLY IF the emitted draft-2020-12 schema actually carries a `format`
// keyword that ajv 8 strict mode rejects" — it does, so the package is used).
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(committedSchema as object);

function ajvAccepts(payload: unknown): boolean {
  return validate(payload) === true;
}

function zodAccepts(payload: unknown): boolean {
  return VerdictSchema.safeParse(payload).success;
}

// ---------------------------------------------------------------------------
// Fixture corpus — inline, labelled, so each payload names the constraint it
// probes and the corpus cannot silently drift out of sync with the assertions
// that consume it. See test/fixtures/verdicts/{valid,invalid}/README.md.
// ---------------------------------------------------------------------------

interface Fixture {
  readonly label: string;
  readonly payload: unknown;
}

const FP = 'f'.repeat(64);

const VALID: readonly Fixture[] = [
  {
    label: 'pass citing a criterion ref',
    payload: { outcome: 'pass', summary: 'ok', checked: [{ kind: 'criterion', id: 'AC-1' }] },
  },
  {
    label: 'pass citing a global ref',
    payload: { outcome: 'pass', summary: 'ok', checked: [{ kind: 'global', category: 'build' }] },
  },
  {
    label: 'pass citing multiple mixed refs',
    payload: {
      outcome: 'pass',
      summary: 'ok',
      checked: [
        { kind: 'criterion', id: 'AC-1' },
        { kind: 'criterion', id: 'AC-2' },
        { kind: 'global', category: 'security' },
      ],
    },
  },
  {
    label: 'pass citing a high-numbered criterion id',
    payload: { outcome: 'pass', summary: 'ok', checked: [{ kind: 'criterion', id: 'AC-42' }] },
  },
  {
    label: 'send_back with one finding',
    payload: {
      outcome: 'send_back',
      summary: 'fix it',
      findings: [
        {
          fingerprint: FP,
          severity: 'blocker',
          title: 'x',
          detail: 'y',
          criterionRef: { kind: 'criterion', id: 'AC-1' },
        },
      ],
    },
  },
  {
    label: 'send_back with several findings across every severity',
    payload: {
      outcome: 'send_back',
      summary: 'fix it',
      findings: [
        {
          fingerprint: FP,
          severity: 'blocker',
          title: 'a',
          detail: '',
          criterionRef: { kind: 'criterion', id: 'AC-1' },
        },
        {
          fingerprint: FP,
          severity: 'major',
          title: 'b',
          detail: '',
          criterionRef: { kind: 'criterion', id: 'AC-1' },
        },
        {
          fingerprint: FP,
          severity: 'minor',
          title: 'c',
          detail: '',
          criterionRef: { kind: 'criterion', id: 'AC-1' },
        },
        {
          fingerprint: FP,
          severity: 'nit',
          title: 'd',
          detail: '',
          criterionRef: { kind: 'criterion', id: 'AC-1' },
        },
      ],
    },
  },
  { label: 'fail minimal', payload: { outcome: 'fail', summary: 's', reason: 'unfixable' } },
  {
    label: 'inconclusive minimal',
    payload: { outcome: 'inconclusive', summary: 's', reason: 'app never became ready' },
  },
  { label: 'warn with an empty findings array', payload: { outcome: 'warn', summary: 's', findings: [] } },
  {
    label: 'warn with several findings',
    payload: {
      outcome: 'warn',
      summary: 's',
      findings: [
        {
          fingerprint: FP,
          severity: 'nit',
          title: 'a',
          detail: '',
          criterionRef: { kind: 'global', category: 'code_quality' },
        },
      ],
    },
  },
  {
    label: 'skip with a waiver targeting a criterion',
    payload: {
      outcome: 'skip',
      reason: 'no harness configured',
      waiver: {
        target: { kind: 'criterion', id: 'AC-1' },
        reason: 'accepted for this release',
        actor: 'rafael',
        at: '2026-08-17T10:00:00Z',
      },
    },
  },
  {
    label: 'skip with a waiver targeting a global category',
    payload: {
      outcome: 'skip',
      reason: 'no harness configured',
      waiver: {
        target: { kind: 'global', category: 'security' },
        reason: 'accepted for this release',
        actor: 'rafael',
        at: '2026-08-17T10:00:00Z',
      },
    },
  },
  {
    label: 'skip with a waiver targeting a whole stage',
    payload: {
      outcome: 'skip',
      reason: 'no harness configured',
      waiver: {
        target: { kind: 'stage', stageId: 'security-scan' },
        reason: 'accepted for this release',
        actor: 'rafael',
        at: '2026-08-17T10:00:00Z',
      },
    },
  },
  { label: 'skip without a waiver', payload: { outcome: 'skip', reason: 'no harness configured' } },
  {
    label: 'finding with a full location (path, line, endLine)',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: FP,
          severity: 'major',
          title: 'x',
          detail: '',
          criterionRef: { kind: 'criterion', id: 'AC-1' },
          location: { path: 'src/a.ts', line: 10, endLine: 12 },
        },
      ],
    },
  },
  {
    label: 'finding with no location',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: FP,
          severity: 'major',
          title: 'x',
          detail: '',
          criterionRef: { kind: 'criterion', id: 'AC-1' },
        },
      ],
    },
  },
  {
    label: 'finding with suggestedAction',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: FP,
          severity: 'major',
          title: 'x',
          detail: '',
          criterionRef: { kind: 'criterion', id: 'AC-1' },
          suggestedAction: 'Add a null check before dereferencing.',
        },
      ],
    },
  },
  {
    label: 'finding without suggestedAction',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: FP,
          severity: 'major',
          title: 'x',
          detail: '',
          criterionRef: { kind: 'criterion', id: 'AC-1' },
        },
      ],
    },
  },
  {
    label: 'finding with global criterionRef category code_quality',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: FP,
          severity: 'nit',
          title: 'x',
          detail: '',
          criterionRef: { kind: 'global', category: 'code_quality' },
        },
      ],
    },
  },
  {
    label: 'finding with global criterionRef category security',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: FP,
          severity: 'blocker',
          title: 'x',
          detail: '',
          criterionRef: { kind: 'global', category: 'security' },
        },
      ],
    },
  },
  {
    label: 'finding with global criterionRef category build',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: FP,
          severity: 'blocker',
          title: 'x',
          detail: '',
          criterionRef: { kind: 'global', category: 'build' },
        },
      ],
    },
  },
  {
    label: 'finding with global criterionRef category other',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: FP,
          severity: 'minor',
          title: 'x',
          detail: '',
          criterionRef: { kind: 'global', category: 'other' },
        },
      ],
    },
  },
];

const INVALID: readonly Fixture[] = [
  { label: 'a seventh, unrecognised outcome', payload: { outcome: 'approved', summary: 'x' } },
  { label: 'missing outcome entirely', payload: { summary: 'no outcome here' } },
  { label: 'pass with an empty checked array', payload: { outcome: 'pass', summary: 's', checked: [] } },
  { label: 'pass with checked absent', payload: { outcome: 'pass', summary: 's' } },
  { label: 'pass with summary absent', payload: { outcome: 'pass', checked: [{ kind: 'global', category: 'other' }] } },
  {
    label: 'send_back with an empty findings array',
    payload: { outcome: 'send_back', summary: 's', findings: [] },
  },
  { label: 'send_back with findings absent', payload: { outcome: 'send_back', summary: 's' } },
  {
    label: 'finding with criterionRef absent',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [{ fingerprint: FP, severity: 'blocker', title: 'x', detail: '' }],
    },
  },
  {
    label: 'finding with criterionRef.kind neither member',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: FP,
          severity: 'blocker',
          title: 'x',
          detail: '',
          criterionRef: { kind: 'nonsense' },
        },
      ],
    },
  },
  {
    label: 'criterion id not matching the AC-n pattern',
    payload: { outcome: 'pass', summary: 's', checked: [{ kind: 'criterion', id: 'AC-one' }] },
  },
  {
    label: 'criterion id missing the dash',
    payload: { outcome: 'pass', summary: 's', checked: [{ kind: 'criterion', id: 'AC1' }] },
  },
  {
    label: 'fingerprint shorter than 64 characters',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: 'a'.repeat(63),
          severity: 'blocker',
          title: 'x',
          detail: '',
          criterionRef: { kind: 'criterion', id: 'AC-1' },
        },
      ],
    },
  },
  {
    label: 'fingerprint longer than 64 characters',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: 'a'.repeat(65),
          severity: 'blocker',
          title: 'x',
          detail: '',
          criterionRef: { kind: 'criterion', id: 'AC-1' },
        },
      ],
    },
  },
  {
    label: 'an empty title',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: FP,
          severity: 'blocker',
          title: '',
          detail: '',
          criterionRef: { kind: 'criterion', id: 'AC-1' },
        },
      ],
    },
  },
  {
    label: 'an unknown severity',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: FP,
          severity: 'catastrophic',
          title: 'x',
          detail: '',
          criterionRef: { kind: 'criterion', id: 'AC-1' },
        },
      ],
    },
  },
  {
    label: 'an unknown global category',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: FP,
          severity: 'blocker',
          title: 'x',
          detail: '',
          criterionRef: { kind: 'global', category: 'performance' },
        },
      ],
    },
  },
  { label: 'skip with no reason', payload: { outcome: 'skip' } },
  {
    label: 'an extra unrecognised property on a verdict',
    payload: {
      outcome: 'pass',
      summary: 's',
      checked: [{ kind: 'global', category: 'other' }],
      bogus: 'unrecognised',
    },
  },
  {
    label: 'location.line is zero',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: FP,
          severity: 'blocker',
          title: 'x',
          detail: '',
          criterionRef: { kind: 'criterion', id: 'AC-1' },
          location: { path: 'src/a.ts', line: 0 },
        },
      ],
    },
  },
  {
    label: 'location.line is negative',
    payload: {
      outcome: 'send_back',
      summary: 's',
      findings: [
        {
          fingerprint: FP,
          severity: 'blocker',
          title: 'x',
          detail: '',
          criterionRef: { kind: 'criterion', id: 'AC-1' },
          location: { path: 'src/a.ts', line: -1 },
        },
      ],
    },
  },
  { label: 'a payload that is an array rather than an object', payload: [{ outcome: 'pass' }] },
  { label: 'a payload that is a bare string', payload: 'pass' },
  { label: 'fail with an empty reason', payload: { outcome: 'fail', summary: 's', reason: '' } },
  {
    label: 'inconclusive with an empty summary',
    payload: { outcome: 'inconclusive', summary: '', reason: 'x' },
  },
  {
    label: "skip's waiver missing actor",
    payload: {
      outcome: 'skip',
      reason: 'no harness',
      waiver: {
        target: { kind: 'criterion', id: 'AC-1' },
        reason: 'accepted',
        at: '2026-08-17T10:00:00Z',
      },
    },
  },
];

describe('json-schema-equivalence — CORE-04, D-26, Pitfall 1', () => {
  it('declares at least 20 valid and at least 20 invalid fixtures', () => {
    expect(VALID.length).toBeGreaterThanOrEqual(20);
    expect(INVALID.length).toBeGreaterThanOrEqual(20);
  });

  it.each(VALID)('valid: $label — Zod accepts and ajv accepts', ({ label, payload }) => {
    const zod = zodAccepts(payload);
    const ajvResult = ajvAccepts(payload);
    expect(zod, `Zod rejected a fixture expected to be valid: ${label}`).toBe(true);
    expect(
      ajvResult,
      `ajv rejected a fixture expected to be valid: ${label}\n${ajv.errorsText(validate.errors)}`,
    ).toBe(true);
  });

  it.each(INVALID)('invalid: $label — Zod rejects and ajv rejects', ({ label, payload }) => {
    const zod = zodAccepts(payload);
    const ajvResult = ajvAccepts(payload);
    expect(zod, `Zod accepted a fixture expected to be invalid: ${label}`).toBe(false);
    expect(ajvResult, `ajv accepted a fixture expected to be invalid: ${label}`).toBe(false);
  });

  it('reports zero disagreements across the whole corpus', () => {
    const disagreements: string[] = [];
    for (const { label, payload } of [...VALID, ...INVALID]) {
      const zod = zodAccepts(payload);
      const ajvResult = ajvAccepts(payload);
      if (zod !== ajvResult) {
        disagreements.push(`${label}: zod=${zod} ajv=${ajvResult}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('the committed schema is byte-identical to a fresh emission from the current Zod source', () => {
    const { serialised: fresh } = emitVerdictSchema();
    const committedBytes = readFileSync(SCHEMA_PATH, 'utf8').split('\r\n').join('\n');
    expect(committedBytes).toBe(fresh);
  });
});
