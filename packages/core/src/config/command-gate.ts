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
 * How a command gate reports its judgement. Frozen list plus derived union
 * (convention 7), so a third mode cannot be added to one without the other.
 */
export const COMMAND_GATE_OUTPUT_MODES = Object.freeze([
  'exit_code',
  'verdict',
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
        'failure that costs a round.',
    ),
});

export type CommandGateWith = z.infer<typeof CommandGateWithSchema>;
