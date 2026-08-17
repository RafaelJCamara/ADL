# `@adl/core`

The settled vocabulary every other ADL package speaks: verdicts, findings,
criterion identity, and normalized specs. Zod is the source of truth for every
contract; TypeScript types come from `z.infer` (D-26).

## Purity

`@adl/core` is **pure and I/O-free**. It does not import `node:fs`,
`node:fs/promises`, or `node:child_process`, and it never reads `process.env`.
Reading a spec file off disk is the caller's job — this package is handed a
string and returns a value. That is what keeps the contract layer testable in
milliseconds and keeps the trust boundary at the caller, where the untrusted
repo-supplied bytes actually arrive.

`node:crypto` is used for hashing. It is a builtin computation, not I/O, and is
deliberately inside the purity boundary.

Plan 01-03 turns the purity rule into a CI-enforced lint rule.

## Dependencies — stated honestly

D-26 originally framed this package as having "one dependency: Zod". That is no
longer accurate, and the amendment is deliberate rather than an oversight.

`@adl/core` depends on **Zod plus two parser families**:

| Dependency | Why it is here |
|---|---|
| `zod` | The source of truth for every contract (D-26) |
| `mdast-util-from-markdown` | CommonMark parsing **with byte offsets** for the ADL template loader |
| `@cucumber/gherkin` + `@cucumber/messages` | The reference Gherkin implementation, for `*.feature` specs |
| `yaml` | `adl.yml` parsing with positioned errors |

The markdown parser is the one that moves the number, pulling in roughly 34
transitive micromark packages. It earns that cost: `position.start.offset` /
`position.end.offset` are what make CORE-05's verbatim retention and D-01's
`textHash` **exact** rather than approximate. The alternatives (`marked`, or a
hand-rolled line scanner) both lose reliable byte offsets for nested list items.
An approximate `textHash` on a one-way criterion identifier is a worse cost than
a wider transitive tree in a package whose consumers are already installing a
Node daemon.

See `.planning/phases/01-core-contracts/01-01-SUMMARY.md` §3 for the recorded
amendment.

## Entry points

There is deliberately **no** `src/index.ts`. Subsystems are reached through
subpath exports, so a plan that adds a subsystem creates its own barrel and
never edits a shared one:

| Subpath | Contents |
|---|---|
| `@adl/core/verdict` | `Verdict`, `Finding`, `CriterionRef`, `Waiver`, `aggregate` |
| `@adl/core/spec` | `NormalizedSpec`, `AcceptanceCriterion`, the spec loaders |
| `@adl/core/stage` | `Stage`, `StageContext`, `StageError`, `DeveloperOutcome` |
| `@adl/core/config` | `adl.yml` schema, `EffectiveConfig` merge and clamps |
| `@adl/core/state` | `FeatureState`, `FeatureEvent`, `transition` |

The bare `.` export points at `./verdict` for convenience; prefer the explicit
subpath.

## Schema discipline

Every constraint under `src/verdict/` is expressed with a **structural** Zod
combinator — `z.literal`, `z.enum`, `.min()`, `.max()`, `.length()`, `.regex()`
— and never with `.refine()` or `.superRefine()`. `z.toJSONSchema()` drops
refinements silently, so a refined schema would publish a contract strictly
weaker than the one the code enforces. Every schema, including each member of
every discriminated union, carries `.meta({ id })` so the emitted `$defs` names
are stable rather than positional `__schemaN`.
