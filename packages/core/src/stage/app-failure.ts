/**
 * Every way the app under test can fail to be judgeable, and what each one means
 * (ROLE-07, M08 step 8.3).
 *
 * M08 step 8.2 built the lifecycle and deliberately stopped at the **facts** — it
 * reports which thing went wrong and classifies nothing, so this step has
 * something real to map. Its caller's mapping was one conservative
 * `provider_error` for everything, with a comment saying so. This module is the
 * replacement.
 *
 * ## Why the sketch's single mapping could not work
 *
 * The step sketch said *"an app that never becomes ready yields `inconclusive`"*.
 * M08's audit finding 6 is why that is wrong, and it is worth restating because
 * the mistake is invisible from the requirement's wording: `aggregate` maps an
 * `inconclusive` with no `send_back` anywhere to `unverified`, and
 * `loop/round-step.ts` turns `unverified` into `{ kind: 'complete' }` plus an
 * `unrecoverable` event. So *"never ready → `inconclusive`"* wakes a human
 * **immediately and irrecoverably**, with no retry — for a lost port race, for a
 * slow CI box, for anything.
 *
 * The requirement's load-bearing half is *"never `pass`"*, and this table's
 * answer type makes that **structurally impossible** rather than merely true:
 * {@link AppFailureAnswer} has no member through which a `pass` — or an
 * `inconclusive` — can be expressed. Convention 9, and it is a better guarantee
 * than a test over a mapping table, because there is nothing to get wrong.
 *
 * ## The table
 *
 * | Failure | Channel | Whose problem | Why |
 * |---|---|---|---|
 * | `port-unavailable` | `provider_error` | the machine | Retryable and costs nothing. A loopback port that could not be bound is very likely a transient exhaustion, and the next attempt asks for a different one. |
 * | `config-invalid` | `unparseable` | the maintainer | A command references a `${VAR}` ADL does not supply. Non-retryable — it will not interpolate next time either — so the round escalates rather than spinning. |
 * | `build-failed` | **`send_back`** | the developer | `commands.build` exited non-zero. This is the single most likely developer error in the whole lifecycle, and it is exactly what a send-back is for. |
 * | `start-failed` | `binary_missing` | the operator | `Workspace.exec` refused the start command outright, so no app ever existed to judge. Non-retryable. |
 * | `app-exited-before-ready` | **`send_back`** | the developer | The app booted and then died. An implementation that crashes on startup is a defect in the work under judgement. |
 * | `never-ready` | `timeout` | unknown, so retry | Retryable and costs no round. This is the honest first answer: it may be a slow box, a lost port race, or a genuinely wedged app, and `planTransientRetry` spends a real budget finding out before anybody is woken. |
 * | `teardown-failed` | **reported only** | the operator | The gate had already judged by the time `commands.teardown` ran, so this cannot change the verdict — and inventing a failure here would let a leaked container overturn a correct approval. It goes on the transcript and the daemon log. |
 *
 * **Both the `pass` and the `inconclusive` columns are empty.** `pass` because
 * the answer type cannot express it. `inconclusive` for a reason worth writing
 * down: the escalation the sketch wanted `inconclusive` for already exists and is
 * strictly better. `never-ready` rides `timeout`, `planTransientRetry` retries it
 * on the provider budget with real backoff, and when that budget is spent it
 * escalates **naming what was tried** — which is what a human needs and what a
 * bare `inconclusive` verdict does not carry.
 *
 * ## Two rows are `send_back`, and that is the interesting half
 *
 * `build-failed` and `app-exited-before-ready` are the only failures here that
 * are evidence about the **work**, so they are the only ones that cost the
 * developer a round. Every other row is evidence about the machine, the
 * configuration, or the operator, and `stageErrorPolicy` already promises that a
 * `StageError` of any kind costs neither a round nor budget — which is CORE-06's
 * whole point, and is why nothing here restates it (rule 8).
 *
 * Neither send-back is certain of its attribution, and that is stated rather than
 * hidden: a `build` command that is itself wrong produces `build-failed` too. The
 * asymmetry is deliberate. A send-back that is really the operator's fault costs
 * one round and produces a finding naming the exact command and exit code, which
 * a human reads on the pull request. A `StageError` that is really the
 * developer's fault escalates to a human instead of to the agent that could have
 * fixed it — and after `NON_TRANSIENT_ESCALATION_THRESHOLD` failures it stops the
 * feature. The cheap mistake is the right one to prefer.
 */
import type { GlobalCategory } from '../verdict/criterion-ref.js';
import type { Severity } from '../verdict/finding.js';
import type { StageErrorKind } from './stage-error.js';

