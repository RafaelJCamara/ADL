/**
 * What an agent gate is told about the **host** it runs on (M08 step 8.5) — the
 * second and last parameter of every `AGENT_GATE_IMPLEMENTATIONS` entry.
 *
 * ## Why a second parameter, and not a `GateContext` member
 *
 * `GateContext` is what a gate is told **about the feature**, and it is the
 * published third-party contract (`@adl/plugin-sdk` republishes it; a member is a
 * one-way change). This is what a gate is told **about itself** — on the exact
 * precedent of `CommandGateConfig`, which has handed the command gate its `path`
 * as a second parameter since M05. Neither field can name a session, a transcript
 * or a prompt, which is what keeps the two-parameter shape honest under
 * `adl/gate-fresh-context`.
 *
 * It exists because step 8.5 made an agent gate run a program of its own for the
 * first time — the behaviour tester runs the suite its entry declares, so that the
 * suite's report, not the agent's claim, decides the outcome — and running a
 * program needs the two things a command gate is already given:
 *
 * - `path`, the child's `PATH`, which the caller reads once from the worker's own
 *   environment. The alternative, the gate reading `process.env` itself, is an
 *   ambient channel outside every parameter the gate was handed.
 * - `variables`, the **same** `appVariables(…)` record a command gate's `env` is
 *   interpolated with. One closed allowlist of ADL variables, computed in one
 *   place (`stage-runner.ts` calls `appVariables` exactly once, and
 *   `harn-04-no-privileged-gate.test.ts` holds it to that), so "which variables
 *   may a command reference?" has one answer for every gate kind.
 *
 * Every agent gate receives it identically — the reviewer ignores it — so there is
 * nothing here the built-in tester gets that a gate of the same kind would not.
 * What does NOT receive it yet is a module gate (M13), whose `Stage.run(ctx)` has
 * no second parameter; `DEBT.md` D-8-05-6 carries that.
 */
import type { AppVariableValues } from '@adl/core/config';

export interface AgentGateHost {
  /** The worker's `PATH`, read once by the caller. */
  readonly path: string;
  /** Present exactly when an app under test was started for this gate (`GateContext.app`). */
  readonly variables?: AppVariableValues;
}
