/**
 * The runner-report corpus (ROLE-08, M08 step 8.5): what each `.tap` file in
 * this directory is, and how it was produced.
 *
 * Every fixture is a **real runner's real stdout**, captured verbatim on
 * 2026-09-25 against node v24.19.0 (`node --test --test-reporter=tap`, default
 * process isolation) and the repository's installed vitest 4.1
 * (`vitest run --reporter=tap`, and `--reporter=tap-flat` where named), each in
 * its own scratch project — convention 15: the rules in `tap.ts` were set
 * against these, not against the TAP specification's prose. The only edit is
 * the scratch directory's absolute path, replaced by `<root>` so no host path
 * is committed; `exitCode` is the runner's real exit status for that run.
 *
 * Synthetic cases — shapes neither runner prints but the specification allows,
 * or truncations of real output — live inline in the tests, labelled as such.
 */
export interface CapturedRun {
  readonly runner: 'node' | 'vitest';
  readonly argv: readonly string[];
  readonly exitCode: number;
}

export const CAPTURED_RUNS = {
  'node-zero': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 0,
  },
  'node-pass': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 0,
  },
  'node-fail': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 1,
  },
  'node-nested-fail': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 1,
  },
  'node-nested-double': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 0,
  },
  'node-describe-all-skipped': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 0,
  },
  'node-skip-todo-only': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 0,
  },
  'node-after-hook': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 1,
  },
  'node-before-hook': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 1,
  },
  'node-load-throw': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 1,
  },
  'node-exitcode': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 1,
  },
  'node-empty-file': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 0,
  },
  'node-exit0-midrun': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 0,
  },
  'node-hash-names': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 1,
  },
  'node-console': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 0,
  },
  'node-empty-describe': {
    runner: 'node',
    argv: ['node', '--test', '--test-reporter=tap'],
    exitCode: 0,
  },
  'vitest-pass-nested': {
    runner: 'vitest',
    argv: ['vitest', 'run', '--reporter=tap'],
    exitCode: 0,
  },
  'vitest-fail': {
    runner: 'vitest',
    argv: ['vitest', 'run', '--reporter=tap'],
    exitCode: 1,
  },
  'vitest-zero': {
    runner: 'vitest',
    argv: ['vitest', 'run', '--reporter=tap'],
    exitCode: 1,
  },
  'vitest-after-all': {
    runner: 'vitest',
    argv: ['vitest', 'run', '--reporter=tap'],
    exitCode: 1,
  },
  'vitest-after-all-flat': {
    runner: 'vitest',
    argv: ['vitest', 'run', '--reporter=tap-flat'],
    exitCode: 1,
  },
  'vitest-before-all': {
    runner: 'vitest',
    argv: ['vitest', 'run', '--reporter=tap'],
    exitCode: 1,
  },
  'vitest-before-all-flat': {
    runner: 'vitest',
    argv: ['vitest', 'run', '--reporter=tap-flat'],
    exitCode: 1,
  },
  'vitest-unhandled': {
    runner: 'vitest',
    argv: ['vitest', 'run', '--reporter=tap'],
    exitCode: 1,
  },
  'vitest-skipped-only': {
    runner: 'vitest',
    argv: ['vitest', 'run', '--reporter=tap'],
    exitCode: 0,
  },
  'vitest-forged': {
    runner: 'vitest',
    argv: ['vitest', 'run', '--reporter=tap'],
    exitCode: 1,
  },
  'vitest-empty-file': {
    runner: 'vitest',
    argv: ['vitest', 'run', '--reporter=tap'],
    exitCode: 1,
  },
} as const satisfies Readonly<Record<string, CapturedRun>>;

export type CapturedRunName = keyof typeof CAPTURED_RUNS;

export const CAPTURED_RUN_NAMES = Object.keys(
  CAPTURED_RUNS,
) as readonly CapturedRunName[];
