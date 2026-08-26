# `@adl/plugin-sdk`

The one ADL package a third-party gate should depend on.

`@adl/core` is where eleven phases of internal contracts accumulate — the state
machine, the config resolver, the spec loader. A harness author writing a gate
does not need any of that. `@adl/plugin-sdk` is the small, stable slice: what a
gate returns, what the pieces of that return value look like, and the interface
a gate implements.

**Everything this package exports is a re-export of `@adl/core`.** It defines no
schema of its own — `VerdictSchema` imported from `@adl/plugin-sdk` is the exact
same object as `VerdictSchema` imported from `@adl/core/verdict`, not a second
definition that happens to look the same. Two definitions of the same contract in
two packages is a divergence waiting to happen; a re-export is one definition
reachable from two import paths.

## What you get

- **`Stage` and `StageContext`** — the interface a gate implements. This is not a
  simplified or example interface: the built-in reviewer and the built-in
  behaviour tester are themselves implemented against this exact type, with no
  special-casing (HARN-04). If they needed a privileged path, this would not be
  the real extension point.
- **`Verdict` and its six outcome schemas** (`pass`, `send_back`, `fail`,
  `inconclusive`, `warn`, `skip`) — what `Stage.run` resolves to when the gate
  judged.
- **`StageError`** — what `Stage.run` resolves to when the gate _broke_ instead
  of judging: a parse failure, a provider outage, a missing binary, an auth
  failure. It sits outside the `Verdict` union entirely, and it never costs the
  developer a round.
- **`Finding`, `CriterionRef`, `Waiver`** — the pieces a `Verdict` is built from.

`Stage.run` returns a `StageOutcome`, which is `Verdict | StageError`. Handle
both. Recording an infrastructure failure as though the gate had judged is
exactly the mistake this split exists to make impossible.

## A gate that is not a TypeScript module

A gate does not have to import this package at all. A plain command gate writes
its verdict as JSON to the file named in `ADL_VERDICT_FILE` and validates it
against `packages/core/schema/verdict.schema.json` — the published JSON Schema
for the same `Verdict` union this package exports as Zod. Any language, any
runtime, as long as the JSON is well-formed.

## `Workspace` is real; four other `StageContext` members are not yet

`StageContext.workspace: Workspace` **is** the real
`exec`/`read`/`write`/`snapshot` interface, as of M02. It also gained
`attach`/`detach` in M05 — a workspace outlives the stage that created it, so
the gate at the next pipeline index judges the commit the developer just made
rather than a fresh checkout of the base ref.

Four members of `StageContext` are still **forward declarations** — opaque
placeholder types, not real interfaces: `feature: FeatureView`,
`config: StageConfig`, `artifacts: ArtifactSink`, and `history: RoundSummary[]`.
They are declared so `Stage`'s shape could be published before the things it
collaborates with existed; each one is filled by the milestone that first needs
it. Write a gate against `workspace`, `priorFindings`, `agents`, `log` and
`signal` and you are on solid ground today.

## Why `GateContext` is not here

`@adl/core/stage` also exports a `GateContext`, and this package deliberately
does **not** re-export it. It is not your contract.

`GateContext` is what ADL's own **built-in** gates take — a narrow type carrying
a feature's spec, the diff its branch wrote, and the workspace, and carrying no
member through which the developer agent's session, transcript or rendered
prompt could be named (ROLE-03: a gate works from fresh context and never
inherits the developer's reasoning). It exists because the built-ins are plain
functions today rather than `Stage` implementations, and `StageContext`'s four
unfilled forward declarations mean it cannot yet carry that guarantee itself.

Publishing a second context type here before a real third-party harness has
shaped it would freeze the wrong one: every signature this package exports is
one-way from its first release. **`StageContext` is the interface a gate
implements.** When the forward declarations above are filled, the fresh-context
guarantee is re-derived over `StageContext` and this section goes away.

## Installing

```sh
npm install @adl/plugin-sdk
```

`@adl/core` and `zod` come along as dependencies — you do not add them yourself.
