# M04 — First Agent Backend & Live Transcripts

**Status:** 🟡 Code complete — one deferred check (needs a real API key + the pinned CLI)
**Depends on:** M03
**Requirements:** BACK-01, BACK-05, OBS-02 (3)

**Goal:** a real agent CLI, driven through the workspace, produces a commit and a
transcript the maintainer can watch as it happens.

---

## Done when

- [x] A developer agent invoked through the `AgentRunner` port makes a real commit inside
      a feature worktree, launched through the workspace exec path rather than a direct spawn.
- [x] `adl logs -f` on a running feature streams the agent's transcript live, and can
      reconnect mid-stream without losing or duplicating output.
- [x] The backend's CLI version is pinned and preflight-checked at startup, so an
      unexpected version is a reported broken installation rather than a mid-run surprise.
- [x] Repository-level agent-CLI config auto-discovery is disabled and system prompts are
      set explicitly, so the same feature on the same commit gets the same prompt twice running.
- [ ] **Deferred:** one real, credentialed run against the pinned CLI, reconciling the
      recorded cost against the provider's billed usage. See [`DEBT.md`](../DEBT.md).

---

## What shipped

- **`AgentRunner` is a real port** — `packages/core/src/stage/agent.ts`. An 8-kind
  `AgentEvent` discriminated union with compile-time exhaustiveness; every member
  `.strictObject` so an unmodelled field is a parse failure; four separately-nullable
  usage fields **never defaulted to zero**. No vendor vocabulary in the port — the one
  backend-owned concept is an opaque, optional `sessionRef`.
- **The Claude Code adapter** — `packages/agent-claude-code/src/backend.ts` calls
  `workspace.exec()` **exactly once** per run (asserted by a dedicated test) and reads no
  environment of its own. `events.ts`'s `translateLine` maps one CLI line to zero, one or
  several `AgentEvent`s, classifying rather than throwing. `usage.ts` maps a terminal
  event to a `usage_events` record with `cost_source` `reported` or `unknown` — **never
  `computed`, never zero**.
- **Transcript store with resumable byte offsets** — `manager/src/store/`.
  `transcriptPathFor` builds `logs/<feature>/<round>/<stage>/<attempt>.ndjson` as a pure
  function of a **DB-resolved** address (a bare string is a compile error), *rejecting*
  rather than sanitising a hostile component. The next offset is re-`stat`'d after each
  write so offset-equals-file-size holds by construction; a partial final line is neither
  emitted nor counted, and is emitted exactly once when complete.
- **The production stage runner** — `manager/src/worker-entry/stage-runner.ts`. Resolves a
  workspace from the registry, renders and persists the prompt, appends one transcript
  record per event as it arrives, and supplies the commit identity
  `ADL (claude-code) <adl+claude-code@noreply.local>` via `GIT_AUTHOR_*` / `GIT_COMMITTER_*`
  — never the operator's git identity.
- **HTTP + CLI for dev-run and live logs** — `POST /dev-run/:featureId` and
  `GET /stages/:id/logs?offset=N&follow=1`. The untrusted `:id` resolves through
  `findAttempt` **before any path is built**. Termination is read from
  `stage_attempts.ended_at` — never inferred from the file going quiet. The CLI advances
  its resume offset only *after* a batch is written to the sink.
- **Prompt determinism, proven from artifacts** — `manager/src/prompt/`. Single-pass
  function-replacer substitution (closing both the `$&` hazard and an order-dependent
  re-substitution hazard). The rendered prompt is persisted beside its transcript
  **before** the agent launches. `test/prompt/determinism.test.ts` compares real persisted
  artifacts byte-for-byte across two real daemon *processes* on different working
  directories, with a negative control.
- **Backend startup gate** — `boot/backend-preflight.ts`, wired into `daemon.ts` strictly
  before the supervisor, the API bind and the dispatch timer. A configured backend this
  build doesn't implement is a named refusal, not a silent start that fails every stage.
- **Cost accounting with structurally fenced attribution** — a `usage` worker→manager IPC
  message carrying **only** the lease token and payload columns. No `featureId`,
  `roundId`, or `stageAttemptId` — a worker structurally cannot name a feature to
  attribute spend to. The supervisor supplies the join keys from its own assignment.
- **D-2-08-1 fixed** — `writeScratchGitConfig` writes `safe.directory` entries for both
  the worktree and the main repo *before any child launches*, so the agent can run git
  inside its own worktree under the privilege drop.

## Deliberately excluded

- No tool-allowlist or `toolPolicy` on `AgentTask` — containment is assigned to the
  workspace boundary (M02 / M15), not this port.
- The backend preflight gate is **opt-in** via `StartDaemonOptions.agentBackendVersionCheck`.
  Defaulting it on would make 200+ green tests depend on an exactly-pinned `claude` on PATH.
- The context-file cascade is deliberately **not** wired into `mergeConfig`'s output —
  `effectiveConfig.context.files` stays exactly what `adl.yml` declared.
- Nothing on the manager side reads back the `StageRunnerVerdict` envelope — **that's M05's
  first real job.**
- A capability/cost-report mismatch does *not* emit an `error` transcript event: it was
  implemented per the plan's wording, found to convert successful runs into false
  `stage_error`s, and removed. `costSource: 'unknown'` is the honest signal.

## Still open

Everything open here traces to **one** missing precondition: no session across the whole
milestone ever invoked the real, pinned Claude Code CLI (`2.1.237`) against a real
`ANTHROPIC_API_KEY`. Not a code defect — hit, recorded honestly and left open rather than
faked, five separate times.

Full detail in [`DEBT.md`](../DEBT.md). Summary:

| Item | Closed by the credentialed run? |
|---|---|
| Capture real CLI transcript fixtures | Partly — a separate follow-up task |
| Watch a real transcript stream live, confirm the commit | Yes |
| `claudeVersionCheckRunner` against the real pinned binary | Yes, once PATH shadowing is fixed |
| Reconcile a real `usage_events` row against billed usage | Yes |
| D-2-08-1 Linux privilege-drop reproduction | No — needs a Linux host, not a credential |

Plus four non-blocking code-review warnings (hardcoded 10-minute timeout, a missing
containment check on `loadSpecFromWorktree`, no `--` argv separator, and a hardcoded
attempt ordinal of `1`) — all in `DEBT.md`, none exploitable, none blocking M05.
