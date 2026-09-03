#!/usr/bin/env node
// A replay double that plays BOTH agent roles, choosing between them the way
// the real CLI would have to: by reading its own `--append-system-prompt`
// argument (M07 step 7.5).
//
// Like every `fake-claude-*.mjs` in this directory, this file plays the role
// of the EXTERNAL agent CLI — the thing `Workspace.exec()` launches, not ADL
// orchestration code — so WORK-02's "every process ADL starts goes through
// Workspace.exec()" is about the caller of this script, not about what this
// script does internally.
//
// ── Why one double and not two ────────────────────────────────────────────
//
// `ADL_TRACER_CLAUDE_BINARY_JSON` names ONE binary for the whole daemon, and a
// `['develop', 'review']` pipeline launches it twice with different prompts. A
// double that behaved identically both times could not be a reviewer, and two
// separate doubles could not be selected between. Switching on the system
// prompt is also the honest stand-in for what actually distinguishes the two
// invocations in production: the argv, and nothing else.
//
// ── What the reviewer half does, and why ──────────────────────────────────
//
// ROLE-03 says the reviewer "never inherits the developer's session,
// transcript, or reasoning". The type (`GateContext`) and the lint rule
// (`adl/gate-fresh-context`) make that structurally true inside ADL. Neither
// can be observed from outside the process, so this half goes looking: it
// walks everything ADL gave it a root for, records every file it can see, and
// writes the whole report — plus its own argv and environment — to a path the
// test names. The test then asserts that the developer's transcript exists,
// that the walk worked, and that the walk did not find it.
//
// A search that finds nothing because it is broken proves nothing, which is
// why the report carries EVERY file seen and not only the interesting ones.
//
// eslint-disable-next-line no-restricted-imports -- see the note above: this file IS the external program, not ADL code launching one
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const argv = process.argv.slice(2);

/** The value of a `--flag <value>` pair, or `undefined`. */
function flag(name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

/** The small, representative `stream-json` transcript every double in this directory emits. */
function emitTranscript(text) {
  const lines = [
    {
      type: 'system',
      subtype: 'init',
      model: flag('--model') ?? 'claude-sonnet-5',
      session_id: 'sess_fake',
    },
    {
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text }] },
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
}

// The reviewer's system prompt is composed in
// `packages/manager/src/worker-entry/gates/reviewer-gate.ts` and begins with
// this sentence. Matching on the prompt rather than on a flag the test could
// pass is deliberate: a flag would let this double be "the reviewer" on a run
// where ADL never told it it was one.
const REVIEWER_PROMPT_PREFIX = 'You are the ADL code reviewer';
const isReviewer = (flag('--append-system-prompt') ?? '').startsWith(
  REVIEWER_PROMPT_PREFIX,
);

const cwd = process.cwd();

if (!isReviewer) {
  // ── Developer ───────────────────────────────────────────────────────────
  // The behaviour of `fake-claude-success.mjs`: append a DISTINCT line (see
  // that file's header for why a fixed one breaks round 2), stage it, commit.
  appendFileSync(
    `${cwd}/agent-output.txt`,
    `written by the fake claude double (pid ${process.pid}, ${process.hrtime.bigint()})\n`,
  );
  execFileSync('git', ['add', 'agent-output.txt'], { cwd });
  execFileSync('git', ['commit', '-m', 'agent: implement the feature'], {
    cwd,
  });
  emitTranscript('Implementing now.');
  process.exit(0);
}

// ── Reviewer ──────────────────────────────────────────────────────────────

/**
 * Every file and directory under `root`, as paths relative to it.
 *
 * Bounded, and it says so when it stops: an unbounded walk that silently
 * truncated would let "found no transcript" mean "gave up before looking".
 */
function walk(root) {
  const files = [];
  const dirs = [];
  const queue = [root];
  let truncated = false;
  while (queue.length > 0) {
    if (files.length + dirs.length >= 5000) {
      truncated = true;
      break;
    }
    const current = queue.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // Unreadable is not the same as absent, and neither is a transcript.
      continue;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const rel = relative(root, absolute).split(sep).join('/');
      if (entry.isDirectory()) {
        dirs.push(rel);
        queue.push(absolute);
      } else {
        files.push(rel);
      }
    }
  }
  return { files, dirs, truncated };
}

/**
 * The environment, with credential-shaped VALUES withheld.
 *
 * A maintainer running this suite with a real `ANTHROPIC_API_KEY` exported
 * would otherwise have it written to a file. `redactedKeys` is reported
 * separately so the test can assert this redaction did not swallow the
 * evidence it is looking for — a withheld value hiding a transcript path
 * would make the whole report vacuous.
 */
function environment() {
  const values = {};
  const redactedKeys = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) {
      redactedKeys.push(key);
    } else {
      values[key] = value;
    }
  }
  return { values, redactedKeys };
}

const tree = walk(cwd);

// Where the reviewer half writes what it found. Passed in the binary prefix
// (`ADL_TRACER_CLAUDE_BINARY_JSON`) rather than in an environment variable for
// the reason `fake-claude-success.mjs` records for `--adl-argv-log`:
// `@adl/workspace` builds a zero-inherit child env, so an env var the test set
// would simply not arrive.
const reportPath = flag('--adl-reviewer-report');
if (reportPath !== undefined) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        cwd,
        // The full command line, which carries the ENTIRE rendered prompt: the
        // system prompt after `--append-system-prompt`, and the instructions as
        // the final positional argument. This is what the reviewer process
        // actually received, not what ADL believes it sent.
        argv,
        env: environment(),
        files: tree.files,
        dirs: tree.dirs,
        truncated: tree.truncated,
        // The hunt, spelled out. `.ndjson` is `TRANSCRIPT_EXTENSION`; a `logs`
        // directory is what `logsRootFor` builds; `.prompt` is
        // `PROMPT_ARTIFACT_EXTENSION`, the developer's rendered prompt on disk.
        transcripts: tree.files.filter((path) => path.endsWith('.ndjson')),
        promptArtifacts: tree.files.filter((path) => path.endsWith('.prompt')),
        logDirs: tree.dirs.filter((path) => path.split('/').includes('logs')),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

// The verdict path is read out of the INSTRUCTIONS rather than reconstructed,
// exactly as a real agent would have to — which also makes this double's
// success evidence that `renderInstructions` names a path a reader can find.
const instructions = argv[argv.length - 1] ?? '';
const verdictMatch =
  /write your verdict as a single JSON object to `([^`]+)`/.exec(instructions);
if (verdictMatch === null) {
  process.stderr.write(
    'fake-claude-role-switch: the instructions named no verdict path\n',
  );
  process.exit(9);
}

const verdictPath = join(cwd, verdictMatch[1]);
mkdirSync(dirname(verdictPath), { recursive: true });
writeFileSync(
  verdictPath,
  `${JSON.stringify({
    outcome: 'pass',
    summary: 'the diff implements the criterion',
    checked: [{ kind: 'criterion', id: 'AC-1' }],
  })}\n`,
  'utf8',
);

emitTranscript('Reviewed. Verdict written.');
process.exit(0);
