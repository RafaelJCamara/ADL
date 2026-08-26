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
//   index 0        → `developer_outcome: committed`, a real commit
//   index 1..n-1   → `verdict`, with the outcome taken from a scripted list
//
// The list is consumed ACROSS PROCESSES, one entry per gate invocation, via a
// counter file: each stage runs in its own forked worker (one `assign` per
// process lifetime), so an in-memory cursor would reset to 0 every time and
// round 2 would replay round 1's answer. The file is the only thing that
// survives the process the loop is deliberately throwing away.
//
// Index 0 makes a REAL commit in a REAL workspace, through the same
// `@adl/workspace` registry `createProductionStageRunner` uses — a fabricated
// sha with nothing behind it (this file's own `SCRIPTED_COMMITTED_SHA`
// history) stopped being an option the moment ROLE-11's protected-path check
// (M05 step 5.16) became unconditional on every `committed` outcome: it diffs
// the reported sha against the round's base, and a sha that names no real
// commit fails that diff outright rather than passing it. This double plays
// the role of the developer's own action for stage 0 — the same role
// `fake-claude-success.mjs` plays for the real production stage runner's own
// `claude` binary — so it does its own `git add`/`git commit`, directly,
// for the identical reason that file's docblock gives.
// eslint-disable-next-line no-restricted-imports -- see the note above: stage 0 plays the developer's own commit, and a real commit needs real git
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { workspaceRegistry } from '@adl/workspace';
import type { Verdict } from '@adl/core/verdict';
import { composeBranchFeatureId } from '../../src/branch-identity.js';
import type { AssignMessage } from '../../src/ipc/protocol.js';
import type { StageRunnerVerdict } from '../../src/ipc/stage-verdict.js';
import { runWorker, type StageRunner } from '../../src/worker-entry/index.js';

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

/**
 * The developer's own step: attach to the workspace a prior round left (or
 * create one, on round 1 — `createProductionStageRunner`'s exact "attach
 * first" shape, M05 step 5.14), append a distinct line, commit it for real,
 * and report the sha `git` actually produced.
 *
 * Appends rather than writing a fixed line for the reason
 * `fake-claude-success.mjs` documents: round 2 attaches to a worktree that
 * already contains round 1's commit, and identical content would stage
 * nothing.
 */
async function runDeveloperStage(assign: AssignMessage): Promise<string> {
  const registry = workspaceRegistry();
  const backend = registry.resolve(assign.workspaceBackendId);
  const workspaceSpec = {
    featureId: composeBranchFeatureId(
      basename(assign.workspaceHandle),
      assign.featureId,
    ),
    mainRepo: assign.mainRepo,
    scratchRoot: assign.scratchRoot,
    baseRef: assign.baseRef,
  };

  const workspace =
    (await backend.attach(workspaceSpec)) ??
    (await backend.create(workspaceSpec));

  try {
    const outputPath = join(workspace.root, 'agent-output.txt');
    let existing = '';
    try {
      existing = readFileSync(outputPath, 'utf8');
    } catch {
      existing = '';
    }
    writeFileSync(
      outputPath,
      `${existing}written by the scripted pipeline double (pid ${String(process.pid)}, ${process.hrtime.bigint().toString()})\n`,
      'utf8',
    );
    execFileSync('git', ['add', 'agent-output.txt'], { cwd: workspace.root });
    execFileSync('git', ['commit', '-m', 'scripted: implement the feature'], {
      cwd: workspace.root,
    });
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspace.root,
    })
      .toString()
      .trim();
  } finally {
    await workspace.detach();
  }
}

const stageRunner: StageRunner = async (assign) => {
  await new Promise((resolve) =>
    setTimeout(resolve, Number(process.env['ADL_TEST_STAGE_DELAY_MS'] ?? '10')),
  );

  const verdict: StageRunnerVerdict =
    assign.stageIndex === 0
      ? {
          kind: 'developer_outcome',
          outcome: { kind: 'committed', sha: await runDeveloperStage(assign) },
        }
      : { kind: 'verdict', verdict: verdictNamed(nextGateOutcome()) };

  return { verdictJson: JSON.stringify(verdict) };
};

runWorker({ stageRunner });
