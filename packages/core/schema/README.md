# Published contracts

## `verdict.schema.json`

**This file is generated. Do not hand-edit it.**

### What it is for

HARN-02 promises that a gate may be **a plain command** — a Python script, a Go
binary, a shell one-liner. A plain command cannot read a TypeScript type. This
file is the contract such a gate validates `.adl/verdicts/*.json` against before
handing it to ADL, and it is the contract ADL's own loader enforces (D-26).

Those two must be the *same* contract. A published schema that accepts payloads
the loader rejects routes a well-behaved gate down the CORE-06
infrastructure-failure path and blames the gate author for ADL's own drift.

### Commands

| Command | What it does |
|---|---|
| `pnpm --filter @adl/core emit:schema` | Regenerate this file from the Zod source |
| `pnpm --filter @adl/core emit:schema:check` | Drift gate — compares bytes, writes nothing |

`emit:schema:check` exits `0` when the committed copy matches, `1` with a
unified diff when it does not, and `2` when the file is missing entirely.

It compares **bytes to bytes**, deliberately, rather than running the emitter and
asking git whether anything changed. `git diff --exit-code` reports success for
a file git has never seen, so a git-based gate passes by construction on the one
run where it matters most — the commit that first creates the artifact.

`packages/core/test/verdict/json-schema-equivalence.test.ts` enforces the same
byte-identity from inside the test suite, and additionally proves that Zod and an
independent JSON-Schema validator reach the same accept/reject decision on a
40-payload corpus. A source change without a re-emit fails there, in this
repository, rather than in a third party's CI.

### Source of truth

`packages/core/src/verdict/*.ts`. The emitter is
`packages/core/scripts/emit-json-schema.ts`, and it refuses to write when:

- a `$defs` key is positional (`__schemaN`) or not PascalCase — those names churn
  on unrelated reordering, so a published artifact would produce meaningless
  diffs for the third parties reading it; or
- a member of the root union is emitted **inline** rather than as a `$ref`, which
  is what a member missing its `.meta({ id })` actually looks like.

### Things worth knowing before you validate against this

**`additionalProperties: false` is real.** Every object here rejects unrecognised
keys, and so does ADL's loader — the Zod schemas are `z.strictObject`. A verdict
carrying a typo'd key (`waver` for `waiver`) is a loud error on both sides rather
than a verdict whose waiver silently vanished.

**`format` is not load-bearing.** The only `format` in this file is `date-time` on
`Waiver.at`, and draft 2020-12 makes `format` an *annotation* by default — a
spec-compliant validator is permitted to ignore it. The actual constraint is
carried by the `pattern` alongside it, so a validator with no format support
reaches the same decision as one with it. Do not add a constraint here that only
`format` expresses.

### Known open question — for whoever plans Phase 4

**The root of this schema is a `oneOf`, not a JSON Schema `discriminator`.**

That is verified, expected, and correct for a *validator*. It is an open question
for a *generator*: some model backends' structured-output modes are picky about a
root-level `oneOf`, and no backend is invoked before Phase 4, so Phase 1
deliberately does not answer it (01-RESEARCH.md § Open Questions 7, resolved as
deferred).

Phase 4 should test this artifact against a real backend's schema validator. If
the shape turns out to be a problem, the fix is an `override` callback in
`z.toJSONSchema()` inside the emitter — **the emitted shape changes, the source of
truth does not.** That option stays available precisely because this file is
generated and never hand-written.
