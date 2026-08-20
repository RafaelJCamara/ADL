/**
 * The backend startup gate (04-07, D-01/D-02) — success criterion 3's other
 * half: "an unexpected version is reported as a broken installation rather
 * than discovered mid-run." `runStartupGate` (`./startup.ts`) is the schema
 * precedent this follows exactly: return a discriminated outcome rather than
 * throw, and let the caller (`startDaemon`) turn a refusal into a named,
 * thrown error the way it already does for `SchemaVersionRefusalError`. An
 * adopter should meet ONE shape of "the daemon refused to start", not two.
 *
 * ── What this gate refuses, and why "no backend configured" is a real,
 * reachable outcome ─────────────────────────────────────────────────────
 *
 * `packages/core/src/config/adl-yml.ts`'s `AgentBlockSchema.backend` and
 * `effective-config.ts`'s `DEFAULT_AGENT_BLOCK` establish that backend
 * selection is a daemon-only, free-form string (D-22) that defaults to
 * `"claude-code"` — but a daemon operator MAY configure
 * `agents.developer.backend` to any other non-empty string, and this build
 * implements exactly one backend. Before this plan, the production stage
 * runner (`worker-entry/stage-runner.ts`) simply hardcoded `claudeCodeBackend`
 * regardless of what was configured, so a daemon "configured" for a backend
 * that does not exist would have started anyway and reported every stage as
 * a silent, unexplained failure. `SUPPORTED_BACKEND_ID` is this gate's one
 * source of truth for "a backend id this build can actually run" — a
 * resolved id that does not match it is refused by name, honestly, rather
 * than discovered as a mysterious per-feature failure later.
 *
 * ── Why the real version-check invocation is a caller-supplied dependency,
 * not something this module constructs ─────────────────────────────────
 *
 * `runBackendPreflight` never touches a process itself. `startDaemon` is
 * the caller that builds the real `runVersionCheck` — `claudeVersionCheckRunner`
 * below, which shells out to `claude --version` through
 * `@adl/workspace`'s `run()` with `owner: 'adl'` (this is ADL asking a
 * question about its own installation, not an agent doing work on a
 * feature's behalf — `packages/workspace/src/exec/run.ts:58`'s own
 * `ExecOwner` distinction). Keeping that construction out of this module is
 * what lets `runBackendPreflight` be driven by an injected fake in tests,
 * matching every other startup-gate function in this package.
 */
import type { Logger } from 'pino';
import { DEFAULT_CONFIG } from '@adl/core/config';
import type { PreflightResult } from '@adl/agent-claude-code';
import { preflightClaudeCode } from '@adl/agent-claude-code';
import { run } from '@adl/workspace';

/**
 * The one backend id this build knows how to preflight-check. Read off
 * `DEFAULT_CONFIG` rather than a second hardcoded literal, so the "what
 * backend does an unconfigured daemon get" answer and "what backend can
 * this gate actually check" answer cannot drift apart from each other.
 */
export const SUPPORTED_BACKEND_ID: string =
  DEFAULT_CONFIG.agents.developer.backend;

/** What the injected version-check runner returns — mirrors `@adl/agent-claude-code`'s `VersionCheckResult`. */
export interface BackendVersionCheckResult {
  readonly stdout: string;
  readonly exitCode: number | null;
}

export interface RunBackendPreflightDeps {
  /** The backend id resolved from the daemon's own config (`agents.developer.backend`, defaulting to `SUPPORTED_BACKEND_ID`). */
  readonly backendId: string;
  /**
   * The version-check invocation for `backendId`, when this build has one to
   * offer. Absent whenever `backendId !== SUPPORTED_BACKEND_ID` (there is
   * nothing to check), and also absent for any caller that has not wired one
   * — see `claudeVersionCheckRunner` below for the real, production
   * constructor.
   */
  readonly runVersionCheck?: () => Promise<BackendVersionCheckResult>;
  readonly logger: Logger;
}

/**
 * Why the gate refused (D-01, D-02). Two reasons, matching the two ways a
 * daemon can have "no way to run a feature": nothing this build knows how to
 * check is configured, or the thing that IS configured failed its check.
 */
export type BackendPreflightRefusal =
  | {
      readonly reason: 'no-backend-configured';
      readonly backendId: string;
      readonly message: string;
    }
  | {
      readonly reason: 'backend-unavailable';
      readonly backendId: string;
      readonly preflight: PreflightResult;
      readonly message: string;
    };

export interface BackendPreflightPassed {
  readonly kind: 'passed';
}

export interface BackendPreflightRefused {
  readonly kind: 'refused';
  readonly refusal: BackendPreflightRefusal;
}

export type BackendPreflightOutcome =
  BackendPreflightPassed | BackendPreflightRefused;

