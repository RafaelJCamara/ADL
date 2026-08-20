/**
 * `writePromptArtifact` / `promptArtifactPathFor` — the rendered prompt,
 * persisted beside its transcript, for every stage attempt (`ARCHITECTURE.md`
 * §4, `04-09-PLAN.md` Task 2).
 *
 * ── The location ─────────────────────────────────────────────────────────
 *
 * A sibling of the transcript, addressed by the SAME resolved attempt
 * address, differing only in extension. `04-RESEARCH.md`'s Open Question 2
 * recommends this over introducing an `artifacts` table, and the reasoning
 * holds: `stage_attempts.error_raw_ref` already establishes the
 * artifact-pointer-not-a-blob convention, `DEFERRED_TABLES`
 * (`packages/db/src/schema.ts`) records the `artifacts` table as
 * deliberately absent, and a future content-addressed table can be
 * introduced without breaking this file-based convention — whereas adding
 * schema surface now is scope this phase's success criteria do not require.
 *
 * `promptArtifactPathFor` composes on {@link transcriptPathFor} rather than
 * reimplementing any of its validation or containment guard: a hostile
 * address component is refused by `transcriptPathFor`'s own
 * `TranscriptAddressError` before this module ever sees a path to derive
 * from. A change to the transcript layout moves both files together, by
 * construction, because there is only one place that layout is decided.
 *
 * ── The write ────────────────────────────────────────────────────────────
 *
 * One file per attempt, carrying both the system prompt and the
 * instructions as a single JSON object — a stable, parseable separation a
 * reader (or a test) can rely on without agreeing with the writer on a
 * delimiter that might appear inside either string.
 *
 * An identical rewrite for the same attempt is a harmless retry and a no-op,
 * following `ScratchHomeTeardown`'s already-established idempotency
 * discipline. A rewrite with DIFFERENT content is a named refusal, never a
 * silent overwrite: the artifact records what was actually sent to the
 * agent, and an overwrite would make the record disagree with history while
 * looking perfectly consistent.
 *
 * ── The call site's obligation (enforced in `worker-entry/stage-runner.ts`,
 * not here) ──────────────────────────────────────────────────────────────
 *
 * The artifact must be written BEFORE the agent is launched, and a write
 * failure must fail the attempt rather than being swallowed — an attempt
 * that ran without recording its prompt is unauditable in exactly the way
 * this file exists to prevent. This is the opposite of the scratch home's
 * owner marker, whose failure costs one uncollectable directory: here, the
 * comparison `04-09` Task 3 builds is only possible because this file
 * exists, so this module's own write failing must be loud.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  transcriptPathFor,
  TRANSCRIPT_EXTENSION,
  type TranscriptAddress,
} from '../store/transcript-path.js';

/**
 * The extension a prompt artifact carries — a sibling of
 * `TRANSCRIPT_EXTENSION`, differing from it alone (same directory, same
 * stem: `<attempt>`).
 */
export const PROMPT_ARTIFACT_EXTENSION = '.prompt';

/** What one attempt's prompt artifact holds. */
export interface PromptArtifactContent {
  readonly systemPrompt: string;
  readonly instructions: string;
}

/**
 * Thrown by {@link writePromptArtifact} when an artifact already exists at
 * the derived path with DIFFERENT content than what is being written now.
 * Never thrown for an identical rewrite — see the module docblock.
 */
export class PromptArtifactConflictError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `a prompt artifact already exists at ${path} with different content — refusing to ` +
        'overwrite the record of what was actually sent to the agent.',
    );
    this.name = 'PromptArtifactConflictError';
    this.path = path;
  }
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * The path one stage attempt's prompt artifact lives at, under `root` — a
 * sibling of `transcriptPathFor(root, address)`, sharing its directory and
 * stem and differing only in extension.
 *
 * Composes on {@link transcriptPathFor} rather than reimplementing its
 * validation and containment guard (see the module docblock): a hostile
 * `address` component surfaces as the exact same {@link TranscriptAddressError}
 * `transcriptPathFor` itself throws.
 */
export function promptArtifactPathFor(
  root: string,
  address: TranscriptAddress,
): string {
  const transcriptPath = transcriptPathFor(root, address);
  return (
    transcriptPath.slice(
      0,
      transcriptPath.length - TRANSCRIPT_EXTENSION.length,
    ) + PROMPT_ARTIFACT_EXTENSION
  );
}

/** A stable, deterministic serialisation — the same content always produces the same bytes. */
function serialise(content: PromptArtifactContent): string {
  return `${JSON.stringify({
    systemPrompt: content.systemPrompt,
    instructions: content.instructions,
  })}\n`;
}

/**
 * Write `rendered` as the prompt artifact for `address`, creating the parent
 * directory chain if needed. Resolves to the artifact's path.
 *
 * - **No existing file:** writes it.
 * - **An existing file with IDENTICAL content:** a no-op (a harmless retry).
 * - **An existing file with DIFFERENT content:** throws
 *   {@link PromptArtifactConflictError} — never silently overwritten.
 */
export async function writePromptArtifact(
  root: string,
  address: TranscriptAddress,
  rendered: PromptArtifactContent,
): Promise<string> {
  const path = promptArtifactPathFor(root, address);
  const serialised = serialise(rendered);

  let existing: string | undefined;
  try {
    existing = await readFile(path, 'utf8');
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }

  if (existing !== undefined) {
    if (existing === serialised) return path;
    throw new PromptArtifactConflictError(path);
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialised, 'utf8');
  return path;
}
