/**
 * The exact Claude Code CLI version this adapter is built and tested against.
 *
 * ── Why an exact pin, not a floor (D-01) ───────────────────────────────────
 *
 * `04-RESEARCH.md` records a near-daily release cadence for
 * `@anthropic-ai/claude-code`, and its own behaviour — the shape of
 * `claude --version`'s output (Pitfall 2), the exact event stream the
 * `--bare --output-format stream-json --verbose --include-partial-messages
 * --append-system-prompt` combination produces (Pitfall 1), and the field
 * names inside the `usage` object (Assumption A1) — is not a contracted API
 * surface. Success criterion 4 requires that the same feature, on the same
 * commit, receive the same prompt twice against a CLI whose own behaviour is
 * not itself pinned. A minimum-version floor (`^2.1.237`) would let a silent
 * upstream release change any of those three shapes underneath this adapter
 * with no signal beyond a build going red somewhere downstream. An exact pin
 * makes "the CLI changed" a deliberate, reviewable act: bumping this constant
 * is what re-runs the `test/fixtures/CAPTURE.md` capture in
 * `packages/agent-claude-code/test/fixtures/`, rather than something a
 * routine `pnpm update` does to the codebase without anyone deciding to.
 */
export const PINNED_CLAUDE_CODE_VERSION = '2.1.237';