/**
 * Every way the app lifecycle can fail, as runtime data.
 *
 * Paired with {@link AppFailureKind} by the `Exclude<>` assertion at the foot of
 * this file, so a new failure added to the lifecycle without a row in
 * {@link APP_FAILURE_ANSWERS} fails the **build** rather than inheriting whatever
 * the last `else` branch happened to be (convention 7).
 */
export const APP_FAILURE_KINDS = Object.freeze([
  'port-unavailable',
  'config-invalid',
  'build-failed',
  'start-failed',
  'app-exited-before-ready',
  'never-ready',
  'teardown-failed',
] as const);

export type AppFailureKind = (typeof APP_FAILURE_KINDS)[number];

/**
 * What ADL does about one app-lifecycle failure.
 *
 * **Three channels, and the absence of a fourth is the guarantee.** There is no
 * member here carrying a {@link import('../verdict/verdict.js').Outcome}, so no
 * value of this type can say `pass` and none can say `inconclusive`. M08's
 * acceptance criterion 2 — *"an app that never becomes ready yields
 * `inconclusive`, never `pass`"* — has its load-bearing half enforced by the type
 * rather than by a mapping a future edit could get wrong.
 *
 * `send_back` carries the finding's shape but not its words: the detail strings
 * belong where the failure was observed, which is `@adl/manager`'s lifecycle, and
 * `@adl/core` performs no I/O and has no access to the command that failed.
 */
export type AppFailureAnswer =
  /**
   * The developer's round. Evidence about the work under judgement.
   */
  | {
      readonly channel: 'send_back';
      readonly severity: Severity;
      readonly category: GlobalCategory;
    }
  /**
   * Not a judgement at all (CORE-06, D-12). The kind carries `retryable`,
   * `consumesRound` and `consumesBudget` through `stageErrorPolicy`; nothing
   * here restates them.
   */
  | { readonly channel: 'stage_error'; readonly errorKind: StageErrorKind }
  /**
   * Recorded and visible, but it changes no verdict — because the gate had
   * already judged before this could happen.
   */
  | { readonly channel: 'report_only' };

/**
 * The table, as data rather than as a `switch`.
 *
 * A record so "what does ADL do about a never-ready app?" is a value a test can
 * read, rather than control flow it has to re-derive — the same reasoning
 * `AGENT_GATE_IMPLEMENTATIONS` and `STAGE_ERROR_POLICIES` are each written as
 * records for.
 */
const APP_FAILURE_ANSWERS = Object.freeze({
  'port-unavailable': { channel: 'stage_error', errorKind: 'provider_error' },
  'config-invalid': { channel: 'stage_error', errorKind: 'unparseable' },
  'build-failed': {
    channel: 'send_back',
    severity: 'blocker',
    category: 'build',
  },
  'start-failed': { channel: 'stage_error', errorKind: 'binary_missing' },
  'app-exited-before-ready': {
    channel: 'send_back',
    severity: 'blocker',
    category: 'build',
  },
  'never-ready': { channel: 'stage_error', errorKind: 'timeout' },
  'teardown-failed': { channel: 'report_only' },
} satisfies Record<AppFailureKind, AppFailureAnswer>);

/**
 * What ADL does about `kind`.
 *
 * A total function over a closed enum — the same shape as `stageErrorPolicy`, and
 * for the same reason: adding an eighth failure without deciding its answer is a
 * compile error here, not a silent default somewhere downstream.
 */
export function answerForAppFailure(kind: AppFailureKind): AppFailureAnswer {
  return APP_FAILURE_ANSWERS[kind];
}

/**
 * Compile-time proof that the record covers the enum.
 *
 * `Record<AppFailureKind, …>` already refuses a missing key; this is the other
 * direction — a key in the record that is not a real failure kind, which a rename
 * would otherwise leave behind as a row nothing can ever reach.
 *
 * **It only works because the table is checked with `satisfies`, not annotated**
 * (fixed in M08 step 8.5, when a stale key was injected and the build stayed
 * green). Annotated as `Readonly<Record<AppFailureKind, …>>`, the table's
 * `keyof` is the annotation's keys, never the literal's, so this `Exclude` was
 * `never` whatever the literal held — and an `Object.freeze` argument gets no
 * excess-property check. `satisfies` keeps the literal's own type, so a stale key
 * is refused twice: as an excess property, and here.
 */
type _EveryAppFailureAnswered =
  Exclude<keyof typeof APP_FAILURE_ANSWERS, AppFailureKind> extends never
    ? true
    : never;
const _everyAppFailureAnswered: _EveryAppFailureAnswered = true;
void _everyAppFailureAnswered;
