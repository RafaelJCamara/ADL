import * as z from 'zod';

/**
 * The guard every repo-supplied path passes through.
 *
 * A `context.files` entry, a command's `cwd`, a prompt template location, a
 * spec's context refs — each of these is written by anyone who can push to a
 * watched repository, which D-22 records as untrusted input. In Phase 2 they
 * become real filesystem paths. The rejection therefore happens *at schema
 * level*, before the value is ever handed to something that opens a file:
 * 01-RESEARCH.md § Security Domain names this one of the two controls Phase 1
 * owns outright, and a validator that runs next to the `readFile` is a
 * validator somebody eventually forgets to call (threat T-1-02).
 *
 * A repo-relative path may not:
 *
 * - be absolute (`/etc/passwd`)
 * - contain a parent-directory *segment* (`../x`, `a/../../x`, `a\..\x`)
 * - carry a Windows drive-letter prefix (`C:\Windows`, `c:/windows`)
 * - carry a UNC prefix (`\\server\share`)
 * - contain a NUL byte, which truncates the path in a C-level syscall and so
 *   makes the string a program reads different from the path a kernel opens
 * - be empty
 *
 * The constraint is expressed as a *pattern* rather than a `.refine()`, so it
 * survives `z.toJSONSchema()` emission intact (01-RESEARCH.md § Pitfall 1).
 *
 * This module is pure: it validates and normalises path *strings*. It does not
 * read the filesystem and says nothing about whether a path exists — that is
 * Phase 2's question.
 *
 * **Adoption note.** `FindingLocation.path` in the verdict layer is documented
 * as workspace-relative but is currently only `z.string().min(1)`. It should
 * adopt this schema the next time the verdict shapes are touched; the two
 * fields make the same promise and only one of them currently keeps it.
 */

/*
 * Read as four rejections followed by one acceptance:
 *
 *   (?!\/)                      not absolute
 *   (?![A-Za-z]:)               no drive-letter prefix
 *   (?!\\)                      no UNC or rooted-backslash prefix
 *   (?!.*(?:^|[\/\\])\.\.(?:[\/\\]|$))
 *                               no `..` anywhere it is a whole segment
 *   [^\0]+                      at least one character, none of them NUL
 *
 * The fourth is deliberately segment-aware rather than a substring test:
 * `..gitignore` and `a/..build/x` are legal names, and a guard that rejects
 * them teaches people to work around it. Both separators are checked because
 * the value is a *string* here — normalisation to the host separator has not
 * happened yet and must not be assumed.
 *
 * The lookaheads are anchored at position 0 and the trailing quantifier is
 * unambiguous, so matching is linear — no catastrophic backtracking
 * (threat T-1-11).
 */
const REPO_RELATIVE_PATH_PATTERN =
  /^(?!\/)(?![A-Za-z]:)(?!\\)(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[^\0]+$/;

/** A path inside the repository, expressed relative to its root. */
export const RepoRelativePathSchema = z
  .string()
  .regex(REPO_RELATIVE_PATH_PATTERN)
  .meta({
    id: 'RepoRelativePath',
    description:
      'A path relative to the repository root. Absolute paths, `..` segments, drive-letter ' +
      'and UNC prefixes, and NUL bytes are rejected.',
  });

export type RepoRelativePath = z.infer<typeof RepoRelativePathSchema>;

/**
 * Whether a string is a valid repo-relative path.
 *
 * A pure predicate over the string. It reports nothing about existence.
 */
export function isRepoRelativePath(value: string): boolean {
  return REPO_RELATIVE_PATH_PATTERN.test(value);
}
