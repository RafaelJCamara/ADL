/**
 * The version preflight (D-01, D-02, OBS-08) — success criterion 3: "the
 * backend's CLI version is pinned and preflight-checked at startup, so an
 * unexpected version is reported as a broken installation rather than
 * discovered mid-run."
 *
 * This module is I/O-free, matching `@adl/agent-claude-code`'s own package
 * shape (no `execa`, no `@adl/workspace` dependency — 04-01's own scaffold
 * decision). `preflightClaudeCode` therefore takes the version-check
 * invocation as an injected runner rather than performing one itself; the
 * REAL invocation — `claude --version` through the ADL-owned exec boundary
 * (`packages/workspace/src/exec/run.ts`'s `owner: 'adl'`, because this is
 * ADL asking a question about its own installation, not an agent doing work
 * on a feature's behalf) — is `packages/manager/src/boot/backend-preflight.ts`'s
 * job (04-07 Task 2), which is the one package in this dependency chain that
 * is allowed to touch a process.
 *
 * ── KNOWN GAP (carried from 04-01 Task 3, deferred; see 04-06's own note for
 * the same gap) ──────────────────────────────────────────────────────────
 *
 * `04-01`'s Task 3 — capturing `claude --version`'s real output into
 * `test/fixtures/claude-version.txt` — was never completed (no
 * `ANTHROPIC_API_KEY` in that session, and a PATH-shadowing issue that
 * resolved a DIFFERENT, older install). No such fixture exists on disk.
 * `parseClaudeVersion`'s tests below are therefore held to the ONE piece of
 * real evidence this project has recorded: `04-01-SUMMARY.md`'s own
 * blocker note, which quotes a real invocation of the WinGet-installed
 * `claude` binary on the maintainer's machine returning
 * `"2.1.227 (Claude Code)"` verbatim. That is real, observed CLI output —
 * just not a formal, re-capturable fixture file for the PINNED version, and
 * not saved to disk as one, per the maintainer's explicit rejection (04-01)
 * of fabricating fixture files from documentation or invented output. The
 * regex below is therefore still `[ASSUMED]` for the pinned build
 * specifically (04-RESEARCH.md § Pitfall 2) and MUST be re-verified — by
 * capturing `test/fixtures/claude-version.txt` for real, per 04-01's Task 3
 * — before this parser is trusted against a live, credentialed run.
 */
import { PINNED_CLAUDE_CODE_VERSION } from './version.js';

/** A version-shaped token, matched anywhere in the line rather than requiring an exact whole-string match (04-RESEARCH.md § Pitfall 2). */
const VERSION_TOKEN_PATTERN = /(\d+\.\d+\.\d+)/;

/**
 * Find a version-shaped token in `claude --version`'s stdout, or `undefined`
 * when none is present. Defensive by design: the CLI's exact output format
 * is not a contracted API surface (Pitfall 2), so this matches a token
 * rather than the whole line — surrounding text (a banner, a trailing
 * `(Claude Code)` suffix) does not defeat it.
 */
export function parseClaudeVersion(stdout: string): string | undefined {
  return VERSION_TOKEN_PATTERN.exec(stdout)?.[1];
}

/**
 * Why `preflightClaudeCode` reported not-ok — three distinguishable kinds,
 * because each leads an operator to a different action (install it,
 * investigate it, change the installed version), and collapsing them into
 * one boolean hides which.
 *
 * `binary_missing` and `unparseable` are deliberately spelled to match
 * `@adl/core/stage`'s `StageErrorKind` vocabulary (`stage-error.ts`) where
 * that vocabulary already names the condition — "the binary could not be
 * run at all" and "the binary ran but its output carried no readable
 * version" are exactly `binary_missing` and `unparseable` there. There is
 * no existing `StageErrorKind` for "the binary reported a version that is
 * not the pinned one" — `version_mismatch` is this module's own name for
 * that condition, since `PreflightResult` is not itself a `StageError`
 * (this is a startup-gate concern, not a per-invocation one).
 */
