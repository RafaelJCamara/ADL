/**
 * Loads the captured runner-report corpus (`test/fixtures/runner-report/`) for
 * `tap.test.ts` and `runner-report.test.ts`.
 *
 * A module of its own rather than a copy in each suite, so the two cannot
 * disagree about which fixtures exist or what exit code each one really had.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CAPTURED_RUN_NAMES,
  CAPTURED_RUNS,
  type CapturedRunName,
} from '../fixtures/runner-report/manifest.js';

export { CAPTURED_RUN_NAMES, CAPTURED_RUNS, type CapturedRunName };

/** The fixture's text exactly as committed, `<root>` placeholder included. */
export function capturedReport(name: CapturedRunName): string {
  return readFileSync(
    fileURLToPath(
      new URL(`../fixtures/runner-report/${name}.tap`, import.meta.url),
    ),
    'utf8',
  );
}
