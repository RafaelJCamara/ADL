# Architecture Research

**Domain:** Self-hosted multi-agent delivery daemon (manager/worker control plane orchestrating AI coding loops across git forges)
**Researched:** 2026-08-17
**Confidence:** MEDIUM — patterns and precedents are well-established and verified across multiple sources; the specific composition for this domain has few public exemplars (OpenHands is the closest), so the synthesis is opinionated inference rather than a documented standard.

---

## Executive Recommendation (read this first)

Six decisions carry most of the architectural risk. Everything else in this document follows from them.

1. **The lifecycle state machine must not contain the gate pipeline.** Stages are data (`current_stage_index` + `stage_attempts` rows), not states. If adding a harness edits the state machine, "pluggable harness" is a lie. → §2, §3
2. **The agent adapter must invoke agent CLIs through `workspace.exec()`, never `child_process.spawn` directly.** This is the single decision that makes the container-backend swap real rather than aspirational. → §4, §5
3. **The commit is the checkpoint.** Crash recovery re-runs the failed stage attempt; anything not committed to the branch is discarded. This gives at-least-once activity semantics (Temporal's activity boundary) without a durable-execution engine. → §1
4. **Session resume is an optimisation, never a correctness requirement.** The core loop must work when a backend cannot resume. This is the rule that keeps vendor neutrality real under contact with three CLI backends. → §4
5. **Acceptance-criterion IDs are the join key** across spec → reviewer findings → tester results → PR comment. Without them, verdicts are prose and traceability dies. → §7
6. **v1 has no isolation boundary, and that is a bigger deal than PROJECT.md records.** Worktrees solve concurrency, not isolation. → §Flags

---

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│  CONSUMERS                                                               │
│  ┌──────────┐   ┌──────────────┐   ┌─────────────────┐                   │
│  │   CLI    │   │  Dashboard   │   │  Forge webhook  │                   │
│  │ (client) │   │    (SPA)     │   │    delivery     │                   │
│  └────┬─────┘   └──────┬───────┘   └────────┬────────┘                   │
│       │  HTTP + SSE    │  HTTP + SSE        │ HTTP (raw body)            │
├───────┴────────────────┴────────────────────┴────────────────────────────┤
│  MANAGER  (control plane — singular, long-running, owns all state)       │
│                                                                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────────┐  │
│  │ HTTP API   │  │ Detector   │  │ Lease      │  │ Accountant         │  │
│  │ + SSE hub  │  │ webhook +  │  │ Broker     │  │ rounds, spend,     │  │
│  │ + authn    │  │ poller     │  │ + Reaper   │  │ budget interrupts  │  │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────────┬──────────┘  │
│        │               │               │                   │             │
│  ┌─────┴───────────────┴───────────────┴───────────────────┴──────────┐  │
│  │            State Engine  (transition fn + optimistic locking)      │  │
│  └─────────────────────────────┬──────────────────────────────────────┘  │
│        ┌─────────────┐  ┌──────┴───────┐  ┌──────────────┐               │
│        │ Config      │  │ Outbox Relay │  │ Credential   │               │
│        │ Resolver    │  │ (side fx)    │  │ Broker       │               │
│        └─────────────┘  └──────┬───────┘  └──────────────┘               │
├────────────────────────────────┼─────────────────────────────────────────┤
│  PERSISTENCE (manager-only)    │                                         │
│  ┌──────────────┐  ┌───────────┴──────┐  ┌──────────────────────────┐    │
│  │ SQLite (WAL) │  │  Artifact Store  │  │ Log Store (NDJSON,       │    │
│  │ state+ledger │  │  (content-addr)  │  │ byte-offset addressable) │    │
│  └──────────────┘  └──────────────────┘  └──────────────────────────┘    │
├──────────────────────────────────────────────────────────────────────────┤
│         ▲ lease/heartbeat/report over loopback HTTP (fencing token)      │
│         │                                                                │
├─────────┴────────────────────────────────────────────────────────────────┤
│  WORKER  (execution plane — separate OS process, one feature at a time)  │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │  Loop Runner  — round loop, stage sequencing, send-back assembly  │    │
│  └───────┬───────────────────────┬───────────────────────┬──────────┘    │
│          │                       │                       │               │
│  ┌───────┴────────┐   ┌──────────┴─────────┐   ┌─────────┴──────────┐    │
│  │ Stage Registry │   │  Prompt Builder    │   │ Workspace Backend  │    │
│  │ agent | command│   │  spec+ctx+findings │   │ (worktree | oci)   │    │
│  └───────┬────────┘   └──────────┬─────────┘   └─────────┬──────────┘    │
│          │                       │                       │               │
│  ┌───────┴───────────────────────┴───────┐               │               │
│  │  Agent Adapter Layer                  │               │               │
│  │  delegated-loop CLIs | owned-loop APIs│──── exec ─────▶│               │
│  └───────────────────────────────────────┘               │               │
├──────────────────────────────────────────────────────────┼───────────────┤
│  EXTERNAL                                                ▼               │
│   Model providers (Anthropic/OpenAI/Google)      Target repo working tree│
│   Forge APIs (GitHub/GitLab/Gitea) ◀── via manager Outbox only ──────────│
└──────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Plane | Owns | Typical Implementation |
|-----------|-------|------|------------------------|
| HTTP API + SSE hub | Manager | The only public surface; authn; resource endpoints; log/transcript streaming | Fastify + `text/event-stream`, unix socket + loopback TCP |
| Detector | Manager | Turning "a feature folder exists and isn't built" into a `discovered` row | Webhook handler (raw-body HMAC) + interval poller, both feeding one idempotent `reconcile()` |
| Lease Broker + Reaper | Manager | Handing exactly one feature to exactly one worker; expiring dead leases | Atomic conditional `UPDATE ... RETURNING` + monotonic fencing token; reaper on a timer |
| State Engine | Manager | The only code allowed to change `features.state`; emits `feature_events` | Pure transition function + optimistic concurrency on `state_version` |
| Accountant | Manager | Round counter, token/cost ledger, admission checks, budget interrupts | Ledger table + check on round boundary + abort signal push to worker |
| Config Resolver | Manager | Merging daemon config, per-repo `adl.yml`, and defaults into one frozen `EffectiveConfig` per run | Zod-validated schema, snapshotted into the DB at lease time |
| Credential Broker | Manager | Issuing scoped, short-lived credentials to workers; never persisting secrets in worker-readable places | Env injection at spawn (v1) → git credential helper callback (v2) |
| Outbox Relay | Manager | All forge side effects (open CR, comment, label) exactly once | `outbox` table written in the same txn as the state change; poller drains with idempotency keys |
| Loop Runner | Worker | Round loop, stage ordering, send-back brief assembly, escalation triggers | Plain async TS; no DB access — talks to manager over HTTP |
| Stage Registry | Worker | Resolving configured stage ids to `Stage` implementations | Config-declared ids → built-ins + npm-resolved plugins |
| Agent Adapter Layer | Worker | Turning an `AgentTask` into a normalised `AgentEvent` stream | One adapter per backend; delegated-loop adapters wrap CLI NDJSON |
| Workspace Backend | Worker | Create / exec / read / write / snapshot / destroy an isolated checkout | git worktree (v1); OCI container (v2) |
| Forge Adapter | Manager | Change-request and comment operations; webhook verification and parsing | One module per forge behind a capability-flagged interface |

---

## 1. Control Plane / Execution Plane Split

### The allocation rule

**Manager owns anything that must be singular or must survive a crash. Worker owns anything that can be thrown away and re-run.**

Applying that rule:

| Concern | Manager | Worker | Why |
|---------|:-------:|:------:|-----|
| Webhook endpoint | ✅ | | One URL, one secret |
| Database | ✅ | | Single writer; SQLite in WAL has exactly one writer anyway |
| Queue + leases | ✅ | | Arbitration is inherently central |
| Round counter, spend ledger | ✅ | | A crashed worker must not lose accounting; a lying worker must not be trusted |
| Config resolution | ✅ | | Snapshot-once semantics; worker receives a frozen config |
| Forge writes (CR, comments) | ✅ | | Outbox + idempotency needs the DB txn |
| Model API credentials | ✅ issues | ✅ holds in-process | Unavoidable: the CLI subprocess needs the key in its env |
| Git push credential | ✅ issues | ✅ uses | v1: injected env. v2: credential-helper callback to manager |
| Workspace lifecycle | | ✅ | Local to execution; recreatable |
| Agent invocation | | ✅ | The thing that must be crash-isolated |
| Prompt assembly | | ✅ | Deterministic from inputs the manager supplied |
| Transcript bytes | | ✅ produces | ✅ streams to manager's log store; manager owns durability |

**Non-obvious call:** forge *reads* (does the PR still exist? was it merged?) also belong to the manager, because they feed detection and state transitions. The worker never talks to a forge API. It only talks to git (push) and to model providers. This keeps the worker's blast radius to: the workspace, the model bill, and one branch.

### Lease protocol

```sql
-- claim (atomic, single statement)
UPDATE features
   SET state = 'leased',
       lease_owner = :worker_id,
       lease_token = lease_token + 1,          -- monotonic fencing token
       lease_expires_at = :now + :ttl,
       heartbeat_at = :now,
       state_version = state_version + 1
 WHERE id = (
   SELECT id FROM features
    WHERE state = 'queued'
      AND (lease_expires_at IS NULL OR lease_expires_at < :now)
      AND repo_id IN (:enabled_repos)
    ORDER BY priority DESC, discovered_at ASC
    LIMIT 1
 )
RETURNING id, lease_token;
```

- **TTL 120s, heartbeat every 20s** (6× margin). Long agent turns do not block the heartbeat because subprocess I/O is async — but a heartbeat that shares an event loop with a busy sync parser will miss. Put the heartbeat on a dedicated `setInterval` and never do sync work on the worker's main loop.
- **Fencing token on every worker→manager call.** The manager rejects any report whose `lease_token` isn't current. This is the defence against the classic failure: worker hangs, lease expires, another worker takes the feature, the first worker wakes up and writes stale results. Precedent: [fencing tokens in lease-based job systems](https://github.com/kritibehl/faultline); Postgres `SKIP LOCKED` queues (`pg-boss`, `graphile-worker`) implement the same claim with different syntax.
- **Reaper** runs in the manager on a 30s timer: expired lease → `state = 'queued'`, `crash_count += 1`, append a `lease_expired` event. After `crash_count >= 3` → `escalated` with reason `repeated_worker_crash`, so a poison feature can't spin forever.
- **Graceful stop:** on SIGTERM the worker aborts the current stage, releases the lease explicitly (`lease_expires_at = now`), and exits. That turns a deploy restart into a ~0s recovery instead of a 120s one.

Postgres is the natural home for this (`SELECT ... FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY`), but for a self-hosted single-node daemon **SQLite in WAL mode is the right call**: no second process to install, and the write concurrency ceiling (one writer) is irrelevant at concurrency 1–4. The claim statement above works on SQLite as written. Keep the DAL narrow enough that a Postgres driver is a later swap, not a rewrite.

### Crash recovery: what is kept, what is discarded

The recovery model is the most load-bearing part of this design, and it should be stated as one rule:

> **The git commit is the checkpoint. The stage attempt is the unit of retry. Uncommitted work is discarded.**

Concretely:

- The developer stage **must commit before returning a verdict.** No commit → the round produced nothing → re-run from the last commit.
- The worktree is *durable* (it survives worker death), so recovery re-attaches to the existing workspace rather than recloning. `WorkspaceBackend.attach(handle)` exists for exactly this.
- On reclaim, the manager marks any `stage_attempts` row in `running` for that feature as `abandoned` (with `abandon_reason`), and the new worker restarts from `current_stage_index` of the current round.
- Cost already burned by the abandoned attempt **stays on the ledger.** You paid for it. Not charging it makes budget enforcement game-able by crash.
- Side effects that escaped (a PR comment posted just before the crash) are handled by the outbox's idempotency key, not by retry logic in the worker.

This is deliberately the Temporal *activity* model rather than the Temporal *workflow* model: agent output is nondeterministic, so replay-to-restore is impossible; re-execute-with-at-least-once is the only honest semantics. Everything a rerun could duplicate must carry an idempotency key.

**Do not adopt Temporal/Inngest/Restate for v1.** They solve durable multi-step orchestration, but they impose a server dependency (Temporal), a hosted/serverless model (Inngest), or determinism constraints on the loop body — all hostile to a "drop a daemon on your own box" product. Borrow the three ideas that matter (durable event log, explicit checkpoint boundaries, signal-driven resume) and keep them in ~400 lines of your own code. Revisit if multi-repo fleet management arrives.

---

## 2. State Machine

### The critical structural decision

Model the **lifecycle** as a small fixed state machine, and the **pipeline position** as data alongside it.

```
                 ┌──────────────┐
                 │  discovered  │  spec parsed? config valid?
                 └──────┬───────┘
                        │ admit
                        ▼
   ┌──────────────▶ ┌────────┐ ◀───── lease_expired / worker_crash
   │                │ queued │ ◀───── resume (from paused)
   │                └───┬────┘
   │                    │ lease_acquired
   │                    ▼
   │                ┌────────┐
   │                │ leased │  workspace create / attach, adl.yml build
   │                └───┬────┘
   │                    │ workspace_ready
   │                    ▼
   │              ┌────────────┐ ◀──────────────────────┐
   │              │ developing │                        │ send_back
   │              └─────┬──────┘                        │ (round += 1)
   │                    │ dev_committed                 │
   │                    ▼                               │
   │              ┌────────────┐ ──────────────────────┘
   │              │  gating    │  ← current_stage_index walks the pipeline
   │              └─────┬──────┘     (review, harnesses, behaviour test)
   │                    │ all_gates_passed
   │                    ▼
   │              ┌────────────┐
   │              │ publishing │  push branch, outbox: open CR + comments
   │              └─────┬──────┘
   │                    │ cr_opened
   │                    ▼
   │              ┌────────────┐
   │              │  pr_open   │  ← human territory; ADL only observes
   │              └──┬──────┬──┘
   │                 │      │ cr_merged        ┌──────────┐
   │      cr_closed  │      └─────────────────▶│  merged  │ (terminal)
   │                 ▼                          └──────────┘
   │            ┌───────────┐
   │            │ abandoned │ (terminal)
   │            └───────────┘
   │
   │   any non-terminal ──limit_exceeded / unrecoverable──▶ ┌───────────┐
   │                                                        │ escalated │
   └────────────────────── human retry ─────────────────────┴───────────┘

   any non-terminal ──human pause──▶ paused ──resume──▶ queued
```

**`gating` is one state, not N states.** The pipeline is `EffectiveConfig.pipeline` (an ordered list) and `features.current_stage_index`. Adding a security harness adds a config entry and a `stage_attempts` row — it does not touch the state machine, does not need a migration, and cannot break an in-flight feature. This is the difference between "harnesses are pluggable" and "harnesses are pluggable if you're willing to redeploy the state machine."

The counter-argument — "but then the dashboard can't show which gate is running" — is wrong: the dashboard reads `current_stage_index` + the `stage_attempts` table, which is richer than a state name anyway (it has per-stage timing, cost, and verdict).

### Where counters and budgets are enforced

Two enforcement points, because one is not enough:

| Check | Where | Semantics |
|-------|-------|-----------|
| **Admission check** (hard) | In the `gating → developing` send-back transition, *inside* the transaction | `round + 1 > max_rounds` OR `spend_usd >= budget_usd` → transition to `escalated` instead, reason `round_limit` / `budget_limit` |
| **Interrupt check** (soft) | Accountant, on every usage report from the worker | Spend crosses budget mid-stage → manager pushes `abort` on the worker's control channel → worker aborts the stage → `escalated`, reason `budget_limit_midstage` |
| **Stall check** (heuristic) | Send-back assembly, worker-side | Same finding fingerprint recurs ≥ `repeat_finding_threshold` (default 2) consecutive rounds → escalate with reason `agent_disagreement`, attaching both agents' positions |

The stall check deserves emphasis. The failure mode PROJECT.md names — "developer/reviewer disagreement can loop indefinitely" — is detectable *cheaply* by fingerprinting findings (`sha256(stage_id + normalised_title + path)`). Detecting it at round 3 instead of round 6 halves the cost of every stalemate. Round and budget caps are the backstop, not the primary mechanism.

### Persistence and versioning

**Recommendation: DB column as canonical state + a pure TypeScript transition function + an append-only event log. Do not make XState the source of truth.**

```ts
// packages/core/src/state.ts — no I/O, exhaustively tested, zero dependencies
export type FeatureState =
  | 'discovered' | 'queued' | 'leased' | 'developing' | 'gating'
  | 'publishing' | 'pr_open' | 'merged' | 'escalated' | 'abandoned' | 'paused';

export type FeatureEvent =
  | { t: 'admit' } | { t: 'lease_acquired'; workerId: string }
  | { t: 'workspace_ready' } | { t: 'dev_committed'; sha: string }
  | { t: 'gate_passed'; stageId: string } | { t: 'all_gates_passed' }
  | { t: 'send_back'; stageId: string; findingCount: number }
  | { t: 'cr_opened'; ref: ChangeRequestRef } | { t: 'cr_merged' } | { t: 'cr_closed' }
  | { t: 'lease_expired' } | { t: 'limit_exceeded'; reason: LimitReason }
  | { t: 'pause'; by: string } | { t: 'resume'; by: string }
  | { t: 'unrecoverable'; reason: string };

export function transition(
  s: FeatureState, e: FeatureEvent, ctx: TransitionCtx
): TransitionResult { /* returns { next, effects[], counters } or an InvalidTransition */ }
```

Every applied transition writes one row to `feature_events (feature_id, seq, from_state, to_state, event_json, actor, at)` **in the same transaction** as the `features` update. Benefits: the audit trail is free, the dashboard timeline is a `SELECT`, the PR rollup comment is generated from it, and post-mortems are possible without log spelunking. Precedent: OpenHands' append-only typed event stream, which its own architecture paper reports as having negligible overhead and high diagnostic value.

Concurrency control: `UPDATE features SET state=?, state_version=state_version+1 WHERE id=? AND state_version=?`. Zero rows updated → someone else moved it → reload and re-decide. Never `SELECT` then `UPDATE` without the version guard.

Versioning rules (learn these from other people's pain — statechart migration of in-flight instances is a known unsolved problem):
- **Never rename or delete a state.** Add new ones. Retired states get a forward migration that maps them, run once at startup.
- `meta.schema_version` gates startup: refuse to run against a newer schema, auto-migrate an older one, and take a DB file copy before migrating.
- The `EffectiveConfig` (including the pipeline) is **snapshotted into the feature row at lease time**. Changing `adl.yml` mid-flight must not change the pipeline of a running feature. Same for the spec: snapshot `spec_hash` and the normalised spec at lease time; an edited spec creates a new feature *revision*, it does not mutate the running one.

XState is still useful — as a *test oracle* and diagram generator over the same transition table. Just don't let a library's persisted snapshot format become your schema.

---

## 3. Stage / Gate Abstraction

### The interface

```ts
export interface Stage {
  readonly id: string;                 // stable; what adl.yml references
  readonly kind: 'agent' | 'command';
  readonly mutates: boolean;           // may it modify the workspace? gates parallelism
  readonly costClass: 'free' | 'cheap' | 'expensive';   // drives fail-fast policy
  run(ctx: StageContext): Promise<Verdict>;
}

export interface StageContext {
  readonly workspace: Workspace;             // exec / read / write / snapshot
  readonly feature: FeatureView;             // normalised spec, branch, round, headSha
  readonly config: StageConfig;              // this stage's config block from adl.yml
  readonly priorFindings: readonly Finding[];// findings from earlier stages, this round
  readonly history: readonly RoundSummary[]; // compressed prior rounds
  readonly agents: AgentRunner;              // only way to call a model; meters cost
  readonly artifacts: ArtifactSink;          // write evidence blobs
  readonly log: (chunk: LogChunk) => void;   // streams to manager
  readonly signal: AbortSignal;              // budget interrupt / pause / shutdown
}

export type Verdict =
  | { outcome: 'pass';      summary: string; evidence?: Evidence[] }
  | { outcome: 'send_back'; summary: string; findings: Finding[]; evidence?: Evidence[] }
  | { outcome: 'fail';      summary: string; reason: string; evidence?: Evidence[] }
  | { outcome: 'skip';      reason: string };

export interface Finding {
  fingerprint: string;      // stable across rounds — powers stall detection
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  title: string;
  detail: string;                       // markdown, agent-readable
  location?: { path: string; line?: number; endLine?: number };
  criterionId?: string;                 // links back to the spec (see §7)
  suggestedAction?: string;
  evidenceRefs?: string[];
}
```

**`fail` vs `send_back` is the important distinction and it is frequently missed.** `send_back` means *the developer can fix this* — it costs a round. `fail` means *the gate itself is broken or the problem is outside the developer's reach* (build tooling missing, harness binary not installed, model auth failed) — it escalates immediately without burning rounds. Collapsing these into one "not pass" is how you get a system that spends six rounds and $15 discovering that `npm ci` was never going to work.

### Making an agent and a shell command interchangeable

The command adapter is thin, and that thinness is the proof the abstraction holds:

```ts
class CommandStage implements Stage {
  kind = 'command' as const;
  async run(ctx: StageContext): Promise<Verdict> {
    const verdictFile = `.adl/verdicts/${this.id}.json`;
    const r = await ctx.workspace.exec({
      argv: this.cfg.argv, cwd: this.cfg.cwd ?? '.',
      env: { ADL_VERDICT_FILE: verdictFile, ADL_FEATURE_ID: ctx.feature.id },
      timeoutMs: this.cfg.timeoutMs, signal: ctx.signal, stream: ctx.log,
    });

    // 1. structured escape hatch wins if present
    const structured = await ctx.workspace.tryReadJson(verdictFile);
    if (structured) return parseVerdict(structured);

    // 2. SARIF, if the tool emits it (semgrep, codeql, eslint --format sarif, trivy…)
    if (this.cfg.sarifPath) return sarifToVerdict(await ctx.workspace.readFile(this.cfg.sarifPath));

    // 3. exit-code convention
    if (r.code === 0) return { outcome: 'pass', summary: `${this.id} exited 0` };
    if (this.cfg.failCodes?.includes(r.code)) return { outcome: 'fail', summary: …, reason: … };
    return { outcome: 'send_back', summary: `${this.id} exited ${r.code}`, findings: [{
      fingerprint: fp(this.id, r.tail), severity: 'blocker',
      title: `${this.id} failed`, detail: '```\n' + r.tail(8_000) + '\n```',
    }]};
  }
}
```

Three ways in, ordered by fidelity. **Accept SARIF natively** — it is the existing standard for static-analysis findings (semgrep, CodeQL, Trivy, ESLint, Bandit all emit it), and supporting it means the reference security harness is mostly configuration rather than code. That is a strong signal the extension point is real.

The agent adapter is symmetric: it calls `ctx.agents.run(task)` with `outputSchema: VerdictSchema` and parses the structured result, falling back to fenced-JSON extraction with one repair retry when the backend lacks schema support (§4).

### Ordering, configuration, and parallelism

```yaml
pipeline:
  - develop                                   # implicit first; always the mutator
  - review:                                   # built-in agent stage
      on_send_back: stop                      # expensive → fail fast
  - group:                                    # v2: only mutates:false stages allowed here
      - harness: security
      - harness: licence-scan
  - test:                                     # behaviour tester agent
      commit_tests: true
```

Position is a list index — this satisfies "positionable at any point in the pipeline" without any concept of before/after hooks. **Config-declared ordering beats plugin-declared priority**; ESLint learned this and it is why `extends`/rule order lives in config rather than in the plugins.

**v1: sequential only. Ship the `group:` syntax as parse-and-reject, so the config shape doesn't break later.** Parallel gates are blocked on two real constraints: a mutating stage (a formatter harness) cannot run alongside anything over one worktree, and concurrent `exec` in one worktree fights over git index locks. The `mutates` flag plus `Workspace.snapshot()` are what unlock it — which is why `snapshot()` is in the workspace interface from day one even though the worktree backend's implementation is a hidden-ref commit.

**Fail-fast policy, per stage, defaulted by cost class:**
- `costClass: 'cheap' | 'free'` (command harnesses) → default `on_send_back: continue`. Run them all, merge findings, send back once. The developer fixes lint + security + tests in one round instead of three.
- `costClass: 'expensive'` (agent stages) → default `on_send_back: stop`. Don't pay an agent reviewer to review code the tests already rejected.
- `outcome: 'fail'` always stops immediately, regardless of policy.

This policy is worth real money: it is the difference between one round per gate and one round per code-quality generation.

### Stage output → next round's developer context

The send-back brief is assembled by the Loop Runner, not by any stage:

```ts
interface SendBackBrief {
  round: number; roundsRemaining: number; budgetRemainingUsd: number | null;
  stages: { stageId: string; outcome: Verdict['outcome']; summary: string }[];
  findings: Finding[];         // merged, sorted blocker→nit, deduped by fingerprint
  repeated: Finding[];         // seen in a previous round too — flagged loudly
  lastRoundDiffStat: { files: number; insertions: number; deletions: number };
  evidence: EvidenceRef[];     // workspace-relative PATHS, never inlined blobs
  priorRounds: RoundSummary[]; // one line each; compressed, oldest truncated first
}
```

Rules that matter:
- **Evidence is referenced, not inlined.** A 40k-line test log inlined into the prompt is how a $2 round becomes a $9 round. Write it to the workspace at `.adl/evidence/<round>/<stage>.log` and give the agent the path — delegated-loop backends will read it if they need it. (Owned-loop backends need a `read_file` tool for the same reason, §4.)
- **Repeated findings are surfaced explicitly and framed as a disagreement**, not repeated as a fresh instruction. "The reviewer raised this in round 2 and you did not resolve it; either resolve it or state why it should be waived" produces materially different behaviour than restating the finding.
- **The brief is rendered to markdown and persisted as an artifact.** The exact text the developer saw is the first thing anyone debugging a stuck loop wants.

---

## 4. Agent Adapter Layer

### The real problem

There are two structurally different backend families, and pretending otherwise produces either a lowest-common-denominator adapter or an adapter shaped like whichever one you built first.

| | **Delegated-loop** (Claude Code, Codex CLI, Gemini CLI) | **Owned-loop** (Anthropic/OpenAI/Gemini APIs) |
|---|---|---|
| Who runs the agentic loop | The CLI | ADL |
| Who supplies tools | The CLI (Read/Edit/Bash built in) | ADL must implement them over `Workspace` |
| File edits | Direct, on a real path | Via ADL's tools |
| Cost reporting | Reported by the CLI (estimate) | Tokens returned; ADL prices them |
| Failure modes | Process exit codes, stderr | HTTP status, SDK errors |
| Session continuity | Backend-specific resume | ADL owns the message array |

Verified surface (2026-08):
- **Claude Code**: `claude -p`, `--output-format text|json|stream-json`, NDJSON events (`system/init`, `assistant`, `user`, `result`, `system/api_retry`), `--resume <session_id>` / `--continue`, `--allowedTools` + `--permission-mode acceptEdits|dontAsk|plan`, `--append-system-prompt`, `--json-schema` → `structured_output`, `total_cost_usd` + per-model breakdown in JSON output, `--bare` to skip hook/plugin/MCP/CLAUDE.md discovery. Exit 0 / non-zero / 143 on SIGTERM.
- **Codex CLI**: `codex exec <prompt>`, progress on stderr and final message on stdout, `--json` for JSONL events, `--output-schema` + `-o` for structured final output, `--full-auto` / `--sandbox danger-full-access`.
- **Gemini CLI**: `-p`/`--prompt` (headless is also implicit on non-TTY), `--output-format json` (response + stats + metadata), `--yolo` to auto-approve tools.

All three converge on: prompt flag, JSON/NDJSON event stream, permission/sandbox flag, structured-output schema flag. That convergence *is* the adapter interface.

### The common interface

```ts
export interface AgentBackend {
  readonly id: string;                        // 'claude-code' | 'anthropic-api' | …
  readonly family: 'delegated-loop' | 'owned-loop';
  readonly capabilities: AgentCapabilities;
  run(task: AgentTask, ctx: AgentRunContext): AsyncIterable<AgentEvent>;
  probe(): Promise<ProbeResult>;              // binary present? auth valid? version?
}

export interface AgentCapabilities {
  editsWorkspaceDirectly: boolean;   // false ⇒ ADL must supply write tools
  readsWorkspaceDirectly: boolean;   // false ⇒ PromptBuilder must inline context
  supportsResume: boolean;
  supportsStructuredOutput: boolean; // false ⇒ fenced-JSON fallback
  reportsCost: 'usd' | 'tokens' | 'none';
  toolPolicyLevels: ToolPolicy[];    // which of the three levels it can honour
}

export interface AgentTask {
  role: 'developer' | 'reviewer' | 'tester' | 'harness';
  systemPrompt: string;
  instructions: string;                // fully rendered by PromptBuilder
  contextRefs: ContextRef[];           // workspace-relative paths + why each matters
  inlineContext?: InlineBlock[];       // populated only when !readsWorkspaceDirectly
  outputSchema?: JSONSchema;
  toolPolicy: 'read-only' | 'edit' | 'edit-exec';
  sessionRef?: string;                 // opportunistic only
  limits: { maxCostUsd?: number; maxWallClockMs: number; maxTurns?: number };
}

export type AgentEvent =
  | { t: 'started';     sessionRef?: string; model?: string }
  | { t: 'text';        delta: string }
  | { t: 'thinking';    delta: string }
  | { t: 'tool_call';   id: string; name: string; input: unknown }
  | { t: 'tool_result'; id: string; ok: boolean; preview: string }
  | { t: 'usage';       inputTokens: number; outputTokens: number; cachedTokens?: number;
                        costUsd?: number; costSource: 'reported' | 'computed' | 'unknown' }
  | { t: 'result';      text: string; structured?: unknown }
  | { t: 'error';       kind: 'auth'|'rate_limit'|'timeout'|'budget'|'crashed'|'refusal';
                        retryable: boolean; detail: string };
```

The event stream is the vendor-neutral spine: a delegated-loop adapter is a line-by-line translator from the CLI's NDJSON, an owned-loop adapter emits the same events from its own loop, and everything downstream (transcript store, cost ledger, dashboard SSE, PR comment generation) consumes one shape. Named precedents: OpenHands' typed `Action`/`Observation` event stream, and the [Agent Client Protocol](https://agentclientprotocol.com/) (Zed, Apache-2.0, JSON-RPC over stdio) which already has adapters for Claude Code, Gemini CLI, Codex CLI, Cline, and Goose.

> **Consider ACP as the transport for delegated-loop backends rather than writing three CLI wrappers.** It is explicitly modelled on LSP's unbundling of language intelligence and it is the closest thing to a standard here. The caveat is that ACP is *editor-session* shaped — permission prompts, UI updates, human-in-the-loop turns — and may not cleanly express unattended budget/cost reporting. Recommendation: define ADL's own `AgentBackend` interface as above (it is small), and evaluate ACP as the *implementation* of the delegated-loop adapters in a spike during the second-backend phase. Do not make ACP the core contract before you've run it unattended.

### Where the abstraction leaks (be honest about all six)

1. **Cost.** Claude Code reports `total_cost_usd` (a client-side estimate that can differ from the bill); Codex and Gemini report token stats in different shapes; raw APIs return tokens and you price them yourself. → Normalise to `{tokens, costUsd?, costSource}` and make the **Accountant tolerate `costSource: 'unknown'`** by falling back to round count and wall clock. A budget system that silently stops enforcing when a backend goes quiet is worse than no budget.
2. **Tool permissioning.** `--allowedTools`/`--permission-mode` vs `--sandbox`/`--full-auto` vs `--yolo` are not isomorphic. → ADL defines exactly **three** coarse levels (`read-only`, `edit`, `edit-exec`), each adapter documents its mapping, and `capabilities.toolPolicyLevels` declares what it can actually honour. Do not invent a fine-grained tool-permission DSL; you will be unable to implement it faithfully anywhere.
3. **Session resume.** Claude Code has `--resume <session_id>`; the others differ or lack it. → `supportsResume` is a capability and **the loop must be correct without it** (re-send the full brief each round). Resume is a token-cost optimisation. This single rule is what stops the core from quietly becoming Claude-shaped.
4. **Repo-local agent config.** All three CLIs auto-discover `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`, hooks, MCP servers, and plugins from the target repo. This makes runs non-reproducible *and* turns the target repo into an untrusted instruction channel. → **Disable discovery** (`claude --bare`, equivalents elsewhere) and let ADL be the sole source of context. If a team wants their `AGENTS.md` used, ADL should read it explicitly as a `ContextRef` so it's visible in the persisted prompt artifact.
5. **Structured output.** `--json-schema` (Claude) and `--output-schema` (Codex) exist; Gemini's is partial. → Capability flag; fallback is fenced-JSON extraction plus one repair turn ("your last message was not valid JSON for this schema; re-emit only the JSON"). Verdict-producing stages depend on this, so treat the fallback as a first-class path with its own tests, not an afterthought.
6. **Filesystem reality.** Delegated-loop CLIs edit files on a real path — the workspace cannot be a pure RPC surface. → See §5; the resolution is that the adapter launches the CLI *through* `workspace.exec()`.

### Prompt assembly and transcript capture

**PromptBuilder is a separate module and adapters never build prompts.** Adapters receive rendered text plus refs. This keeps prompt engineering in one reviewable place, makes prompts diffable across versions, and means a new backend costs an adapter, not a prompt rewrite.

- Templates: one per role, shipped as defaults, overridable per repo (`adl.yml: agents.developer.prompt_template`) and per-stage for harnesses.
- Rendering is deterministic given `(NormalizedSpec, EffectiveConfig, SendBackBrief, capabilities)`. Same inputs → byte-identical prompt.
- **Persist the rendered prompt as an artifact per stage attempt.** Non-negotiable for a system whose value proposition is "the reasoning is visible."
- Context strategy is capability-driven: `readsWorkspaceDirectly: true` → pass paths; `false` → inline with a byte budget and a documented truncation strategy (head+tail with an elision marker beats silent tail-drop).

**Transcript capture:** every `AgentEvent` appended to `logs/<feature>/<round>/<stage>/<attempt>.ndjson` in the manager's log store, streamed there from the worker. The DB gets only a rollup row (`token counts, cost, duration, event counts, result text`). **Never put transcripts in DB rows** — it bloats the file, ruins query performance, and makes the "state survives restart" backup story painful. Serve the NDJSON with byte-offset addressing so SSE reconnect resumes rather than replays (§9).

---

## 5. Workspace Backend Interface

```ts
export interface WorkspaceBackend {
  readonly id: 'worktree' | 'container' | string;
  create(spec: WorkspaceSpec): Promise<Workspace>;
  attach(handle: WorkspaceHandle): Promise<Workspace | null>;  // crash recovery
  gc(policy: GcPolicy): Promise<GcReport>;                     // NOT optional
}

export interface WorkspaceSpec {
  repo: RepoRef; baseRef: string; branch: string;
  networkPolicy: 'none' | 'egress-allowlist' | 'full';   // worktree ignores; container doesn't
  resources?: { cpus?: number; memoryMb?: number; diskMb?: number };
  env: Record<string, string>;
}

export interface Workspace {
  readonly handle: WorkspaceHandle;         // serialisable → persisted in features row

  // execution — the load-bearing method
  exec(spec: ExecSpec): Promise<ExecResult>;          // await to completion
  spawn(spec: ExecSpec): Promise<ProcessHandle>;      // long-running (adl.yml `start`)

  // content
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer | string): Promise<void>;
  list(glob: string): Promise<string[]>;
  stat(path: string): Promise<FileStat | null>;

  // checkpointing
  snapshot(label: string): Promise<SnapshotRef>;
  restore(ref: SnapshotRef): Promise<void>;

  destroy(opts: { keepOnFailure?: boolean }): Promise<void>;
}

export interface ExecSpec {
  argv: string[];                    // never a shell string — no shell injection surface
  cwd?: string;                      // workspace-relative
  env?: Record<string, string>;
  stdin?: Readable;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdout?: (c: Buffer) => void;    // streaming, not buffered-to-completion
  onStderr?: (c: Buffer) => void;
}
```

### What leaks if you design this carelessly

**Leak #1 — the fatal one: an adapter that spawns processes itself.** If `ClaudeCodeAdapter` calls `child_process.spawn('claude', …, {cwd: hostPath})`, then the workspace interface describes only *file access*, and a container backend would run the agent outside the container it was supposed to isolate. **All process execution — agent CLIs, `adl.yml` commands, git — goes through `workspace.exec()`/`spawn()`.** The container backend then implements `exec` as `docker exec` and everything above it is unchanged. This is the entire point of the interface and it is the one thing that is expensive to retrofit.

**Leak #2 — host paths escaping into data.** Findings, evidence refs, prompts, and PR comments must use **workspace-relative paths** exclusively. Translate at the boundary only. Otherwise `/home/adl/worktrees/abc123/src/x.ts` ends up in a PR comment and in an agent's prompt, and the container swap changes both.

**Leak #3 — assuming git is a host concern.** Put git behind a `GitOps` module that is implemented *in terms of* `workspace.exec(['git', …])`. Cloning/worktree creation is the backend's job; everything after (commit, diff, push, branch) is `GitOps`.

**Leak #4 — reading artifacts off a host path.** Evidence must be **pulled** with `readFile`, not read from `path.join(worktreePath, …)`. Two lines of convenience here silently pins you to host-local backends.

**Leak #5 — no `networkPolicy` in the spec.** The worktree backend ignores it, but if it isn't in `WorkspaceSpec` from day one, adding it later means changing every call site *and* discovering that nobody thought about whether `adl.yml: start` needs network. Add the field now with `'full'` as the v1 value and a documented TODO.

**Leak #6 — no `attach()`.** Without it, worker crash recovery either loses committed work or forces a reclone. `WorkspaceHandle` must be serialisable and persisted on the feature row.

**Leak #7 — no `gc()`.** Reported real-world experience with worktree-per-task AI agent workflows: 256 worktrees, 28 GB, 700+ stale branches. Worktree lifecycle must be a first-class, tested operation with an age/count policy — and it must use `git worktree remove` (never `rm -rf`, which leaves stale admin entries requiring `git worktree prune`) and parse `git worktree list --porcelain` for machine-readable state. Locked worktrees are never pruned, so ADL must not leave locks behind on crash.

**Worktree backend notes:** one bare/primary clone per repo under the daemon's data dir with a shared object store; `git worktree add -b adl/<feature-id> <path> <baseRef>`; a branch cannot be checked out in two worktrees at once (so feature id → branch must be unique); serialise `git gc`/`fetch` on the shared object store against active worktrees. `snapshot()` is implementable as a commit on a hidden ref (`refs/adl/snapshots/<feature>/<label>`) — cheap, and it survives worker death, unlike a stash.

---

## 6. Forge Abstraction

### Core + capabilities, not lowest common denominator

```ts
export interface Forge {
  readonly id: 'github' | 'gitlab' | 'gitea' | string;
  readonly capabilities: ForgeCapabilities;

  // git access
  cloneUrl(repo: RepoRef): string;
  gitCredential(repo: RepoRef): Promise<GitCredential>;   // short-lived where possible

  // change requests — deliberately forge-neutral vocabulary
  openChangeRequest(i: OpenCrInput): Promise<ChangeRequest>;
  getChangeRequest(ref: CrRef): Promise<ChangeRequest>;
  updateChangeRequest(ref: CrRef, patch: CrPatch): Promise<void>;

  // conversation
  postComment(ref: CrRef, body: string, key: IdempotencyKey): Promise<CommentRef>;
  editComment(ref: CommentRef, body: string): Promise<void>;
  findComment(ref: CrRef, marker: string): Promise<CommentRef | null>;

  // ingress
  verifyWebhook(headers: Headers, rawBody: Buffer, secret: string): VerifyResult;
  parseWebhook(headers: Headers, rawBody: Buffer): ForgeEvent | null;
}

export interface ForgeCapabilities {
  draftChangeRequests: boolean;
  inlineReviewComments: boolean;
  reviewStates: boolean;          // APPROVE / REQUEST_CHANGES as first-class objects
  requiredApprovals: boolean;
  labels: boolean;
  crReviewCommentWebhook: boolean;
}
```

Use **`ChangeRequest`**, not `PullRequest`. Forge-specific vocabulary in the core is how a "multi-forge" system ends up being GitHub with two ports.

### Where the three genuinely differ

| Concern | GitHub | GitLab | Gitea |
|---|---|---|---|
| Entity | Pull Request, repo-scoped `number` | Merge Request, project-scoped `iid` **and** a global `id` — using the wrong one is the classic bug | Pull Request, repo-scoped index |
| Repo addressing | `owner/repo` | numeric project id **or** URL-encoded `group%2Fproject` | `owner/repo` |
| General comments | issue-comments endpoint | notes API (issue / MR / commit scoped) | issue-comments endpoint doubles for PRs |
| Review model | Reviews with states | Approvals + notes; no review-state object | Reviews, GitHub-shaped |
| Draft | `draft: true` field | `Draft:` title prefix / `work_in_progress` | native draft support |
| Webhook auth | `X-Hub-Signature-256: sha256=<hex>` HMAC-SHA256 | Legacy plaintext `X-Gitlab-Token`; newer follows Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`) | `X-Gitea-Signature` hex HMAC-SHA256 + `X-Gitea-Event` |
| Event naming | `X-GitHub-Event: pull_request` + `action` field | `X-Gitlab-Event: Merge Request Hook` + `object_attributes.action` | `X-Gitea-Event: pull_request` + `action` |
| Code-comment webhook | yes | yes (note events) | **not implemented** |

The HMAC *mechanism* is identical everywhere; the header name, the encoding (hex vs base64), and the exact signed string differ. So `verifyWebhook` is ~15 lines per forge and is the easiest part. The hard parts are `iid` vs `id`, project addressing, and the review model.

### How to avoid the LCD trap

- **The core loop requires only:** push a branch, open a CR, post a body comment, edit a body comment, observe merged/closed. That's it. Everything else is optional.
- **Everything richer is capability-gated with an explicit documented fallback.** `inlineReviewComments: false` → findings render as a body comment with `path:line` prefixes. `reviewStates: false` → ADL doesn't try to model approval state; it observes merge only. Fallbacks live in a shared `ForgeFallbacks` module, not duplicated per adapter.
- **Never widen the core interface to accommodate one forge's richness.** If GitHub's review-thread resolution turns out to be valuable, it becomes an optional capability method, not a core method the other two stub out.

### Two implementation rules that prevent specific bugs

1. **`verifyWebhook` takes the raw body `Buffer`, before JSON parsing.** Body-parser round-tripping changes bytes and breaks HMAC — this is the single most common webhook bug. Configure the framework to retain the raw buffer on the webhook route only. Use `crypto.timingSafeEqual`. Where GitLab supplies `webhook-timestamp`, reject deliveries older than ~5 minutes.
2. **Every comment carries a hidden marker for idempotency + stickiness:** `<!-- adl:feature=<id> role=review -->`. On publish, `findComment(marker)` → `editComment` if found, else `postComment`. Precedent: sticky-comment bots on GitHub Actions.

> **Amendment to a recorded decision.** PROJECT.md says *"Every agent posts its own PR comment summarizing its work and outcome."* Taken literally, 6 rounds × 4 agents = 24 comments and the PR becomes unreadable — which defeats the stated goal ("a reviewer arriving cold can reconstruct what happened"). **Recommend: one sticky comment per agent role, edited in place to show current position plus a collapsed `<details>` round history, plus a single pinned rollup comment generated from `feature_events`.** Same information, same audit-trail property, readable. The intent survives; the literal implementation should change.

---

## 7. Context Assembly

```
adl.yml ─────────▶ ConfigResolver ─▶ EffectiveConfig ──┐  (snapshotted at lease time)
                                                        │
features/<id>/ ──▶ SpecLoader ─────▶ NormalizedSpec ────┤
  ├─ spec.md      (detect format)                       ├─▶ PromptBuilder ─▶ RenderedPrompt
  └─ *.feature                                          │      (per role)      (→ artifact)
                                                        │
context.files ───▶ ContextResolver ▶ ContextRef[] ──────┤
  (default README)  glob, size cap                      │
                                                        │
SendBackBrief (rounds ≥ 2) ─────────────────────────────┘
```

### Normalise once, at the loader — but keep the discriminant

```ts
export interface NormalizedSpec {
  id: string;                                   // folder name; also the branch suffix
  title: string;
  sourceFormat: 'adl-template' | 'gherkin';
  narrative?: string;                           // prose intent
  acceptanceCriteria: AcceptanceCriterion[];    // the join key lives here
  nonGoals?: string[];
  constraints?: string[];
  contextRefs: ContextRef[];                    // spec-local overrides of adl.yml context
  raw: string;                                  // ALWAYS the verbatim source
  specHash: string;                             // sha256(raw) — identity + change detection
}

export type AcceptanceCriterion =
  | { id: string; kind: 'statement'; text: string }
  | { id: string; kind: 'scenario'; name: string; tags: string[];
      steps: { keyword: 'Given'|'When'|'Then'|'And'|'But'; text: string }[];
      examples?: { headers: string[]; rows: string[][] } };
```

Two rules, both of which are commonly got wrong:

**Rule 1 — normalise the container, not the content.** Both formats produce an ordered, ID'd list of acceptance criteria. But `kind: 'scenario'` retains its Given/When/Then structure, because a Gherkin scenario is *directly executable* and flattening it to a sentence throws away exactly the property a BDD team adopted Gherkin for. The behaviour-tester agent should branch on `kind` and, for scenarios, generate step-aligned tests. That branch belongs in the *prompt template*, not in the loader.

**Rule 2 — always ship `raw` alongside the parse.** Never make an agent read only your parsed form; you will lose tables, links, embedded diagrams, and nuance. The prompt contains the raw spec verbatim *and* the normalised criteria as an ID'd checklist.

### Criterion IDs are the join key

This is the highest-leverage detail in this section. `AC-1`, `AC-2`… (or `SCN-1` for scenarios), assigned deterministically at parse time. They then propagate:

```
spec criterion AC-3
   → developer prompt   ("implement AC-1..AC-5")
   → reviewer Finding   { criterionId: 'AC-3', severity: 'blocker', … }
   → tester result      { criterionId: 'AC-3', status: 'fail', evidence: … }
   → send-back brief    (grouped by criterion, so the developer sees what's unmet)
   → PR rollup comment  (a coverage table: criterion → implemented? reviewed? tested?)
```

Without this, verdicts are prose, the send-back brief is a wall of unrelated complaints, and the PR comment can't answer "was every acceptance criterion actually verified?" — which is the whole product claim. **Add `criterionId` to `Finding` from the first version**; retrofitting traceability means re-running every agent prompt.

### `adl.yml` shape

```yaml
version: 1
features_dir: features

commands:
  build:    { argv: [npm, ci],       timeout: 10m }
  start:    { argv: [npm, run, dev], ready: { http: "http://localhost:3000/health" }, timeout: 2m }
  test:     { argv: [npm, test],     timeout: 15m }
  teardown: { argv: [docker, compose, down] }

context:
  files: [README.md, docs/architecture.md]     # default: [README.md]
  max_bytes: 200000

pipeline: [develop, review, { harness: security }, test]

limits:
  max_rounds: 6
  budget_usd: 15
  repeat_finding_threshold: 2

agents:
  developer: { backend: claude-code, model: default }
  reviewer:  { backend: claude-code, model: default }
  tester:    { backend: claude-code, model: default }
```

`argv` arrays rather than shell strings, matching `ExecSpec` — no shell means no quoting bugs and no injection surface from repo config. `start` needs a **readiness probe**, otherwise the tester races the server; make it a first-class field rather than letting agents invent `sleep 5`.

**Where format differences normalise:** spec format → `SpecLoader`. Context file resolution and size capping → `ContextResolver`. Backend context strategy (paths vs inlined) → `PromptBuilder`, keyed on `capabilities.readsWorkspaceDirectly`. Nothing downstream of `PromptBuilder` knows a format existed.

---

## 8. Data Flow: One Feature, End to End

| # | Step | Boundary crossed | Payload |
|---|------|------------------|---------|
| 1 | Dev pushes `features/dark-mode/spec.md` | Forge → Manager HTTP | Raw webhook body + signature headers |
| 2 | `verifyWebhook(headers, rawBody, secret)`; delivery id deduped against `forge_events` | inside Manager | `ForgeEvent{ kind:'push', repo, ref }` |
| 3 | Detector `reconcile(repo)`: list `features/*`, hash each spec, diff against DB | Manager → Forge API (read) | Feature paths + `specHash` |
| 4 | New `(repo, path, specHash)` → insert `features` row `discovered`; `SpecLoader` parses; valid → `admit` → `queued` | inside Manager (1 txn) | `NormalizedSpec` + `feature_events` row |
| 5 | Worker polls `POST /leases`; Lease Broker runs the atomic claim | Manager → Worker (HTTP) | `LeaseGrant{ featureId, leaseToken, EffectiveConfig, NormalizedSpec, credentials, workspaceSpec }` |
| 6 | Worker heartbeats every 20s with `leaseToken` | Worker → Manager | `{ featureId, leaseToken, phase }` |
| 7 | `WorkspaceBackend.create()` → worktree at `adl/dark-mode` off `main` | Worker → filesystem/git | `WorkspaceHandle` (persisted back to Manager) |
| 8 | `commands.build` via `workspace.exec` | Worker → Workspace | argv + env; stdout/stderr streamed |
| 9 | `PromptBuilder.render('developer', spec, config, brief?)` | inside Worker | `RenderedPrompt` → uploaded as artifact |
| 10 | `AgentBackend.run(task)` → agent CLI launched **via `workspace.exec`** | Worker → Workspace → model provider | `AsyncIterable<AgentEvent>` |
| 11 | Events fan out: NDJSON → Manager log store; `usage` → Manager accountant; `result` → Loop Runner | Worker → Manager (SSE/POST) | `AgentEvent[]`, usage rows |
| 12 | Developer commits on the branch; `dev_committed` reported | Worker → Manager | `{ sha, diffStat }` → `developing → gating` |
| 13 | Stage 1 `review` (agent, `outputSchema: VerdictSchema`) | Worker → model | `Verdict{ send_back, findings[ {criterionId:'AC-3', …} ] }` |
| 14 | Policy: reviewer is `expensive` + `on_send_back: stop` → skip remaining gates | inside Worker | — |
| 15 | Loop Runner builds `SendBackBrief`; reports `send_back` | Worker → Manager | Findings + evidence refs |
| 16 | State Engine: admission check (`round+1 <= max_rounds`, spend < budget) passes → `gating → developing`, `round = 2` | inside Manager (1 txn) | `features` + `feature_events` + `findings` rows |
| 17 | Round 2: prompt now includes the brief; `repeated[]` empty | as steps 9–13 | — |
| 18 | Round 2 gates all pass (review → security harness (SARIF) → behaviour tester); tester commits its tests | Worker → Workspace → Manager | Verdicts + test files committed |
| 19 | `all_gates_passed` → `gating → publishing`; worker pushes the branch | Worker → Forge (git only) | Branch `adl/dark-mode` |
| 20 | State Engine writes `outbox` rows **in the same txn** as `publishing`: open CR; 4 sticky comments; 1 rollup | inside Manager (1 txn) | Outbox rows with idempotency keys |
| 21 | Outbox Relay drains; each op idempotent via marker lookup | Manager → Forge API | `ChangeRequest{ ref, url }` → `cr_opened` → `pr_open` |
| 22 | Worker `destroy({ keepOnFailure: true })`, releases lease, polls for next | Worker → Manager | Lease released |
| 23 | Human reviews and merges | Human → Forge | — |
| 24 | `merge` webhook (or poller) → `cr_merged` → `merged` (terminal); `gc()` reclaims the worktree | Forge → Manager | Terminal `feature_events` row |

**Boundary invariants worth stating as tests:**
- The worker never opens a DB connection.
- The worker never calls a forge REST API (git push only).
- The manager never touches a workspace filesystem.
- Every worker→manager write carries a valid `leaseToken`.
- Every forge write goes through the outbox and carries an idempotency key.

---

## 9. Interfaces Surface

**One API. The CLI and dashboard are both clients of it, with no privileged path.** Named precedent: `docker` CLI → `dockerd` over a unix socket. The temptation to let the local CLI open the SQLite file directly must be resisted — it creates a second writer, a second source of truth, and lock contention that only shows up under load.

```
Resources (JSON, Fastify)
  GET    /v1/repos                              POST /v1/repos
  GET    /v1/features?state=&repo=              GET  /v1/features/:id
  POST   /v1/features/:id/pause | /resume | /kill | /retry
  GET    /v1/features/:id/rounds                GET  /v1/rounds/:id/stages
  GET    /v1/stages/:id/verdict                 GET  /v1/artifacts/:id
  GET    /v1/health                             GET  /v1/config/effective?repo=

Worker control (loopback / unix socket only, worker token + leaseToken)
  POST   /v1/leases            POST /v1/leases/:id/heartbeat
  POST   /v1/leases/:id/events POST /v1/leases/:id/usage
  POST   /v1/leases/:id/release

Streams (SSE — text/event-stream)
  GET    /v1/features/:id/stream?from=<seq>            state + stage transitions
  GET    /v1/stages/:id/logs?follow=1&offset=<bytes>   transcript / command output

Ingress
  POST   /v1/webhooks/:forge/:repoId                   raw body preserved
```

- **SSE over WebSocket.** Traffic is one-directional (server → consumer), `Last-Event-ID` reconnection is built into the protocol, and it traverses reverse proxies without upgrade negotiation. WebSocket buys nothing here.
- **Byte-offset log addressing.** One endpoint serves history and follow: `?offset=N&follow=1` seeks into the NDJSON file and then tails. Reconnect resumes at the last byte instead of replaying a 40 MB transcript. This is the mechanism that makes `adl logs -f` and the dashboard the same code.
- **CLI surface:** `adl status`, `adl features`, `adl show <id>`, `adl logs <id> [-f] [--stage=]`, `adl pause|resume|kill <id>`, `adl retry <id>`, `adl config check`, `adl doctor` (probes each configured backend's `probe()` and each forge's auth — this saves enormous support pain for a self-hosted OSS tool).
- **Auth:** bearer token from the daemon config; bind loopback by default; document a reverse-proxy TLS setup rather than terminating TLS in-process.
- **Dashboard:** static SPA served by the manager from the same origin. No server-rendered pages, no second backend. It is a proof that the API is complete — if the dashboard needs an endpoint the CLI can't use, the API is wrong.

---

## Recommended Project Structure

npm workspaces. **The package boundary is the plugin contract** — for a project whose thesis is extension points, third-party harness authors must be able to depend on a small published SDK without pulling in the manager.

```
packages/
├── core/                    # @adl/core — zero I/O, zero deps
│   ├── state/               #   FeatureState, transition(), invariants
│   ├── model/               #   NormalizedSpec, Verdict, Finding, ChangeRequest
│   ├── config/              #   adl.yml zod schema + EffectiveConfig resolution
│   └── spec/                #   SpecLoader: adl-template + gherkin → NormalizedSpec
├── plugin-sdk/              # @adl/plugin-sdk — what harness authors import
│   └── index.ts             #   Stage, StageContext, Verdict, Workspace, AgentRunner
├── manager/                 # @adl/manager
│   ├── http/                #   Fastify routes, SSE hub, webhook raw-body handling
│   ├── db/                  #   schema, migrations, DAL (narrow — Postgres swap later)
│   ├── detect/              #   webhook handlers + poller → reconcile()
│   ├── lease/               #   broker, reaper, fencing
│   ├── account/             #   ledger, admission checks, budget interrupts
│   ├── outbox/              #   relay + idempotency
│   └── store/               #   artifact store + NDJSON log store
├── worker/                  # @adl/worker
│   ├── loop/                #   round loop, stage sequencing, SendBackBrief assembly
│   ├── stages/              #   built-ins: develop, review, test, CommandStage
│   ├── prompt/              #   templates + PromptBuilder
│   └── client/              #   typed manager HTTP client (lease, heartbeat, report)
├── workspace-worktree/      # @adl/workspace-worktree
├── agent-claude-code/       # @adl/agent-claude-code   (delegated-loop)
├── agent-anthropic/         # @adl/agent-anthropic     (owned-loop)
├── agent-codex/  agent-gemini/  …
├── forge-github/  forge-gitlab/  forge-gitea/
├── harness-security/        # @adl/harness-security — reference plugin, SARIF-based
├── cli/                     # @adl/cli — HTTP client only
└── dashboard/               # @adl/dashboard — SPA, built to static assets
```

### Structure rationale

- **`core/` has no I/O.** The state machine, spec parsing, and config resolution are pure and exhaustively testable without a database, a git repo, or a model key. This is where the fastest, highest-value tests live.
- **`plugin-sdk/` is separate from `core/`** so a third-party harness's `package.json` has one small stable dependency. If harness authors have to depend on `@adl/manager`, the extension point is decorative.
- **Adapters are separate packages, not folders**, so "vendor neutrality" is enforced by the dependency graph: `worker` may not import `agent-claude-code`. Adapters register through a registry resolved from config. Add an ESLint `no-restricted-imports` rule and a CI check — an architecture rule nobody can violate accidentally beats a documented convention.
- **`manager` and `worker` are separate packages from day one**, because the process boundary is exactly the kind of thing that never gets retrofitted.

---

## Architectural Patterns (with precedents)

| # | Pattern | Precedent | Where used here |
|---|---------|-----------|-----------------|
| 1 | Lease + heartbeat + fencing token | SQS visibility timeout; Chubby/ZooKeeper leases; `pg-boss`/`graphile-worker` `SKIP LOCKED`; fencing tokens per Kleppmann | Feature claim, crash recovery |
| 2 | Transactional outbox | Debezium / microservices canon | All forge writes, in-txn with state change |
| 3 | Event-sourced audit log beside canonical state | OpenHands typed event stream; Temporal history | `feature_events`, dashboard timeline, PR rollup |
| 4 | At-least-once activities with idempotency keys | Temporal activity semantics | Stage attempts; commit = checkpoint |
| 5 | Capability negotiation instead of LCD interfaces | LSP server capabilities; WebGL extensions | `AgentCapabilities`, `ForgeCapabilities` |
| 6 | Contract + config-ordered plugin registry | ESLint plugins/config order; Fastify plugins as lightweight DI; webpack Tapable hooks | Stage registry, pipeline list |
| 7 | Neutral protocol between host and agent process | Agent Client Protocol (Zed); LSP | `AgentBackend` / `AgentEvent` |
| 8 | Sticky, marker-keyed bot comments | GitHub Actions sticky-comment bots | PR audit trail |
| 9 | Standard findings format | SARIF | Command harness output |
| 10 | Single API, thin clients | Docker CLI ↔ dockerd | CLI + dashboard |

---

## Anti-Patterns

**1. Gates as states in the lifecycle state machine.**
*What people do:* `reviewing`, `security_scanning`, `testing` as first-class states.
*Why it's wrong:* every new harness becomes a state-machine change plus a migration plus a risk to in-flight features. Directly contradicts pluggability.
*Instead:* one `gating` state + `current_stage_index` + `stage_attempts` rows.

**2. Agent adapters spawning processes directly.**
*What people do:* `child_process.spawn('claude', …, { cwd: worktreePath })`.
*Why it's wrong:* the container backend can never work; the workspace interface becomes decorative.
*Instead:* `workspace.exec()` for every process, always.

**3. Transcripts in database rows.**
*What people do:* `TEXT` column on `stage_attempts`.
*Why it's wrong:* a single SQLite file that is 95% agent chatter; slow queries, painful backups, no byte-offset streaming.
*Instead:* NDJSON in a log store, rollup counters in the DB.

**4. Verifying webhooks against the parsed body.**
*What people do:* HMAC over `JSON.stringify(req.body)`.
*Why it's wrong:* re-serialisation changes bytes; signatures fail intermittently and unfixably.
*Instead:* retain the raw `Buffer` on webhook routes; `timingSafeEqual`; reject stale timestamps where the forge provides them.

**5. Letting the CLI read the database directly.**
*Why it's wrong:* two writers, two truths, lock contention, and remote operation becomes impossible.
*Instead:* CLI is an HTTP client. Always.

**6. Treating session resume as required.**
*Why it's wrong:* the loop silently becomes Claude-shaped and a backend without resume can't be added without redesign.
*Instead:* correctness without resume; resume as a capability-gated cost optimisation.

**7. Letting agent CLIs auto-discover repo config.**
*What people do:* run `claude -p` in the worktree and let `CLAUDE.md`, hooks, and `.mcp.json` load.
*Why it's wrong:* non-reproducible runs, *and* the target repo becomes an unaudited instruction channel into your agent — a prompt-injection surface where the injected instructions run with `edit-exec` on your daemon host.
*Instead:* `--bare` (and equivalents). ADL is the sole source of context; if `AGENTS.md` should be used, load it explicitly as a `ContextRef` so it appears in the persisted prompt artifact.

**8. Trusting `adl.yml` and the target repo.**
*Why it's wrong:* `adl.yml: commands.build` is arbitrary code execution on the daemon host, contributed by anyone with push access to any watched repo.
*Instead:* see the flag below. At minimum: dedicated unprivileged user, `argv` arrays never shell strings, no daemon secrets reachable from the workspace, and a loud documented trust boundary.

**9. A `runFeature()` god function in the worker.**
*Why it's wrong:* stage sequencing, prompt assembly, budget checks, and forge publishing tangle into one untestable async function; the manager/worker split then can't be enforced.
*Instead:* Loop Runner orchestrates named, individually testable collaborators (§Structure).

---

## Scaling Considerations

The relevant axis is **features in flight**, not users.

| Scale | Adjustment |
|-------|------------|
| 1 concurrent (v1 default) | SQLite WAL, single worker, worktrees, polling detection. Nothing else needed. |
| 2–8 concurrent, one repo | Multiple worker processes, unchanged lease protocol. First real bottleneck: **model provider rate limits**, not the daemon. Add per-backend concurrency caps and 429-aware backoff in the adapter layer. Second: shared git object store contention — serialise `fetch`/`gc` per repo. |
| 8–30 concurrent, several repos | Disk pressure from worktrees becomes the binding constraint (tens of GB) — `gc()` policy must be aggressive and tested. Move to Postgres for `LISTEN/NOTIFY`-driven lease handoff and to drop the single-writer ceiling. Move the artifact/log store off the daemon's local disk. |
| Multi-repo fleet (out of v1 scope) | Per-repo fairness in the lease broker (weighted round-robin, not FIFO), per-repo budgets, per-repo credential isolation, and container backend becomes mandatory rather than optional. |

**What breaks first, in order:** (1) model-provider rate limits; (2) disk consumed by orphaned worktrees; (3) SQLite write contention from high-frequency heartbeats and usage events — mitigate by batching usage events and keeping heartbeats at 20s, not 2s.

---

## Flags on Recorded Decisions

### 🔴 Flag 1 — "Container-per-feature isolation deferred; worktrees are sufficient at concurrency 1"

**The stated rationale conflates two different things.** Worktrees are sufficient for *concurrency*. They provide **no isolation whatsoever**.

At concurrency 1, ADL still: clones an arbitrary repo onto the daemon host, executes `adl.yml` commands from that repo, and runs an agent with `edit-exec` permission on the same host — an agent whose instructions can be influenced by repo content (spec files, README, `AGENTS.md`) written by anyone with push access. The daemon holds forge tokens and model API keys. There is nothing between "someone opens a PR adding a feature folder" and "arbitrary code runs as the daemon user with access to its credentials."

This does not mean containers must ship in v1. It means the decision should be re-recorded honestly and mitigated:

- Restate the rationale as *"worktrees are sufficient for concurrency; isolation is an accepted, documented risk in v1."*
- Run the worker as a **dedicated unprivileged user** with no access to the manager's config/credential directory. This is cheap and removes the worst outcome.
- The Credential Broker should hand the worker **only** the model key and a scoped push credential — never the forge admin token, never the daemon config. The §1 allocation already does this; make it a hard requirement rather than a nicety.
- Document the trust boundary prominently in the README: *"ADL executes code from watched repositories. Only watch repositories whose contributors you trust."*
- Keep `networkPolicy` and `resources` in `WorkspaceSpec` from day one so the container backend is a drop-in.

This is the largest gap between what the architecture implies and what PROJECT.md records.

### 🟡 Flag 2 — "Every agent posts its own PR comment"

Sound intent, but literally implemented it produces ~24 comments on a 6-round feature and destroys the readability the decision exists to create. **Recommend: sticky per-role comments (edited in place) + one rollup.** Detail in §6.

### 🟡 Flag 3 — "Daemon-side database as source of truth" has an unaddressed failure mode

If the DB is lost or reset, ADL has no memory that `features/dark-mode` was ever built — and will rebuild every feature in every watched repo. Mitigate with a **recovery index in the forge**, which costs almost nothing:
- Branch naming convention `adl/<feature-id>` (already needed).
- A machine-readable marker in the CR body: `<!-- adl:feature=dark-mode spec=<sha256-prefix> -->`.
- A `reconcile()` startup pass that lists open/merged CRs matching the convention and rehydrates terminal state before queueing anything.

This preserves the decision (the DB is still the source of truth for *rich* state — rounds, spend, transcripts) while removing a catastrophic failure mode. Note it also keeps the promise "without polluting the repo with status commits" — there are no commits, only naming and a hidden HTML comment.

### 🟢 Flag 4 — "Dual limits: max rounds and cost budget" is right, with a caveat

Cost data is unreliable across backends (Claude Code's `total_cost_usd` is a client-side estimate; other backends report tokens or nothing). The Accountant must handle `costSource: 'unknown'` explicitly — degrade to round + wall-clock caps and surface the degradation in the UI. Silent non-enforcement would be worse than no budget at all. Also: add the cheap third limit from §2 (repeated-finding stall detection), which catches the target failure mode earlier than either configured limit.

---

## Suggested Build Order

### Dependency graph

```
 core (state, model, config, spec)          ← everything depends on this; no I/O
   ├── workspace-worktree ──┐
   ├── plugin-sdk ──────────┤
   ├── manager (db, http, lease, account) ──┐
   └── worker ──────────────┘               │
         ├── agent-claude-code ─┐           │
         ├── stages/CommandStage ┘          │
         └── prompt/PromptBuilder           │
   forge-github ───────────────────────────┘
   cli → manager HTTP        dashboard → manager HTTP
   forge-gitlab, forge-gitea, agent-*, harness-security  ← all late, all parallel
```

### The vertical slice that proves the loop closes

**The loop is not proven by a feature that passes on the first try.** It is proven when a gate fails, the developer is sent back with that verdict, and the second attempt passes. Everything before that is scaffolding.

So make the first gate a **command gate (`npm test`), not the reviewer agent** — because a command gate is deterministic, you can force it to fail on demand, and it exercises the send-back plumbing without agent nondeterminism confounding the signal. Swap in the agent reviewer immediately after, once the plumbing is known-good.

**Slice A definition of done:** on a fixture repo, drop a feature folder → ADL detects it (polling) → developer agent implements and commits → `npm test` fails → send-back with the failure as context → developer fixes → `npm test` passes → branch pushed → PR opened on GitHub. Observed entirely through `adl status` and `adl logs -f`.

Deliberately excluded from Slice A: reviewer agent, tester agent, harnesses, webhooks, budgets, PR comments, dashboard, second forge, second backend.

### Ordering

| # | Deliverable | Why here |
|---|-------------|----------|
| 0 | `core`: state machine + transition tests, DB schema + migrations, `adl.yml` schema, `SpecLoader` | Pure, fast to test, and every later phase depends on the shapes. Getting `Finding.criterionId` and `Verdict` right now costs nothing; retrofitting costs every prompt. |
| 1 | `workspace-worktree` + `GitOps` + `exec/spawn` | Standalone-testable. Establishes the rule that all execution goes through `exec` before any adapter exists to break it. |
| 2 | `manager` skeleton: SQLite, `features` table, HTTP API, lease broker + reaper + fencing, `cli` | Prove crash recovery with a **fake worker that sleeps and then `SIGKILL`s itself.** Recovery semantics tested with zero AI in the loop is the cheapest this will ever be. |
| 3 | `agent-claude-code` + `PromptBuilder` + transcript capture | First adapter. Done-when: a developer agent, invoked through `workspace.exec`, makes a real commit in a worktree and its NDJSON transcript is streamable via `adl logs -f`. |
| 4 | **Slice A** — detection (poll) → develop → `npm test` gate → send-back → develop → pass → push → open GitHub PR | **The milestone.** Everything after this is breadth on a validated core. |
| 5 | Accountant: round counter, usage ledger, admission + interrupt checks, escalation, repeated-finding stall detection | Now that rounds actually happen, limits have something to limit. Before this, unattended running is unsafe. |
| 6 | Agent stages: reviewer, then behaviour tester (with test-commit semantics) | Reviewer first — simpler contract. Tester second because "commit the tests" adds a workspace-mutation path and the code-blind constraint needs its own prompt work. |
| 7 | Outbox relay + sticky PR comments + rollup from `feature_events` | The audit-trail promise. Depends on `feature_events` (step 0) and CR creation (step 4). |
| 8 | Webhooks + signature verification per forge, with polling retained as fallback | Pure latency improvement — polling already works, so this can't block anything. |
| 9 | **Second agent backend** (`agent-anthropic` owned-loop, or `agent-codex`) | **Before the second forge.** Vendor neutrality is a stated constraint and the agent adapter is the riskier abstraction — the owned-loop family is where the interface actually gets stress-tested (tools, cost, no resume). Discovering the interface is wrong here is cheap; discovering it after four backends is not. |
| 10 | `harness-security` reference plugin + plugin loading/resolution | Proves the extension point with a third-party-shaped consumer. SARIF support makes this mostly configuration. |
| 11 | **GitLab** forge adapter | GitLab second, **not Gitea** — Gitea is GitHub-shaped and would validate nothing. GitLab's `iid` vs `id`, project addressing, notes-vs-reviews, and Standard-Webhooks signing are where the abstraction either holds or doesn't. |
| 12 | Gitea forge adapter | Near-free once GitLab has forced the abstraction honest. |
| 13 | Remaining backends (Gemini API + CLI, Codex CLI) | Parallelisable; each is now an adapter, not a redesign. |
| 14 | Dashboard | Last. It is a *consumer* of the API; building it earlier means rebuilding it as the API settles. Its real value is proving the API is complete. |
| 15 | Dogfood: ADL ships a feature into its own repo unattended | The stated v1 bar. |

**Sequencing notes worth carrying into the roadmap:**
- Steps 0–4 are strictly serial. Steps 9–13 are largely parallel.
- Step 9 before step 11 is a deliberate inversion of the "breadth in the order PROJECT.md lists it" instinct — the ordering is by *abstraction risk*, and the agent adapter carries more of it than the forge adapter.
- Step 14 last is not a deprioritisation of the dashboard; it is a recognition that a UI built against an unsettled API is built twice.
- Phases likely to need their own deeper research: **step 3** (per-backend CLI behaviour under unattended conditions), **step 6** (tester prompt design under the code-blind constraint), **step 9** (owned-loop tool implementation over `Workspace`), **step 11** (GitLab API specifics).

---

## Sources

| Source | Confidence | Used for |
|--------|------------|----------|
| [Claude Code — Run Claude Code programmatically](https://code.claude.com/docs/en/headless) (official) | LOW per provider tier; substantively authoritative (first-party docs, fetched directly) | Headless flags, stream-json event schema, resume, permission modes, cost reporting, `--bare` |
| [Codex CLI non-interactive mode](https://developers.openai.com/codex/noninteractive) · [Gemini CLI headless](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md) | MEDIUM | `codex exec --json`, `--output-schema`, `-p`/`--output-format json`, `--yolo` |
| [Agent Client Protocol](https://agentclientprotocol.com/get-started/agents) · [Zed: Claude Code via ACP](https://zed.dev/blog/claude-code-via-acp) · [Bring your own agent](https://zed.dev/blog/bring-your-own-agent-to-zed) | MEDIUM | Agent adapter precedent, JSON-RPC-over-stdio transport option |
| [OpenHands SDK paper (arXiv 2511.03690)](https://arxiv.org/pdf/2511.03690) · [OpenHands platform paper (arXiv 2407.16741)](https://arxiv.org/pdf/2407.16741) · [event-stream refactor PR](https://github.com/OpenHands/OpenHands/pull/2709) | MEDIUM | Event-sourced agent history, controller/runtime → Conversation/Workspace, budget+iteration caps in the supervisor |
| [Temporal workflow execution](https://docs.temporal.io/workflow-execution) · [Temporal human-in-the-loop](https://learn.temporal.io/tutorials/ai/building-durable-ai-applications/human-in-the-loop/) · [Inngest vs Temporal](https://www.inngest.com/compare-to-temporal) | MEDIUM | Durable-execution concepts; rationale for borrowing rather than adopting |
| [Lease pattern in distributed systems](https://singhajit.com/distributed-systems/lease/) · [faultline (lease + fencing tokens)](https://github.com/kritibehl/faultline) · [When the handler outlives the lease](https://www.planetgeek.ch/2026/06/29/when-the-handler-outlives-the-lease/) | MEDIUM | Lease TTL/heartbeat/fencing design, double-execution hazard |
| [pg-boss](https://github.com/timgit/pg-boss) · [graphile-worker](https://github.com/graphile/worker) | MEDIUM | `SKIP LOCKED` claim precedent, queue feature checklist |
| [Outbox pattern](https://www.conduktor.io/glossary/outbox-pattern-for-reliable-event-publishing) · [Transactional outbox examination](https://medium.com/@nustianrwp/the-transactional-outbox-pattern-a-rigorous-examination-for-distributed-systems-engineers-9c189836f470) | MEDIUM | Dual-write elimination for forge side effects |
| [GitHub webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) · [GitLab webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/) · [GitLab MR API](https://docs.gitlab.com/api/merge_requests/) · [Gitea PR review comment webhooks (#26023)](https://github.com/go-gitea/gitea/issues/26023) | MEDIUM | Forge signature headers, `iid` vs `id`, capability gaps |
| [git worktree prune docs](https://git-scm.com/docs/git-worktree/2.5.6) · [Git worktree best practices](https://gist.github.com/ChristopherA/4643b2f5e024578606b9cd5d2e6815cc) · [Bulk cleaning stale worktrees](https://brtkwr.com/posts/2026-03-06-bulk-cleaning-stale-git-worktrees/) | MEDIUM | Worktree lifecycle, `--porcelain`, locked-worktree pruning, real-world GC pressure with AI agents |
| [XState persistence](https://stately.ai/docs/persistence) · [Migrating a running statechart (#1338)](https://github.com/statelyai/xstate/discussions/1338) · [Server-side order workflow (#1684)](https://github.com/statelyai/xstate/discussions/1684) | MEDIUM | Why the DB column, not a persisted machine snapshot, is the source of truth |
| [Node.js plugin architecture](https://oneuptime.com/blog/post/2026-01-26-nodejs-plugin-architecture/view) · [Fastify plugins](https://snyk.io/blog/fastify-plugins-for-backend-node-js-api/) | MEDIUM | Registry + contract + config-declared ordering |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) · [Self-hosted databases 2026](https://botmonster.com/self-hosting/self-hosted-databases-postgres-sqlite-mariadb/) | MEDIUM | SQLite WAL for a single-node self-hosted daemon; where the write ceiling bites |
| [Vercel AI SDK — providers and models](https://ai-sdk.dev/docs/foundations/providers-and-models) | MEDIUM | Owned-loop backend abstraction precedent |

---
*Architecture research for: self-hosted multi-agent delivery daemon*
*Researched: 2026-08-17*
