#!/usr/bin/env node
// A replay double that plays both agent roles — like
// `fake-claude-role-switch.mjs`, and by the same `--append-system-prompt`
// test — but whose REVIEWER half says something different every time it runs
// (M07 step 7.8).
//
// Like every `fake-claude-*.mjs` in this directory, this file plays the role of
// the EXTERNAL agent CLI, not ADL orchestration code.
//
// ── Why a counter file ────────────────────────────────────────────────────
//
// LOOP-09 is a rule about what a gate said LAST time, so it cannot be observed
// with a double that says the same thing twice: a second identical send-back is
// the ordinary unfixed case and the policy correctly leaves it alone. This
// double therefore raises a genuinely new finding on its second review, which
// is the goalpost move under test.
//
// The counter lives in a file rather than in a variable because each invocation
// is a fresh process — `Workspace.exec()` launches the CLI once per stage
// attempt. `command-gate-loop.test.ts` established the same pattern for the
// same reason.
//
// eslint-disable-next-line no-restricted-imports -- this file IS the external program, not ADL code launching one
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);

function flag(name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

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

const REVIEWER_PROMPT_PREFIX = 'You are the ADL code reviewer';
const isReviewer = (flag('--append-system-prompt') ?? '').startsWith(
  REVIEWER_PROMPT_PREFIX,
);
const cwd = process.cwd();

if (!isReviewer) {
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

// Which review this is, counted OUTSIDE the worktree so a workspace teardown
// cannot reset it.
const counterPath = flag('--adl-review-counter');
let reviewNumber = 1;
if (counterPath !== undefined) {
  let previous = 0;
  try {
    previous = Number(readFileSync(counterPath, 'utf8').trim()) || 0;
  } catch {
    previous = 0;
  }
  reviewNumber = previous + 1;
  mkdirSync(dirname(counterPath), { recursive: true });
  writeFileSync(counterPath, String(reviewNumber), 'utf8');
}

/**
 * Two findings that are genuinely different findings, not the same one
 * reworded: `fingerprintFinding` normalises the title before hashing, so a
 * paraphrase would collapse to one fingerprint and the policy would correctly
 * see an unfixed repeat instead of a new opinion.
 *
 * The fingerprints are literals rather than computed, because this double
 * stands in for a model writing JSON by hand — the real reviewer is told the
 * rule in its instructions and produces the value itself.
 */
const REVIEWS = [
  {
    fingerprint: 'a'.repeat(64),
    title: 'the export button is missing',
    detail: 'nothing in the diff renders an export control',
  },
  {
    fingerprint: 'b'.repeat(64),
    title: 'the exporter has no error handling',
    detail: 'a brand-new opinion, raised for the first time after round 1',
  },
];
const review = REVIEWS[Math.min(reviewNumber, REVIEWS.length) - 1];

const instructions = argv[argv.length - 1] ?? '';
const verdictMatch =
  /write your verdict as a single JSON object to `([^`]+)`/.exec(instructions);
if (verdictMatch === null) {
  process.stderr.write(
    'fake-claude-reviewer-script: the instructions named no verdict path\n',
  );
  process.exit(9);
}

const verdictPath = join(cwd, verdictMatch[1]);
mkdirSync(dirname(verdictPath), { recursive: true });
writeFileSync(
  verdictPath,
  `${JSON.stringify({
    outcome: 'send_back',
    summary: `review ${String(reviewNumber)}`,
    findings: [
      {
        fingerprint: review.fingerprint,
        severity: 'blocker',
        title: review.title,
        detail: review.detail,
        criterionRef: { kind: 'criterion', id: 'AC-1' },
      },
    ],
  })}\n`,
  'utf8',
);

emitTranscript(`Reviewed (${String(reviewNumber)}). Verdict written.`);
process.exit(0);
