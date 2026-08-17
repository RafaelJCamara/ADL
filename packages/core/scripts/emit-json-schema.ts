/**
 * Emit the published verdict-file JSON Schema from the Zod source of truth.
 *
 * HARN-02 promises a gate may be a plain command, and a plain command written
 * in Python, Go, or shell cannot read a TypeScript type. D-26 answers that by
 * additionally publishing the verdict contract as JSON Schema. This script is
 * the only thing permitted to produce that file — it is never hand-edited,
 * because a hand-edited copy drifts from the Zod schema the first time anyone
 * touches one and not the other, and the drift is silent on both sides.
 *
 * Usage:
 *   tsx scripts/emit-json-schema.ts            # write schema/verdict.schema.json
 *   tsx scripts/emit-json-schema.ts --check    # compare bytes, write nothing
 *
 * Exit codes:
 *   0  emitted, or --check found the committed copy byte-identical
 *   1  --check found a mismatch (a unified diff is printed), or an emitted
 *      `$defs` key is positional / not PascalCase
 *   2  --check found no committed copy at all
 *
 * This file lives under `scripts/`, not `src/`, deliberately: `@adl/core` is
 * pure and I/O-free, and the purity lint scopes to `src/`. It is also outside
 * the package's tsconfig `include`, so it never ships in `dist/`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as z from 'zod';

import { VerdictSchema } from '../src/verdict/verdict.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const OUT_PATH = join(PACKAGE_ROOT, 'schema', 'verdict.schema.json');

/**
 * Zod's placeholder for a schema it had to extract into `$defs` but could not
 * name — see 01-RESEARCH.md § Pattern 2, verified by execution. The names are
 * *positional*, so they churn whenever a union member is reordered, which makes
 * every diff of a published artifact meaningless to the third parties reading
 * it.
 */
const POSITIONAL_DEF = /^__schema\d+$/;
const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Recursively sort object keys. Arrays keep their order — `oneOf`, `required`,
 * and `enum` are ordered by the Zod source and reordering them would be a
 * semantic change dressed up as formatting.
 */
function withSortedKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (value === null || typeof value !== 'object') return value;
  const out: { [key: string]: Json } = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = withSortedKeys(value[key] as Json);
  }
  return out;
}

/** The exact bytes the committed artifact must contain. */
export function serialise(schema: unknown): string {
  return `${JSON.stringify(withSortedKeys(schema as Json), null, 2)}\n`;
}

/**
 * Reject any `$defs` key that is positional or not PascalCase.
 *
 * Naming the outer schema is not sufficient — verified: with `reused: 'ref'`,
 * each *member* of a discriminated union still lands in `$defs` under a
 * positional name unless it carries its own `.meta({ id })`. This guard is what
 * catches the member somebody forgot.
 */
function assertStableDefNames(schema: unknown): void {
  const defs = (schema as { $defs?: Record<string, unknown> }).$defs;
  if (!defs) return;

  const keys = Object.keys(defs);
  const positional = keys.filter((k) => POSITIONAL_DEF.test(k));
  if (positional.length > 0) {
    console.error(
      `Positional $defs names emitted: ${positional.join(', ')}\n` +
        'These are assigned by position, so they churn whenever a union member is\n' +
        'reordered. Add `.meta({ id: "PascalName" })` to the offending schema —\n' +
        'including each member of a discriminated union, not just the union itself.',
    );
    process.exit(1);
  }

  const misnamed = keys.filter((k) => !PASCAL_CASE.test(k));
  if (misnamed.length > 0) {
    console.error(
      `Non-PascalCase $defs names emitted: ${misnamed.join(', ')}\n` +
        'Published `$defs` keys are part of the contract third parties `$ref` into.',
    );
    process.exit(1);
  }
}

/**
 * Reject a root `oneOf` member that is not a `$ref`.
 *
 * This is the guard that actually bites under inline emission. A union member
 * missing its `.meta({ id })` does not show up as a positional `$defs` name —
 * it is quietly *inlined* into `oneOf`, which still validates identically but
 * gives third parties nothing to `$ref` and turns any later edit to that member
 * into a large, unreviewable diff in the middle of the root schema. Verified by
 * removing `.meta({ id: 'FailVerdict' })` and re-emitting.
 */
function assertNamedUnionMembers(schema: unknown): void {
  const members = (schema as { oneOf?: unknown[] }).oneOf;
  if (!Array.isArray(members)) return;

  const anonymous = members
    .map((m, i) => ({ i, hasRef: typeof (m as { $ref?: unknown }).$ref === 'string' }))
    .filter((m) => !m.hasRef)
    .map((m) => `oneOf[${m.i}]`);

  if (anonymous.length > 0) {
    console.error(
      `Anonymous union members emitted inline: ${anonymous.join(', ')}\n` +
        'Every member of the published union needs its own `.meta({ id: "PascalName" })`\n' +
        'so it lands in $defs and third parties have a stable name to $ref.',
    );
    process.exit(1);
  }
}

