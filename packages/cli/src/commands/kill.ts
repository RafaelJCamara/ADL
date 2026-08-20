import {
  confirmBlastRadius,
  resolveScope,
  type ScopeOptions,
} from '../confirm.js';
import type { ControlResult, DaemonClient } from '../http-client.js';
import type { WriteSink } from './status.js';

/**
 * `adl kill` — stop the worker, land the feature in `paused`, never
 * `escalated` (D-27..29). `--all` is the widest blast radius the CLI can
 * express — it can stop every in-flight run on the host — which is exactly
 * why it is the one scope D-29 gates behind interactive confirmation (or
 * `--yes` for scripts) rather than acting on sight.
 */

export interface KillCommandOptions extends ScopeOptions {
  readonly yes?: boolean;
}

export interface KillCommandDeps {
  readonly client: DaemonClient;
  readonly stdout?: WriteSink;
  /** Injected so a test can drive both the interactive and non-interactive branches without a real TTY. */
  readonly isInteractive?: () => boolean;
  readonly confirmInput?: NodeJS.ReadableStream;
  readonly confirmOutput?: NodeJS.WritableStream;
}

export async function killCommand(
  options: KillCommandOptions,
  deps: KillCommandDeps,
): Promise<void> {
  const resolved = resolveScope(options);
  const out = deps.stdout ?? process.stdout;

  if (resolved.scope === 'all') {
    const proceed = await confirmBlastRadius(
      'This will stop every in-flight feature on this host.',
      {
        yes: options.yes,
        isInteractive: deps.isInteractive,
        input: deps.confirmInput,
        output: deps.confirmOutput,
      },
    );
    if (!proceed) return;
  }

  const result: ControlResult =
    resolved.scope === 'feature'
      ? await deps.client.postFeatureControl(resolved.featureId!, 'kill')
      : await deps.client.postControl('kill', resolved.scope, resolved.repoId);

  out.write(`Killed: ${result.affected.join(', ') || '(none)'}\n`);
}
