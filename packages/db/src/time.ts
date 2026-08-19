/**
 * The one place every lease timestamp is written and validated.
 *
 * `lease_expires_at` and `heartbeat_at` are plain SQLite `TEXT` columns (see
 * `schema.ts`), and the reaper's `lease_expires_at < ?` predicate is a
 * **lexicographic** string comparison. It coincides with chronological order
 * only because every writer uses the same fixed-width, zero-padded,
 * `Z`-suffixed form — `new Date().toISOString()`'s own output. Nothing at the
 * schema level enforces that; a differently-formatted string (a locale
 * timestamp, a form missing the trailing `Z`, a truncated fractional part)
 * would silently break the property. `nowIso` is the sole writer, and
 * `assertIsoTimestamp` is the guard every accepted timestamp parameter runs
 * through, so the format can only drift by editing this file.
 */

/** `YYYY-MM-DDTHH:mm:ss.sssZ` — exactly what `Date.prototype.toISOString` emits. */
export const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The current instant, in the one format every lease timestamp must share. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Throw, naming `field`, if `value` is not in the fixed-width ISO-8601 form
 * `nowIso` produces.
 *
 * Called on every timestamp a lease-scoped repository method accepts as a
 * parameter, so a caller that passes a differently-shaped string fails loudly
 * at the write it corrupted, rather than silently degrading a later reaper
 * tick's `<` comparison into string order that happens to disagree with time.
 */
export function assertIsoTimestamp(value: string, field: string): void {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new Error(
      `${field} must be an ISO-8601 timestamp in the fixed-width ` +
        `"YYYY-MM-DDTHH:mm:ss.sssZ" form produced by nowIso() — got ${JSON.stringify(value)}`,
    );
  }
}
