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
- **`StageError`** — what `Stage.run` resolves to when the gate *broke* instead
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

## `Workspace` is not real yet

`StageContext.workspace: Workspace` is currently a **forward declaration** — an
opaque placeholder type, not the real `exec`/`read`/`write`/`snapshot` interface.
`@adl/core` is pure: no filesystem, no child processes, no environment. It
cannot depend on a workspace implementation, so Phase 1 publishes the shape of
`Stage` with a placeholder for the one thing that has to come from elsewhere.
Phase 2 replaces `Workspace` with the real interface; the rest of `StageContext`
does not change.

## Installing

```sh
npm install @adl/plugin-sdk
```

`@adl/core` and `zod` come along as dependencies — you do not add them yourself.
