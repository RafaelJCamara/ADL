#!/usr/bin/env node
// A replay double that plays the developer and the BEHAVIOUR TESTER (M08 step 8.4).
//
// Like every `fake-claude-*.mjs` in this directory, this file plays the role of the
// EXTERNAL agent CLI, not ADL orchestration code. It tells the two roles apart the
// way `fake-claude-role-switch.mjs` and `fake-claude-reviewer-script.mjs` do — by
// the `--append-system-prompt` ADL passes — which is itself worth noting: that ADL
// distinguishes the roles only through the prompt it composes is what makes the
// tester a gate rather than a privileged path.
//
// ── What the tester half actually proves ──────────────────────────────────
//
// It does not fabricate a verdict. It reads the base URL out of its own
// instructions, **really fetches it**, and reports what came back — so a green
// verdict here means an app was really listening on the port ADL interpolated, and
// the tester really reached it from its own code-blind workspace.
//
// It also writes down what it could see, to a file outside every workspace, so the
// test can assert code-blindness from OUTSIDE ADL's bookkeeping — 7.5's, 7.9's and
// 8.1's pattern. If ADL believed it had composed a blind workspace and had not,
// that file says so.
//
// eslint-disable-next-line no-restricted-imports -- this file IS the external program, not ADL code launching one
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { refuseToCommitInSourceCheckout } from './refuse-source-checkout.mjs';

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

const TESTER_PROMPT_PREFIX = 'You are the ADL behaviour tester';
const isTester = (flag('--append-system-prompt') ?? '').startsWith(
  TESTER_PROMPT_PREFIX,
);
const cwd = process.cwd();

if (!isTester) {
  // Before any write: never in this repository's own checkout (see
  // `refuse-source-checkout.mjs` for the incident that made this necessary).
  refuseToCommitInSourceCheckout(cwd, 'fake-claude-tester');
  appendFileSync(
    `${cwd}/agent-output.txt`,
    `written by the fake claude double (pid ${process.pid})\n`,
  );
  execFileSync('git', ['add', 'agent-output.txt'], { cwd });
  execFileSync('git', ['commit', '-m', 'agent: implement the feature'], {
    cwd,
  });
  emitTranscript('Implementing now.');
  process.exit(0);
}

// ── Tester ────────────────────────────────────────────────────────────────

const instructions = argv[argv.length - 1] ?? '';

/** Every repo-relative file the tester can see, so absence is measurable. */
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, acc);
    else acc.push(relative(cwd, absolute).split('\\').join('/'));
  }
  return acc;
}

const reportPath = flag('--adl-tester-report');
const baseUrlMatch = /^Base URL: (\S+)$/m.exec(instructions);
// Case-insensitive, because the reviewer's prompt says "Then write your verdict"
// and the tester's says "3. Write your verdict" — a case-sensitive regex here cost
// a full scenario run to diagnose, since a double that exits 9 is reported as
// `cancelled` and looks exactly like a killed CLI.
const verdictMatch =
  /write your verdict as a single JSON object to `([^`]+)`/i.exec(instructions);

const report = {
  sawBaseUrl: baseUrlMatch?.[1] ?? null,
  files: walk(cwd).sort(),
  /** Whether the instructions named any changed implementation path. */
  instructionsMentionSrc: /\bsrc\//.test(instructions),
  /** Whether the instructions said the source is absent rather than off-limits. */
  toldSourceIsAbsent: instructions.includes('is **not** there'),
  fetched: null,
  fetchError: null,
};

if (baseUrlMatch !== null) {
  try {
    const response = await fetch(`${report.sawBaseUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    report.fetched = { status: response.status, body: await response.text() };
  } catch (error) {
    report.fetchError = error instanceof Error ? error.message : String(error);
  }
}

if (reportPath !== undefined) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
}

if (verdictMatch === null) {
  process.stderr.write(
    'fake-claude-tester: the instructions named no verdict path\n',
  );
  process.exit(9);
}

// A pass only if the app really answered. A double that passed regardless would
// make every assertion in the scenario about itself rather than about ADL.
const verdict =
  report.fetched?.status === 200
    ? {
        outcome: 'pass',
        summary: `the app answered 200 on ${report.sawBaseUrl}/health`,
        checked: [{ kind: 'criterion', id: 'AC-1' }],
      }
    : {
        outcome: 'send_back',
        summary: 'the app did not answer',
        findings: [
          {
            fingerprint: 'c'.repeat(64),
            severity: 'blocker',
            title: 'the app did not answer /health',
            detail: `fetch said: ${report.fetchError ?? 'unexpected status'}`,
            criterionRef: { kind: 'criterion', id: 'AC-1' },
          },
        ],
      };

const verdictPath = join(cwd, verdictMatch[1]);
mkdirSync(dirname(verdictPath), { recursive: true });
writeFileSync(verdictPath, `${JSON.stringify(verdict)}\n`, 'utf8');

emitTranscript('Behaviour tested.');
process.exit(0);
