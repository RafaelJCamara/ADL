import type { DaemonClient } from '../http-client.js';
import type { WriteSink } from './status.js';

/**
 * `adl dev-run <feature-id>` — D-03: exercise a real developer-agent commit
 * against a real `features/<id>/` folder while no loop exists yet. Follows
 * `pause.ts`'s `(options, deps)` shape with an injected client and write
 * sink — no CLI verb in this package talks to the daemon any other way.
 */

export interface DevRunCommandOptions {
  readonly featureId: string;
}

export interface DevRunCommandDeps {
  readonly client: DaemonClient;
  readonly stdout?: WriteSink;
}

export async function devRunCommand(
  options: DevRunCommandOptions,
  deps: DevRunCommandDeps,
): Promise<void> {
  const out = deps.stdout ?? process.stdout;
  const result = await deps.client.postDevRun(options.featureId);
  out.write(
    `Dispatched ${result.featureId}, stage attempt ${result.stageAttemptId}\n`,
  );
  out.write(`Run: adl logs -f ${result.stageAttemptId}\n`);
}
