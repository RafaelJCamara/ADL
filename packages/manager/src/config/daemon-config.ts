import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DaemonConfigSchema, type DaemonConfig } from '@adl/core/config';

/**
 * Owner-only permissions for the config file and its containing directory —
 * this file holds `api.token`, a bearer credential authenticating every
 * control-plane route except `GET /health` (D-19). `writeFile`'s `mode`
 * option only takes effect when the file is *created*, and is masked by the
 * process umask either way, so the write below is followed by an explicit
 * `chmod` — correctness here matters more than brevity, and the result must
 * not depend on the ambient umask. Windows does not honour POSIX mode bits;
 * `chmod`/`mkdir({mode})` are silent no-ops there rather than errors, so
 * this is deliberately not gated by platform — the call is safe to make
 * unconditionally, it simply has no effect on Windows (see
 * `test/config/daemon-config.test.ts` for the platform-gated assertion).
 */
const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

/**
 * File I/O around the extended `DaemonConfigSchema` — nothing more. The
 * schema itself lives in `@adl/core/config` (Task 2's extension in place);
 * this module never declares a `z.strictObject` of its own, so there is one
 * definition of the daemon config's shape, not two that can disagree
 * (03-RESEARCH.md Pitfall 4).
 *
 * ## Why JSON at `.adl/daemon.json`, not YAML
 *
 * `03-CONTEXT.md` D-36 describes the daemon config as sharing `adl.yml`'s
 * YAML format and parser. That was superseded by the human maintainer's
 * checkpoint decision in `03-04` (control-plane auth, option-b): the daemon
 * itself is this file's *first writer* — it mints `api.token` with
 * `crypto.randomBytes(32)` on first run so that a fresh install is
 * zero-config — and `@adl/cli` (`packages/cli/src/index.ts`) already reads
 * `.adl/daemon.json` as JSON. This module keeps that path and format rather
 * than relocating the file or changing how the token is provisioned, per the
 * locked decision: a generated secret is a natural fit for a
 * machine-written JSON file, and a second, YAML-flavoured config file next
 * to it would fork the "where do I look" answer for an operator.
 *
 * Both `loadDaemonConfig` (read-only) and `ensureDaemonConfig` (read, or
 * mint-and-write on first run) validate through the *same* `DaemonConfigSchema`
 * `@adl/core/config` exports — re-exported below, not redeclared, so a test
 * can prove there is exactly one schema.
 */

export const DEFAULT_DAEMON_CONFIG_PATH = '.adl/daemon.json';

/** `explicitPath` wins (e.g. the CLI's `--config` flag); otherwise the default. */
export function resolveDaemonConfigPath(explicitPath?: string): string {
  return explicitPath ?? DEFAULT_DAEMON_CONFIG_PATH;
}

export interface DaemonConfigLoaded {
  readonly kind: 'loaded';
  readonly path: string;
  readonly config: DaemonConfig;
}

/** A distinguishable "the file does not exist" result — never a caught generic error. */
export interface DaemonConfigNotFound {
  readonly kind: 'not-found';
  readonly path: string;
}

/** Malformed JSON, or JSON that fails `DaemonConfigSchema` validation. */
export interface DaemonConfigInvalid {
  readonly kind: 'invalid';
  readonly path: string;
  /** A human-readable message — the JSON parser's own message, or every offending field path. */
  readonly message: string;
  /** Present when validation (not parsing) failed — one entry per Zod issue. */
  readonly issues?: readonly {
    readonly path: string;
    readonly message: string;
  }[];
}

export type DaemonConfigLoadResult =
  DaemonConfigLoaded | DaemonConfigNotFound | DaemonConfigInvalid;

/** Thrown by a caller that wants `invalid`/`not-found` to be exceptional rather than a variant to switch on. */
export class DaemonConfigError extends Error {
  readonly result: DaemonConfigNotFound | DaemonConfigInvalid;

  constructor(result: DaemonConfigNotFound | DaemonConfigInvalid) {
    super(
      result.kind === 'not-found'
        ? `no daemon config at ${result.path}`
        : `invalid daemon config at ${result.path}: ${result.message}`,
    );
    this.name = 'DaemonConfigError';
    this.result = result;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** Renders a Zod issue as `path: message`, or bare `message` at the root — mirrors `adl-yml.ts`'s `formatIssue`. */
function formatIssue(issue: { path: PropertyKey[]; message: string }): {
  path: string;
  message: string;
} {
  return { path: issue.path.join('.'), message: issue.message };
}

/**
 * Read and validate the daemon config file. Never throws: a missing file is
 * the `not-found` variant, malformed JSON or a schema violation is the
 * `invalid` variant carrying every offending field (or the JSON parser's own
 * message), and a caller that wants an exception instead constructs a
 * {@link DaemonConfigError} from the result itself.
 */
export async function loadDaemonConfig(
  path: string,
): Promise<DaemonConfigLoadResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return { kind: 'not-found', path };
    return {
      kind: 'invalid',
      path,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      kind: 'invalid',
      path,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const result = DaemonConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(formatIssue);
    return {
      kind: 'invalid',
      path,
      message: issues
        .map((issue) =>
          issue.path ? `${issue.path}: ${issue.message}` : issue.message,
        )
        .join('; '),
      issues,
    };
  }

  return { kind: 'loaded', path, config: result.data };
}

/** Mint a fresh bearer token — 32 random bytes, hex-encoded. Never logged; the caller is responsible for pino redaction (T-3-04). */
export function mintApiToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Zero-config first run: if `path` does not exist yet, mint a bearer token
 * and write a minimal daemon config there, then return it loaded — an
 * operator never has to pre-supply a token. If `path` already exists, this
 * is a pass-through to {@link loadDaemonConfig}: an existing file's token is
 * **never** regenerated, and every other configured value is preserved.
 */
export async function ensureDaemonConfig(
  path: string,
): Promise<DaemonConfigLoaded | DaemonConfigInvalid> {
  const first = await loadDaemonConfig(path);
  if (first.kind !== 'not-found') return first;

  const seed = { api: { token: mintApiToken() } };
  await mkdir(dirname(path), { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  await writeFile(path, `${JSON.stringify(seed, null, 2)}\n`, {
    encoding: 'utf8',
    mode: OWNER_ONLY_FILE_MODE,
  });
  // `mode` above only applies at file-creation time and is masked by the
  // process umask — an explicit chmod makes the permission the actual
  // result rather than a best-effort request (T-3-04).
  await chmod(path, OWNER_ONLY_FILE_MODE);

  const second = await loadDaemonConfig(path);
  if (second.kind === 'loaded') return second;
  // Structurally shouldn't happen — the file we just wrote is well-formed
  // JSON that parses against the schema's own defaults — but a real error
  // here (e.g. the file vanished between write and read) is surfaced rather
  // than silently dropped.
  return second.kind === 'invalid'
    ? second
    : {
        kind: 'invalid',
        path,
        message:
          'the daemon config file disappeared immediately after being written',
      };
}

/**
 * The schema this module validates against — re-exported (not redeclared)
 * so a test can prove reference identity with `@adl/core/config`'s own
 * export: this module declares no `z.strictObject` of its own.
 */
export { DaemonConfigSchema };
