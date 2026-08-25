#!/usr/bin/env node
// A replay double standing in for the pinned Claude Code CLI (see this
// plan's KNOWN GAP note — 04-01's real fixtures/fake-claude.mjs were
// deferred). Writes a real file, makes a real commit using whatever
// GIT_AUTHOR_*/GIT_COMMITTER_* identity it was launched with, then emits a
// small, representative stream-json transcript and exits 0.
//
// This file plays the role of the EXTERNAL agent CLI itself — the thing
// `Workspace.exec()` launches, not ADL orchestration code — so WORK-02's
// "every process ADL starts goes through Workspace.exec()" rule is about the
// caller of this script, not this script's own internal behaviour. A real
// `claude` binary runs its own subprocesses (including `git`) exactly this
// way; this double has to as well to be a faithful stand-in.
// eslint-disable-next-line no-restricted-imports -- see the note above: this file IS the external program, not ADL code launching one
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const cwd = process.cwd();

// APPENDS a distinct line rather than writing a fixed one, and that is a
// correctness requirement rather than a flourish (M05 step 5.14).
//
// Since a workspace outlives the stage that created it (`Workspace.detach`,
// closing `docs/plan/DEBT.md` D-5-13-1), round 2's developer attaches to a
// worktree that ALREADY contains round 1's commit. A double that wrote
// identical content would leave nothing staged, `git commit` would exit
// non-zero, and the round would report a `provider_error` and retry forever —
// which is exactly what `test/scenario/command-gate-loop.test.ts` reproduced
// the first time it ran. A real agent handed a send-back makes a different
// change; this line is the double's stand-in for that.
appendFileSync(
  `${cwd}/agent-output.txt`,
  `written by the fake claude double (pid ${process.pid}, ${process.hrtime.bigint()})\n`,
);
execFileSync('git', ['add', 'agent-output.txt'], { cwd });
execFileSync('git', ['commit', '-m', 'agent: implement the feature'], { cwd });

const lines = [
  {
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet-5',
    session_id: 'sess_fake',
  },
  {
    type: 'assistant',
    message: {
      id: 'm1',
      content: [{ type: 'text', text: 'Implementing now.' }],
    },
  },
  {
    type: 'result',
    subtype: 'success',
    duration_ms: 5,
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5 },
  },
];
for (const line of lines) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
process.exit(0);
