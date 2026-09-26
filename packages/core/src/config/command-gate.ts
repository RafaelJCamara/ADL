/**
 * The plain-command gate contract (HARN-02, M07 step 7.3) — a gate that is
 * just a program.
 *
 * ## Why this is the extension point that matters first
 *
 * D-23's harness resolution has three tiers, and two of them (npm package,
 * repo-relative module) need a loader that does not exist until M13. This one
 * needs nothing: the implementation is an argv in the pipeline entry's own
 * `with:` block, so a third party can add a gate to ADL **today** with a shell
 * script and four lines of YAML. `.planning/research/ARCHITECTURE.md` §3
 * describes exactly this — a command gate "validates its output against the
 * published JSON Schema instead of importing anything".
 *
 * ```yaml
 * pipeline:
 *   - develop
 *   - harness: lint
 *     with:
 *       command:
 *         argv: [npm, run, lint]
 *     on_send_back: continue
 *   - harness: audit
 *     with:
 *       emits: verdict
 *       command:
 *         argv: [./scripts/audit.sh]
 * ```
 *
 * ## `emits` is declared, never sniffed
 *
 * The two modes have to be told apart, and the honest way is for the gate to
 * say which it is:
 *
 * | `emits` | What the gate's stdout means |
 * |---|---|
 * | `exit_code` (default) | ordinary program output. Exit 0 is a `pass`, non-zero a `send_back` carrying one blocker with a bounded tail of the output. |
 * | `verdict` | one JSON `Verdict` on stdout, validated against `VerdictSchema`. Malformed is `unparseable` — a `StageError`, never a gate failure that costs a round (CORE-06). |
 * | `tap` | one TAP 13/14 report on stdout, read and judged by `@adl/core/stage`'s `readRunnerReport` and `judgeRunnerReport` (ROLE-08, M08 step 8.5). A failing test is a `send_back`; **a run in which no test executed is `inconclusive`, never a `pass`**; no report, or one that does not account for its own tests, is `unparseable`. |
 *
 * ## `tap` exists because `exit_code` cannot say "zero" (M08 step 8.5)
 *
 * A test runner's exit status is its own convention, and the conventions
 * disagree on exactly the case that matters: measured against the installed
 * runners, `node --test` with no tests exits **0** and `vitest run` exits **1**.
 * So under `exit_code` the first is a `pass` that verified nothing and the
 * second is a round-costing `send_back` nothing judged — and neither is honest.
 * The count of executed tests is only in the runner's report, so the report is
 * what a test gate declares it prints.
 *
 * It is a third mode rather than `verdict` plus a declared adapter, because the
 * rule that zero tests is not a pass has to be **ADL's own code** or it is not
 * ADL's guarantee: an adapter that turns TAP into a verdict hands ADL a `pass`
 * it cannot see behind. `argv` has no shell to pipe through, and an adapter
 * ADL shipped would have to launch the runner itself — a third launcher
 * outside `packages/workspace` (convention 1).
 *
 * **Declared, and the runner has to be told too.** node prints its `spec`
 * reporter unless given `--test-reporter=tap`, and vitest needs
 * `--reporter=tap`; a forgotten flag prints no TAP document and is refused as
 * `unparseable` rather than read as anything. Two runner settings are worth
 * naming because they weaken what a report can prove: vitest's `tap-flat`
 * reporter erases a group whose hook failed, and node's
 * `--test-isolation=none` lets a test end the whole run early.
 *
 * **Sniffing would be a correctness bug, not a shortcut.** If a gate's stdout
 * were parsed as a verdict "when it happens to look like one", then `npm test`
 * printing a JSON blob would silently become a verdict, and — worse — a
 * verdict-emitting gate whose program crashed before printing would be read as
 * "not a verdict, fall back to the exit code" and produce a `send_back` that
 * nothing judged. Declaring the mode makes the second case what it actually is:
 * a gate that promised a verdict and did not produce one.
 *
 * `exit_code` is the default so that 5.14's built-in `test` gate and every
 * ordinary linter keep working with no `emits` line at all.
 */
import * as z from 'zod';

import { CommandSpecSchema } from './adl-yml.js';

/**
 * The structured test-runner reports ADL reads (ROLE-08, M08 step 8.5).
 *
 * Its own list, rather than two literals inside the mode list below, because it
 * is also the whole vocabulary a behaviour tester's `with.suite` may declare
 * ({@link TestSuiteSchema}) — and a suite may declare **only** these: an exit
 * code cannot say that nothing ran, and a verdict is the agent's own channel.
 * `@adl/core/stage`'s `readRunnerReport` pairs a reader with every member, so a
 * format added here without one fails the build.
 */
export const RUNNER_REPORT_FORMATS = Object.freeze(['tap'] as const);

export type RunnerReportFormat = (typeof RUNNER_REPORT_FORMATS)[number];