/**
 * A single-hunk unified diff. Trims the common prefix and suffix, then reports
 * the divergent middle. Enough to see what changed without pulling in a diff
 * library for a guard that should almost never fire.
 */
function unifiedDiff(expected: string, actual: string, label: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const aMiddle = a.slice(head, a.length - tail);
  const bMiddle = b.slice(head, b.length - tail);

  const lines = [
    `--- ${label} (committed)`,
    `+++ ${label} (freshly emitted)`,
    `@@ -${head + 1},${aMiddle.length} +${head + 1},${bMiddle.length} @@`,
    ...aMiddle.map((l) => `-${l}`),
    ...bMiddle.map((l) => `+${l}`),
  ];
  return lines.join('\n');
}

/**
 * Produce the published schema and its exact serialised bytes from the
 * current Zod source, running both `$defs`-shape guards.
 *
 * Exported so `json-schema-equivalence.test.ts` can assert byte-identity
 * against the committed copy **without re-implementing the emission or
 * serialisation logic** — a test-local re-implementation of `serialise()`
 * would itself be able to drift from what this script actually writes,
 * which defeats the point of a drift test.
 *
 * `reused: 'inline'` rather than `'ref'`, and the difference is load-bearing.
 * Every schema carrying `.meta({ id })` lands in `$defs` under that name and
 * is `$ref`'d, regardless of this option — that is registry-driven, and it is
 * what makes `Finding`, `CriterionRef`, `Severity` and friends stable
 * references. What `reused: 'ref'` additionally does is extract every
 * *anonymous leaf* — each `z.string().min(1)`, each `z.literal('pass')` —
 * into `$defs` under a **positional** `__schemaN` name. Measured against this
 * schema: `'ref'` produces 50 defs of which 33 are positional; `'inline'`
 * produces 17, all PascalCase. Positional names churn whenever anything
 * upstream is reordered, which is exactly the meaningless-diff failure the
 * guards below exist to prevent, and no amount of naming union *members*
 * fixes it — the offenders are primitives with no identity worth naming.
 */
export function emitVerdictSchema(): { schema: unknown; serialised: string } {
  const schema = z.toJSONSchema(VerdictSchema, { target: 'draft-2020-12', reused: 'inline' });
  assertStableDefNames(schema);
  assertNamedUnionMembers(schema);
  return { schema, serialised: serialise(schema) };
}

function main(): void {
  const check = process.argv.includes('--check');
  const { serialised } = emitVerdictSchema();
  const label = relative(PACKAGE_ROOT, OUT_PATH).split('\\').join('/');

  if (!check) {
    writeFileSync(OUT_PATH, serialised, 'utf8');
    console.log(`Wrote ${label}`);
    return;
  }

  // Byte comparison, not `git diff --exit-code`.
  //
  // The obvious drift guard — emit, then ask git whether the file changed — is
  // silently vacuous the moment the artifact is untracked, which is exactly its
  // state in the commit that creates it: `git diff --exit-code` reports success
  // for a file git has never seen, so the gate would pass by construction on the
  // one run where it most needs to work. This comparison depends on nothing git
  // knows.
  let committed: string;
  try {
    committed = readFileSync(OUT_PATH, 'utf8');
  } catch {
    console.error(
      `Missing published schema: ${label}\n` +
        'The contract third-party command gates validate against does not exist.\n' +
        'Regenerate it with: pnpm --filter @adl/core emit:schema',
    );
    process.exit(2);
  }

  // Normalise line endings before comparing. Git may check the artifact out with
  // CRLF on Windows; the constraint being enforced is that the *schema* has not
  // drifted, not which line-ending policy the working copy uses.
  if (committed.split('\r\n').join('\n') === serialised) {
    console.log(`${label} is up to date`);
    return;
  }

  console.error(
    `${label} does not match a fresh emission from the Zod source.\n` +
      'The published contract has drifted from the enforced one. Regenerate with:\n' +
      '  pnpm --filter @adl/core emit:schema\n',
  );
  console.error(unifiedDiff(committed.split('\r\n').join('\n'), serialised, label));
  process.exit(1);
}

// Only run as a side effect when executed directly (`tsx scripts/emit-json-schema.ts`),
// never when imported — `json-schema-equivalence.test.ts` imports `emitVerdictSchema`
// and must not trigger a filesystem write or a `process.exit` as an import side effect.
const isDirectlyExecuted =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectlyExecuted) {
  main();
}