export type PreflightFailureKind =
  'binary_missing' | 'unparseable' | 'version_mismatch';

/** What the injected version-check runner returns — a plain exec result, never thrown for an ordinary non-zero exit. */
export interface VersionCheckResult {
  readonly stdout: string;
  readonly exitCode: number | null;
}

/**
 * Whether the backend is usable, and why not when it is not (OBS-08). Never
 * thrown — every caller gets a value back, matching `StageError` and
 * `compareAndSwapState`'s "classify, don't throw" discipline.
 */
export interface PreflightResult {
  readonly ok: boolean;
  /** `null` when no version could be read at all (binary missing, or output unparseable). */
  readonly installedVersion: string | null;
  readonly expectedVersion: string;
  /** Present only when `ok` is `false`. */
  readonly kind?: PreflightFailureKind;
  /**
   * Names the expected version and what was found, and says the
   * installation is broken — success criterion 3's own wording, written
   * once here so every caller reports it identically. Present only when
   * `ok` is `false` (an `ok` result's detail is absent, never an empty
   * string).
   */
  readonly detail?: string;
}

/** The shared wording every not-ok `detail` carries: expected, found, and "broken installation" — success criterion 3's own phrasing. */
function brokenInstallationDetail(expected: string, found: string): string {
  return (
    `expected Claude Code CLI version ${expected}, found ${found} — ` +
    'the installation is broken.'
  );
}

/**
 * Probe the pinned Claude Code CLI's version, without ever throwing.
 *
 * Takes the invocation as an injected runner rather than performing one
 * itself — this module reads no environment and spawns no process (see the
 * module docblock). `runVersionCheck` rejecting (a genuine spawn-time
 * failure the caller's exec boundary reports as an exception, not as a
 * `VersionCheckResult`) is itself classified rather than propagated: a
 * broken installation the caller cannot even launch a check against is
 * still an honest `binary_missing`, not an uncaught rejection reaching a
 * daemon's boot sequence.
 */
export async function preflightClaudeCode(
  runVersionCheck: () => Promise<VersionCheckResult>,
): Promise<PreflightResult> {
  let result: VersionCheckResult;
  try {
    result = await runVersionCheck();
  } catch (error) {
    return {
      ok: false,
      installedVersion: null,
      expectedVersion: PINNED_CLAUDE_CODE_VERSION,
      kind: 'binary_missing',
      detail: brokenInstallationDetail(
        PINNED_CLAUDE_CODE_VERSION,
        `the version check could not run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }

  if (result.exitCode !== 0) {
    return {
      ok: false,
      installedVersion: null,
      expectedVersion: PINNED_CLAUDE_CODE_VERSION,
      kind: 'binary_missing',
      detail: brokenInstallationDetail(
        PINNED_CLAUDE_CODE_VERSION,
        `the CLI could not be run (\`claude --version\` exited ${result.exitCode ?? 'null'})`,
      ),
    };
  }

  const installed = parseClaudeVersion(result.stdout);
  if (installed === undefined) {
    return {
      ok: false,
      installedVersion: null,
      expectedVersion: PINNED_CLAUDE_CODE_VERSION,
      kind: 'unparseable',
      detail: brokenInstallationDetail(
        PINNED_CLAUDE_CODE_VERSION,
        "unparseable output — no version-shaped token in `claude --version`'s stdout",
      ),
    };
  }

  if (installed !== PINNED_CLAUDE_CODE_VERSION) {
    return {
      ok: false,
      installedVersion: installed,
      expectedVersion: PINNED_CLAUDE_CODE_VERSION,
      kind: 'version_mismatch',
      detail: brokenInstallationDetail(PINNED_CLAUDE_CODE_VERSION, installed),
    };
  }

  return {
    ok: true,
    installedVersion: installed,
    expectedVersion: PINNED_CLAUDE_CODE_VERSION,
  };
}
