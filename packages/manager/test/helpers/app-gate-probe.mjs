/**
 * A plain-command gate that judges a RUNNING app (M08 step 8.2's tracer).
 *
 * `blind-gate-probe.mjs`'s sibling, and the same discipline: it reports what it
 * can reach with its own process, to a file outside every workspace, so the
 * evidence does not come from ADL's own bookkeeping. If ADL believed it had
 * started an app on the port it interpolated and had not, this file says so.
 *
 * It learns the port the way every command gate does — `${ADL_PORT}` substituted
 * into its **own command's `env`**, which is the same substitution the app itself
 * got. There is no `GateContext` member carrying a port, deliberately: one
 * mechanism, one answer to "where does the port come from".
 *
 * It is a third party's gate in every respect that matters: it declares its own
 * `with.command` and its own `needs_app`, and ADL's built-in tester (step 8.4)
 * will get the lifecycle through this identical path. That is HARN-04 measured
 * rather than claimed.
 *
 * argv[2] — where to write the report.
 */
import { writeFileSync } from 'node:fs';

const reportPath = process.argv[2];
const port = process.env.APP_PORT;

/** What the gate managed to learn. Every field is something ADL could be wrong about. */
const report = {
  /** The port the gate was told about, through its own command's interpolated env. */
  portFromEnv: port ?? null,
  /** Whether the gate was handed the variable at all. */
  sawPort: port !== undefined && port !== '',
  status: null,
  body: null,
  error: null,
};

if (report.sawPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    report.status = response.status;
    report.body = await response.text();
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
}

writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

// Exit 0 — this gate passes. It is measuring the lifecycle, not judging the
// feature, and a send-back would start a second round with nothing further to
// observe.
process.exit(0);
