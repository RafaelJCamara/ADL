import {
  confirmBlastRadius,
  resolveScope,
  type ScopeOptions,
} from '../confirm.js';
import type { ControlResult, DaemonClient } from '../http-client.js';
import type { WriteSink } from './status.js';

/**
 * `adl resume` — lifts `adl pause`'s brake (D-26). Same three scopes and the
 * same D-29 confirmation rule as `pause.ts`/`kill.ts`.
 */

export interface ResumeCommandOptions extends ScopeOptions {
  readonly yes?: boolean;
}

export interface ResumeCommandDeps {
  readonly client: DaemonClient;
  readonly stdout?: WriteSink;
  /** Injected so a test can drive both the interactive and non-interactive branches without a real TTY. */
  readonly isInteractive?: () => boolean;
  readonly confirmInput?: NodeJS.ReadableStream;
  readonly confirmOutput?: NodeJS.WritableStream;
}

export async function resumeCommand(
  options: ResumeCommandOptions,
  deps: ResumeCommandDeps,
): Promise<void> {
  const resolved = resolveScope(options);
  const out = deps.stdout ?? process.stdout;

  if (resolved.scope === 'all') {
    const proceed = await confirmBlastRadius(
      'This will resume dispatch for every repository.',
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
      ? await deps.client.postFeatureControl(resolved.featureId!, 'resume')
      : await deps.client.postControl(
          'resume',
          resolved.scope,
          resolved.repoId,
        );

  out.write(`Resumed: ${result.affected.join(', ') || '(none)'}\n`);
}
