// A scripted worker double that answers DIFFERENTLY PER PIPELINE STAGE — the
// thing every earlier double could not do, and the thing a round loop needs
// exercised (M05 step 5.13).
//
// `scripted-committed-worker-entry.ts` reports a real `committed` outcome for
// whatever stage it is handed, which is exactly right for proving the publish
// hooks fire and useless for proving a *pipeline* runs: every stage would look
// like the developer. This one reads `assign.stageIndex` — the same field the
// production stage runner now branches on — and reports:
//
//   index 0        → `developer_outcome: committed`, a real envelope
//   index 1..n-1   → `verdict`, with the outcome taken from a scripted list
//
// The list is consumed ACROSS PROCESSES, one entry per gate invocation, via a
// counter file: each stage runs in its own forked worker (one `assign` per
// process lifetime), so an in-memory cursor would reset to 0 every time and
// round 2 would replay round 1's answer. The file is the only thing that
// survives the process the loop is deliberately throwing away.
//
// Like every other entry in this directory, `runWorker(...)` at the bottom is a
// real top-level side effect: this module exists to be `fork()`ed, never
// imported by a test process.
import { readFileSync, writeFileSync } from 'node:fs';
import { runWorker, type StageRunner } from '../../src/worker-entry/index.js';
import type { StageRunnerVerdict } from '../../src/ipc/stage-verdict.js';
import type { Verdict } from '@adl/core/verdict';
import { SCRIPTED_COMMITTED_SHA } from './worker-harness.js';

const CRITERION = { kind: 'global', category: 'other' } as const;

/** One gate answer, by name — the four a scripted pipeline realistically needs. */
function verdictNamed(name: string): Verdict {
  switch (name) {
    case 'send_back':
      return {
        outcome: 'send_back',
        summary: 'the scripted gate wants changes',
        findings: [
          {
            fingerprint: 'f'.repeat(64),
            severity: 'blocker',
            title: 'the scripted gate found something',
            detail: 'scripted',
            criterionRef: CRITERION,
          },
        ],
      };
    case 'fail':
      return {
        outcome: 'fail',
        summary: 'the scripted gate is broken',
        reason: 'scripted',
      };
    case 'inconclusive':
      return {
        outcome: 'inconclusive',
        summary: 'the scripted gate could not tell',
        reason: 'scripted',
      };
    default:
      return {
        outcome: 'pass',
        summary: 'the scripted gate is satisfied',
        checked: [CRITERION],
      };
  }
}

/** Take the next scripted gate answer, advancing the cross-process cursor. */
function nextGateOutcome(): string {
  const outcomes = (process.env['ADL_TEST_GATE_OUTCOMES'] ?? 'pass').split(',');
  const counterPath = process.env['ADL_TEST_GATE_COUNTER'];
  if (counterPath === undefined) return outcomes[0] ?? 'pass';

  let cursor = 0;
  try {
    cursor = Number.parseInt(readFileSync(counterPath, 'utf8'), 10) || 0;
  } catch {
    cursor = 0;
  }
  writeFileSync(counterPath, String(cursor + 1), 'utf8');
  // Past the end, the last entry repeats — a scripted pipeline that ran one
  // round longer than the script anticipated should not crash the double.
  return outcomes[Math.min(cursor, outcomes.length - 1)] ?? 'pass';
}

const stageRunner: StageRunner = async (assign) => {
  await new Promise((resolve) =>
    setTimeout(resolve, Number(process.env['ADL_TEST_STAGE_DELAY_MS'] ?? '10')),
  );

  const verdict: StageRunnerVerdict =
    assign.stageIndex === 0
      ? {
          kind: 'developer_outcome',
          outcome: { kind: 'committed', sha: SCRIPTED_COMMITTED_SHA },
        }
      : { kind: 'verdict', verdict: verdictNamed(nextGateOutcome()) };

  return { verdictJson: JSON.stringify(verdict) };
};

runWorker({ stageRunner });