/**
 * How a command gate reports its judgement. Frozen list plus derived union
 * (convention 7), so a mode cannot be added to one without the other — and the
 * report formats are **derived** into it rather than restated (rule 8).
 *
 * Note what this list does not do on its own: guarantee that every consumer
 * handles every member. A mode added here that a consumer compares against one
 * literal at a time falls through to whatever that consumer does by default —
 * which, for the command gate, would be judging by exit code: 7.3's sniff,
 * arriving by omission. The command gate therefore dispatches through a
 * `Record` over this union with an `Exclude` pairing, so a missing row is a
 * build error rather than a silent fallback (M08 step 8.5).
 */
export const COMMAND_GATE_OUTPUT_MODES = Object.freeze([
  'exit_code',
  'verdict',
  ...RUNNER_REPORT_FORMATS,
] as const);

export type CommandGateOutputMode = (typeof COMMAND_GATE_OUTPUT_MODES)[number];

/**
 * The `with:` block a plain-command gate declares.
 *
 * `strictObject`, unlike the opaque `Record<string, unknown>` that `with:`
 * generally is: this block is ADL's own, so a misspelled key is a
 * configuration error worth reporting rather than a third party's business.
 * The gate reports a failure to parse as a `StageError` — a misconfigured gate
 * did not judge, and must not cost the developer a round (CORE-06, D-12).
 */
export const CommandGateWithSchema = z.strictObject({
  command: CommandSpecSchema.describe(
    'The program this gate runs, in the same shape as `adl.yml`’s own commands.',
  ),
  emits: z
    .enum(COMMAND_GATE_OUTPUT_MODES)
    .default('exit_code')
    .describe(
      'What this gate’s stdout means. "exit_code" (default): ordinary output, judged by ' +
        'the exit status. "verdict": one JSON Verdict on stdout, validated against the ' +
        'published schema — malformed output is an infrastructure failure, never a gate ' +
        'failure that costs a round. "tap": one TAP report on stdout (node: ' +
        '`--test-reporter=tap`; vitest: `--reporter=tap`, not `tap-flat`) — a failing test ' +
        'sends the work back, and a run in which no test executed is inconclusive, never a pass.',
    ),
});

export type CommandGateWith = z.infer<typeof CommandGateWithSchema>;

/**
 * The `with:` block of the built-in `test` gate, which runs `commands.test`
 * (M08 step 8.5).
 *
 * The same block without its `command`, and **derived** rather than restated
 * (rule 8), so the modes, their default and the strictness cannot drift from
 * {@link CommandGateWithSchema}. It exists because `commands.test` is the one
 * test run every repository already declares, and until now the only way to
 * read it as a report was to restate its argv under `with.command` — which
 * silently turns the entry into a third-party gate (`declaresCommand`), losing
 * the built-in's `cheap` cost class and its `on_send_back: continue` default.
 * `- harness: test` with `with: { emits: tap }` stays the built-in.
 *
 * `emits` still defaults to `exit_code`, so a bare `- test` is byte-for-byte
 * what it was: flipping the default would break every repository whose test
 * command prints no TAP, and is an `adl init` decision rather than this one's.
 */
export const BuiltInCommandGateWithSchema = CommandGateWithSchema.omit({
  command: true,
});

export type BuiltInCommandGateWith = z.infer<
  typeof BuiltInCommandGateWithSchema
>;

/**
 * The suite a gate that is not itself a program declares ADL should run
 * (ROLE-08, M08 step 8.5) — today, the behaviour tester's `with.suite`.
 *
 * ```yaml
 * - harness: behaviour
 *   visible_paths: ['tests/behaviour/**']
 *   needs_app: true
 *   with:
 *     suite:
 *       command:
 *         argv: [node, --test, --test-reporter=tap]
 *         env: { APP_URL: 'http://127.0.0.1:${ADL_PORT}' }
 *       emits: tap
 * ```
 *
 * `emits` is **required and has no default** — declared, never defaulted — and
 * admits only {@link RUNNER_REPORT_FORMATS}. `exit_code` and `verdict` are
 * unrepresentable here rather than refused at run time (convention 9): the
 * first cannot say that nothing ran, which is the one thing this suite exists
 * to be able to say, and the second is the agent's own channel, which is the
 * thing the suite is checking.
 *
 * The key is `suite` and never `command`, and that is load-bearing:
 * `declaresCommand` reads any `with.command` object as "this entry is a
 * program", which would dispatch the tester as a plain command gate. A nested
 * `suite.command` does not trip it.
 */
export const TestSuiteSchema = z.strictObject({
  command: CommandSpecSchema.describe(
    'The program that runs the suite, in the same shape as `adl.yml`’s own commands. ' +
      '`env` values may use `${ADL_PORT}`; `argv` is never interpolated.',
  ),
  emits: z
    .enum(RUNNER_REPORT_FORMATS)
    .describe(
      'The report the suite prints on stdout. Required: a suite whose output ADL cannot ' +
        'count cannot tell "every test passed" from "no test ran".',
    ),
});

export type TestSuite = z.infer<typeof TestSuiteSchema>;
