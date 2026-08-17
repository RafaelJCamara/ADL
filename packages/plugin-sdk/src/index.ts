// Intentionally empty.
//
// `@adl/plugin-sdk` is owned by plan 01-05, which fills it with `Stage`,
// `StageContext`, a type-only forward declaration of `Workspace`, and
// **re-exports by reference** of the `@adl/core` schemas — one definition
// reachable from two import paths, rather than two definitions free to diverge.
//
// The package exists one wave early and deliberately empty for a concurrency
// reason, not a scope one. Wave 3 runs seven plans at once against the same
// pnpm store; a plan that added a workspace member mid-wave would have to run
// `pnpm install`, mutating `pnpm-lock.yaml` and the shared store underneath six
// siblings that are at that moment resolving the toolchain and running vitest.
// With the member already in the lockfile, plan 01-05 needs no install to fill
// it in.
//
// Do not add anything else here. An empty module that typechecks and collects
// zero tests is exactly the contract Wave 3 depends on.
export {};
