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

// M06 step 6.10. Two additions, both of which make this double a more
// faithful stand-in rather than a more convenient one.
//
// 1. It records the argv it was launched with, when a test asks for it with
//    `--adl-argv-log <path>` in the binary prefix
//    (`ADL_TRACER_CLAUDE_BINARY_JSON`). That is the only way to observe what
//    the manager actually put on the command line from outside the process
//    that built it — asserting on ADL's own argv-building function proves the
//    function, not the wiring between four packages that carries its result
//    to a real exec.
//
//    The path arrives in ARGV rather than in an environment variable on
//    purpose: `@adl/workspace`'s exec boundary builds a zero-inherit child
//    env (`buildChildEnv`, deliberately off the barrel so no second
//    env-assembly site can exist), so an env var set by the test simply would
//    not arrive. Going through the binary prefix respects that boundary
//    instead of asking for a hole in it.
//
// 2. It reports back whatever `--model` it received, exactly as the real CLI
//    does: 6.9's probe against the installed binary observed `--model
//    claude-haiku-4-5` producing `"model":"claude-haiku-4-5"` on the
//    system/init line, and no flag producing the CLI's own default. A double
//    that ignored the flag would let a broken selection path still price the
//    ledger correctly, which is the exact failure this step exists to catch.
//
// Absent both, this double behaves byte-identically to its pre-6.10 self, so
// every test that predates the flag is unaffected.
const argv = process.argv.slice(2);

const argvLogIndex = argv.indexOf('--adl-argv-log');
if (argvLogIndex >= 0 && argvLogIndex + 1 < argv.length) {
  appendFileSync(argv[argvLogIndex + 1], `${JSON.stringify(argv)}\n`);
}

const modelFlagIndex = argv.indexOf('--model');
const reportedModel =
  modelFlagIndex >= 0 && modelFlagIndex + 1 < argv.length
    ? argv[modelFlagIndex + 1]
    : 'claude-sonnet-5';

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
    model: reportedModel,
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
