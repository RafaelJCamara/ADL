/**
 * `commands.build` and `commands.teardown` for M08 step 8.2's tracer — one file,
 * because both do the same thing: prove they ran, in order, with a timestamp.
 *
 * Appending rather than overwriting, so the ORDER is observable. The assertion
 * that matters is not "teardown ran" — it is "teardown ran, and build ran before
 * the app was started", which a pair of overwritten marker files cannot answer.
 *
 * argv[2] — the marker file (absolute, outside every workspace).
 * argv[3] — which phase this invocation is.
 */
import { appendFileSync } from 'node:fs';

const [, , markerPath, phase] = process.argv;

appendFileSync(markerPath, `${phase}\n`, 'utf8');
console.log(`ADL_APP_PHASE ${phase}`);
