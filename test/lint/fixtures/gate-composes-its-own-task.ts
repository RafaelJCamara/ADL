/**
 * The **negative control** for `adl/gate-fresh-context` (ROLE-03, M07 step
 * 7.4) — a fixture that must lint **clean**.
 *
 * Its sibling `gate-reaches-past-context.ts` proves the ban fires. This one
 * proves the ban is not simply "no gate may ever mention these names", which
 * would be a rule that reads as strict and is actually just broken: M07 step
 * 7.1 put `agents: AgentRunner` on `GateContext`, and `AgentRunner.run` takes
 * an `AgentTask` whose two required fields are `systemPrompt` and
 * `instructions`. A gate that cannot write those two keys cannot call a model
 * at all, so a ban covering the write form would not be enforcing ROLE-03 — it
 * would be enforcing "there is no reviewer".
 *
 * What ROLE-03 forbids is a gate arriving at the **developer's** rendered
 * prompt, and that is always a read. Every read form stays banned and is
 * exercised next door. Composing your own is what this file does, and a gate
 * composing its own instructions has learned nothing about anyone else's.
 *
 * **Why a whole file rather than a case in the other one:** the other fixture
 * is asserted to be entirely red, so an allowed construct cannot live in it —
 * a passing case there would be invisible. A guard that has only ever been
 * watched failing is half a guard; this is the other half.
 *
 * Typed against a hand-written minimal shape for the same reason its sibling
 * is: the fixture must be clean under the base rule set alone, and must not
 * depend on resolving the very modules the ban covers.
 */

/** The two fields `AgentTask` requires, as this fixture's own minimal stand-in. */
interface TaskLike {
  readonly systemPrompt: string;
  readonly instructions: string;
  readonly contextFiles: readonly string[];
}

/**
 * Exactly what a reviewer gate does: render two strings from what it was
 * given, and hand them over as a task.
 */
export function composeReviewTask(
  specTitle: string,
  changedPaths: readonly string[],
): TaskLike {
  return {
    systemPrompt: 'You are the ADL reviewer. Judge the diff against the spec.',
    instructions: `Feature: ${specTitle}\nChanged: ${changedPaths.join(', ')}`,
    contextFiles: [],
  };
}
