import {
  confirmBlastRadius,
  resolveScope,
  type ScopeOptions,
} from '../confirm.js';
import type { ControlResult, DaemonClient } from '../http-client.js';
import type { WriteSink } from './status.js';

/**
 * `adl pause` — a brake on new work, never a kill (D-26). Same three scopes
 * and the same D-29 confirmation rule `resume.ts`/`kill.ts` use: only
 * `--all` prompts (or refuses outright in a non-interactive context without
 * `--yes`) — a single feature or a named repository are narrow enough that
 * D-29's "explicit flags for wider blast radii" reading does not reach them.
 */

export interface PauseCommandOptions extends ScopeOptions {
  readonly yes?: boolean;
}

export interface PauseCommandDeps {
  readonly client: DaemonClient;
  readonly stdout?: WriteSink;
  /** Injected so a test can drive both the interactive and non-interactive branches without a real TTY. */
  readonly isInteractive?: () => boolean;
  readonly confirmInput?: NodeJS.ReadableStream;
  readonly confirmOutput?: NodeJS.WritableStream;
}

export async function pauseCommand(
  options: PauseCommandOptions,
  deps: PauseCommandDeps,
): Promise<void> {
  const resolved = resolveScope(options);
  const out = deps.stdout ?? process.stdout;

  if (resolved.scope === 'all') {
    const proceed = await confirmBlastRadius(
      'This will pause dispatch for every repository.',
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
      ? await deps.client.postFeatureControl(resolved.featureId!, 'pause')
      : await deps.client.postControl('pause', resolved.scope, resolved.repoId);

  out.write(`Paused: ${result.affected.join(', ') || '(none)'}\n`);
}