/** Thrown by `startDaemon` on a refusal — mirrors `SchemaVersionRefusalError`'s shape exactly (`./startup.ts`). */
export class BackendUnavailableError extends Error {
  readonly refusal: BackendPreflightRefusal;

  constructor(refusal: BackendPreflightRefusal) {
    super(refusal.message);
    this.name = 'BackendUnavailableError';
    this.refusal = refusal;
  }
}

/**
 * Invoke the configured backend's preflight check and return a discriminated
 * outcome — never throws (matching `runStartupGate`). Called exactly ONCE,
 * by `startDaemon`, before the dispatch timer starts and before the API
 * server binds — D-02 forbids a feature ever being leased and forked against
 * a backend that cannot work, and a check repeated per-invocation is exactly
 * the anti-pattern `04-RESEARCH.md` names (wasted latency, and it does not
 * match "diagnose a broken install before running a feature through it").
 *
 * No retry, no grace period, no degraded mode — D-02 rejected
 * warn-and-continue explicitly, and each of those is warn-and-continue
 * wearing a different hat.
 */
export async function runBackendPreflight(
  deps: RunBackendPreflightDeps,
): Promise<BackendPreflightOutcome> {
  if (
    deps.backendId !== SUPPORTED_BACKEND_ID ||
    deps.runVersionCheck === undefined
  ) {
    const refusal: BackendPreflightRefusal = {
      reason: 'no-backend-configured',
      backendId: deps.backendId,
      message:
        deps.backendId === SUPPORTED_BACKEND_ID
          ? `no agent backend is wired for "${deps.backendId}" — the daemon has ` +
            'no way to check it and refuses to start rather than dispatch a ' +
            'feature it cannot run.'
          : `no agent backend is registered for "${deps.backendId}" — only ` +
            `"${SUPPORTED_BACKEND_ID}" is available in this build. The daemon ` +
            'refuses to start rather than dispatch a feature with no way to run it.',
    };
    deps.logger.error(refusal, 'backend preflight: refusing to start');
    return { kind: 'refused', refusal };
  }

  const preflight = await preflightClaudeCode(deps.runVersionCheck);
  if (!preflight.ok) {
    const refusal: BackendPreflightRefusal = {
      reason: 'backend-unavailable',
      backendId: deps.backendId,
      preflight,
      message:
        preflight.detail ??
        'the agent backend failed its startup preflight check.',
    };
    deps.logger.error(refusal, 'backend preflight: refusing to start');
    return { kind: 'refused', refusal };
  }

  deps.logger.info(
    { backendId: deps.backendId, installedVersion: preflight.installedVersion },
    'backend preflight: passed',
  );
  return { kind: 'passed' };
}

// ---------------------------------------------------------------------------
// The real, production version-check runner
// ---------------------------------------------------------------------------

/** Wall-clock ceiling for the one `claude --version` invocation this runner performs. A hang is a refusal, not a hung boot (T-4-27). */
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 15_000;

/** The pinned CLI's own name on the process table — matches `backend.ts`'s `DEFAULT_BINARY`. */
const DEFAULT_CLAUDE_BINARY: readonly string[] = ['claude'];

export interface ClaudeVersionCheckRunnerDeps {
  /** The agent CLI as an argv prefix — a test seam for a scripted double. Defaults to `['claude']`. */
  readonly binary?: readonly string[];
  /** The child's `PATH`. */
  readonly path: string;
  /** Working directory for the child — the repository ADL is running against. */
  readonly cwd: string;
  /**
   * The ADL-owned scratch `HOME` this exec's environment is built around
   * (`buildChildEnv`). Reuses the daemon's own per-instance `scratchRoot`
   * (already created at boot) rather than inventing a second state
   * directory — this is a read-only version probe, not a workspace.
   */
  readonly scratchHome: string;
  readonly timeoutMs?: number;
}

/**
 * Build the real `runVersionCheck` — `claude --version`, through the
 * ADL-owned exec boundary (`owner: 'adl'`). `startDaemon` is the one caller;
 * exported so a future `adl doctor` entry point can reuse the exact same
 * invocation instead of re-deriving it.
 */
export function claudeVersionCheckRunner(
  deps: ClaudeVersionCheckRunnerDeps,
): () => Promise<BackendVersionCheckResult> {
  const binary = deps.binary ?? DEFAULT_CLAUDE_BINARY;
  return async () => {
    let stdout = '';
    const result = await run(
      {
        argv: [...binary, '--version'],
        cwd: deps.cwd,
        path: deps.path,
        networkPolicy: 'full',
        resources: {},
        timeoutMs: deps.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
      },
      deps.scratchHome,
      (chunk) => {
        if (chunk.stream === 'stdout') stdout += chunk.text;
      },
      {},
      'adl',
    );
    return { stdout, exitCode: result.exitCode };
  };
}
