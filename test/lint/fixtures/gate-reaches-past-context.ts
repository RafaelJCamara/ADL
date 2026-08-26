/**
 * Deliberate violation of `adl/gate-fresh-context` (ROLE-03, M05 step 5.17).
 *
 * This file exists to be reported. It is globally ignored by `eslint.config.js`
 * so `pnpm lint` is not permanently red, and linted with `ignore: false` by
 * `test/lint/no-restricted-imports.test.ts` through that same config — so the
 * rule objects exercised here are literally the ones
 * `packages/manager/src/worker-entry/gates/` is linted with.
 *
 * **What it is a fixture FOR.** `@adl/core/stage`'s `GateContext` is the
 * preferred guard and it holds: a gate handed one has no member naming the
 * developer's session, transcript or rendered prompt. What a type cannot stop
 * is a gate *reaching around* its own parameters — importing the transcript
 * store and rebuilding the path out of ids it legitimately knows. That is the
 * residual, and every case below is one way to reach it.
 *
 * One case per banned entry, and the test asserts that EVERY name in
 * `GATE_FORBIDDEN_MEMBERS` and every group in `GATE_FORBIDDEN_IMPORT_GROUPS` is
 * reported on this file. An entry added to either tuple without a case here
 * therefore goes red, which is what stops the tuples growing entries nobody has
 * ever watched fire.
 *
 * Typed against hand-written minimal interfaces rather than the real ones: the
 * fixture must be clean under the base rule set alone (the negative control),
 * and it must not import the very modules it is proving are banned in a form
 * that would also have to resolve.
 */

// 1. The transcript store — where a gate would go to turn ids into a path.
import { transcriptPathFor } from '../../../packages/manager/src/store/transcript-path.js';
// 2. The prompt builder — what the developer was asked, which is its
//    reasoning's input.
import { buildDeveloperPrompt } from '../../../packages/manager/src/prompt/build.js';
// 3. The round loop's own modules, including the send-back brief's parser.
import { parseSendBackBriefJson } from '../../../packages/manager/src/loop/send-back-brief.js';
// 4. The assign envelope itself — the type every one of the fields below is
//    declared on. A gate that can name this needs none of the other routes.
import type { AssignMessage } from '../../../packages/manager/src/ipc/protocol.js';

/** Stands in for whatever a gate was actually handed. */
interface Handed {
  readonly logsRoot: string;
  readonly sessionRef?: string;
  readonly sendBackBriefJson?: string;
  readonly stageAttemptId: string;
  readonly systemPrompt: string;
  readonly instructions: string;
}

export function inheritTheDevelopersContext(
  handed: Handed,
  assign: AssignMessage,
  loose: Record<string, string>,
): unknown {
  // 5. The plain member read.
  const root = handed.logsRoot;

  // 6. Destructuring — a MemberExpression selector's blind spot, and the
  //    reason `Property[key.name=…]` is in the ban. Probe finding 2.
  const { sessionRef } = handed;
  const { sendBackBriefJson: brief } = handed;

  // 7. Computed access with a literal key — clean under both of the above.
  const attempt = loose['stageAttemptId'];

  // 8. Rebuilding the object, which is how a value is laundered into a shape
  //    something else will read.
  const relayed = {
    systemPrompt: handed.systemPrompt,
    instructions: handed.instructions,
  };

  return {
    root,
    sessionRef,
    brief,
    attempt,
    relayed,
    assign,
    transcriptPathFor,
    buildDeveloperPrompt,
    parseSendBackBriefJson,
  };
}
