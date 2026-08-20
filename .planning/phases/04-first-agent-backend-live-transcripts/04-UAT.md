---
status: testing
phase: 04-first-agent-backend-live-transcripts
source: [04-VERIFICATION.md]
started: 2026-08-20T21:39:01Z
updated: 2026-08-20T21:39:01Z
---

## Current Test

number: 1
name: A real, credentialed Claude Code CLI invocation, end to end
expected: |
  The transcript scrolls live while the run is still going (not all at once at the end);
  the `adl logs -f` process exits on its own once the run finishes (does not need Ctrl-C);
  `git log` on the feature's branch shows a new commit authored as `ADL (claude-code) <...>`,
  never the operator's own git identity; the resulting `usage_events` row
  (`usageRepository(db).listForFeature`) has `cost_source: 'reported'` and a plausible cost
  that reconciles against the Anthropic Console's billed usage for the same window.
awaiting: user response

## Tests

### 1. A real, credentialed Claude Code CLI invocation, end to end
expected: |
  With the pinned Claude Code CLI (`@anthropic-ai/claude-code@2.1.237`) resolving on the
  daemon's PATH and a real `ANTHROPIC_API_KEY` set, start the daemon against a repository
  containing one real `features/<id>/` folder. In one terminal run `adl dev-run <feature-id>`;
  in another run `adl logs -f <stage-attempt-id>`. The transcript scrolls live while the run
  is still going; `adl logs -f` exits on its own once the run finishes; `git log` shows a new
  commit authored as `ADL (claude-code) <...>`; the recorded `usage_events` row has
  `cost_source: 'reported'` and a plausible cost.
result: [pending]

## Summary

total: 1
passed: 0
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps
