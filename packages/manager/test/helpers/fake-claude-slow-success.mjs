#!/usr/bin/env node
// Same replay double as `fake-claude-success.mjs`, but with a real,
// observable delay between each stream-json line — so the tracer test can
// prove the transcript file's byte length actually GROWS while the stage is
// still running, rather than only appearing all at once at the end (the
// exact anti-pattern `04-RESEARCH.md`'s own "Anti-Patterns to Avoid" names).
// Mirrors `ADL_TEST_STAGE_DELAY_MS`'s precedent in Phase 3's own tracer
// (`test/tracer/dev-run-end-to-end.test.ts` there uses the same idea for a
// different double).
//
// This file plays the role of the EXTERNAL agent CLI itself, not ADL
// orchestration code — see `fake-claude-success.mjs`'s identical note.
// eslint-disable-next-line no-restricted-imports -- see the note above: this file IS the external program, not ADL code launching one
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const cwd = process.cwd();
const delayMs = Number(process.env['ADL_TRACER_STAGE_DELAY_MS'] ?? '150');

process.stdout.write(
  `${JSON.stringify({
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet-5',
    session_id: 'sess_tracer',
  })}\n`,
);
await delay(delayMs);

writeFileSync(`${cwd}/agent-output.txt`, 'written by the fake claude double\n');
execFileSync('git', ['add', 'agent-output.txt'], { cwd });
execFileSync('git', ['commit', '-m', 'agent: implement the feature'], { cwd });

process.stdout.write(
  `${JSON.stringify({
    type: 'assistant',
    message: {
      id: 'm1',
      content: [{ type: 'text', text: 'Implementing now.' }],
    },
  })}\n`,
);
await delay(delayMs);

process.stdout.write(
  `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    duration_ms: delayMs * 2,
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5 },
  })}\n`,
);
process.exit(0);
