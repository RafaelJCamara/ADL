/**
 * The developer's own result (D-05, D-06, CORE-03).
 *
 * The developer is the one agent whose work is being judged, so it does not get
 * to return a `Verdict`. It gets this union instead, and this union has **no
 * `pass` member and no `outcome` field**. Self-approval is therefore
 * unrepresentable rather than forbidden by a runtime guard — the recurring
 * preference recorded in 01-CONTEXT.md § Specific Ideas, and the mitigation
 * `.planning/research/PITFALLS.md` Pitfall 1 measures at 92% down to 1%.
 *
 * **A dispute is an honest exit, not a bypass.** It routes to a human. It
 * issues no waiver — only a human can do that (D-07) — and it does not buy a
 * reconsideration round. A reconsideration round must not be designed:
 * REQUIREMENTS.md § Out of Scope excludes multi-agent arbitration precisely
 * because two agents can agree on something wrong, and escalating to a human is
 * cheaper and more honest than discovering that later.
 *
 * **A dispute consumes no round** ({@link DEVELOPER_OUTCOME_ROUND_COST}).
 * CORE-01 reserves round consumption for `send_back`. Charging for the honest
 * exit re-creates the exact economic pressure the exit exists to remove — a
 * developer that pays for disputing learns to stop disputing and start gaming
 * the gate instead.
 *
 * **Pipeline position.** The sequencer special-cases index 0 because `develop`
 * is always the implicit first mutator (D-05), so index 0 yields a
 * `DeveloperOutcome` while every later index yields a `StageOutcome`. That is
 * the contract Phase 5's Loop Runner implements against.
 */
import * as z from 'zod';

import { CriterionRefSchema } from '../verdict/criterion-ref.js';

/**
 * The three things the developer may report. Note what is absent.
 *
 * Exported as data so a consumer can enumerate the union without duplicating
 * the list — and so a test can assert that `pass` is not among them.
 */
export const DEVELOPER_OUTCOME_KINDS = Object.freeze(['committed', 'dispute', 'blocked'] as const);

export type DeveloperOutcomeKind = (typeof DEVELOPER_OUTCOME_KINDS)[number];

/**
 * A hexadecimal git object name — full, or abbreviated as git itself allows.
 *
 * Linear with no nested quantifiers, so catastrophic backtracking is not
 * reachable (threat T-1-11, consistent with the disposition on the other
 * validation regexes in this package).
 */
const GIT_SHA = /^[0-9a-f]{7,64}$/;

/**
 * What a dispute is aimed at.
 *
 * A **required discriminated union**, not two optional fields. Two optionals
 * would let a payload arrive with neither set — which is exactly the "missing
 * any of those makes it malformed" case D-06 rules out — and no amount of
 * documentation makes that unrepresentable. The union does.
 */
export const DisputeTargetSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('finding'),
        /** The `Finding.fingerprint` being disputed — the same stall-detection key. */
        fingerprint: z.string().length(64),
      })
      .meta({ id: 'DisputeTargetFinding' }),
    z
      .object({
        kind: z.literal('stage'),
        /** The gate being disputed as a whole, when no single finding captures it. */
        stageId: z.string().min(1),
      })
      .meta({ id: 'DisputeTargetStage' }),
  ])
  .meta({
    id: 'DisputeTarget',
    description: 'The specific finding, or the whole stage, a dispute is aimed at',
  });

export type DisputeTarget = z.infer<typeof DisputeTargetSchema>;

/**
 * A structured disagreement with a gate (D-06).
 *
 * All three fields are required. Missing any one of them makes the payload
 * *malformed* — not a weaker dispute.
 *
 * Structure is the whole value here. It is what makes a dispute triageable by
 * the human who receives it, fingerprintable for Phase 6's stall detection
 * ("the developer disputed the same finding twice"), and renderable on the pull
 * request beside the gate's own position rather than as a wall of prose.
 */
export const DisputeSchema = z
  .object({
    /** Which acceptance criterion — or which global category — is in dispute. */
    criterionRef: CriterionRefSchema,
    /** The finding or the stage being disputed. One or the other, never neither. */
    target: DisputeTargetSchema,
    /** Why the developer believes the gate is wrong. Prose, but never empty. */
    argument: z.string().min(1),
  })
  .meta({
    id: 'Dispute',
    description: 'A structured, triageable disagreement with a gate — escalates to a human',
  });

export type Dispute = z.infer<typeof DisputeSchema>;

/** The developer wrote code and committed it. The ordinary case. */
export const CommittedOutcomeSchema = z
  .object({
    kind: z.literal('committed'),
    /** The commit the round produced. */
    sha: z.string().regex(GIT_SHA),
  })
  .meta({ id: 'CommittedOutcome' });

/** The developer believes a gate is wrong and says so, in a shape a human can triage. */
export const DisputeOutcomeSchema = z
  .object({
    kind: z.literal('dispute'),
    dispute: DisputeSchema,
  })
  .meta({ id: 'DisputeOutcome' });

/** The developer cannot proceed — and says so rather than committing something plausible. */
export const BlockedOutcomeSchema = z
  .object({
    kind: z.literal('blocked'),
    reason: z.string().min(1),
  })
  .meta({ id: 'BlockedOutcome' });

/**
 * What the developer returns.
 *
 * Exactly three members. There is no `pass`, and there is no `outcome` field for
 * one to hide in — a developer agent emitting self-approval fails `parse()`
 * structurally, because the union has nowhere to put it (threat T-1-07).
 */
export const DeveloperOutcomeSchema = z
  .discriminatedUnion('kind', [CommittedOutcomeSchema, DisputeOutcomeSchema, BlockedOutcomeSchema])
  .meta({
    id: 'DeveloperOutcome',
    description: "The developer's own result — report, dispute, or blocked. Never approval.",
  });

export type DeveloperOutcome = z.infer<typeof DeveloperOutcomeSchema>;
export type CommittedOutcome = z.infer<typeof CommittedOutcomeSchema>;
export type DisputeOutcome = z.infer<typeof DisputeOutcomeSchema>;
export type BlockedOutcome = z.infer<typeof BlockedOutcomeSchema>;

/**
 * How many of the feature's finite rounds each developer outcome costs: **zero,
 * for all three**.
 *
 * A table rather than a `return 0`, so that adding a fourth kind is a compile
 * error here — a deliberate decision point rather than a silent default. And a
 * table rather than a predicate mirroring `consumesRound(verdict)`, because
 * `consumesRound` takes a `Verdict` and a `DeveloperOutcome` is not one; the two
 * are never interchangeable and this file does not pretend otherwise.
 *
 * `send_back` is the only thing in ADL that consumes a round (CORE-01).
 */
export const DEVELOPER_OUTCOME_ROUND_COST: Readonly<Record<DeveloperOutcomeKind, 0>> = Object.freeze(
  {
    committed: 0,
    dispute: 0,
    blocked: 0,
  },
);
