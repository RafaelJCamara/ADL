#!/usr/bin/env node
// A stand-in for the pinned Claude Code CLI's `--version` output — the one
// invocation `claudeVersionCheckRunner` (`src/boot/backend-preflight.ts`)
// makes. Reads the expected version from argv[2] rather than hardcoding
// `PINNED_CLAUDE_CODE_VERSION` here, so a version bump in
// `@adl/agent-claude-code` cannot silently desync this fixture from the
// value it is meant to match.
const version = process.argv[2];
if (process.argv.includes('--version')) {
  process.stdout.write(`${version} (Claude Code)\n`);
  process.exit(0);
}
process.stderr.write('fake-claude-version.mjs: expected --version\n');
process.exit(1);
