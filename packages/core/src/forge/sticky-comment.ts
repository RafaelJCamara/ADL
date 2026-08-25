/**
 * `renderStickyComment` — one role's sticky change-request comment (FORGE-06,
 * M05 step 5.11).
 *
 * `ForgeAdapter.upsertComment` already answers *where* a role's comment goes
 * (find the prior one by its hidden marker, edit it in place). This module
 * answers *what is in it*: one heading for the role, the newest round shown
 * expanded, and every earlier round folded into a `<details>` block, newest
 * first. Four gates over five rounds is twenty comments if the two halves are
 * gotten wrong — the AI-slop pattern maintainers are revolting against, and
 * the exact shape a forge's own secondary rate limiter penalises.
 *
 * **Pure, and deliberately in `@adl/core` rather than in a forge adapter.**
 * `<details>`/`<summary>` is not a GitHub feature — it is HTML, rendered by
 * GitHub, GitLab and Gitea alike — so every adapter would otherwise reimplement
 * this, and the three would drift. An out-of-tree forge adapter gets the same
 * rendering by calling the same function. Nothing here does I/O, and the
 * output is a plain string an adapter hands to `upsertComment` verbatim.
 *
 * **The marker is not this module's business.** `upsertComment`'s
 * implementation prepends its own hidden find-or-create marker
 * (`@adl/forge-github`'s `<!-- adl:role=… -->`); rendering one here too would
 * give two writers of the same fact. {@link DEFAULT_COMMENT_BODY_MAX_LENGTH}
 * leaves room for it — see that constant.
 *
 * Two failure modes drive nearly all of the code below, and both are reachable
 * with ordinary agent output rather than a malicious one:
 *
 * 1. **A round body can break the container it is folded into.** Round bodies
 *    are agent-authored prose. A literal `</details>` in one closes the block
 *    early and spills every prior round into the visible area — precisely the
 *    unreadable pull request FORGE-06 exists to prevent. {@link escapeCollapsibleTags}
 *    neutralises the two tag spellings that can do it, and *only* outside code
 *    spans, where a forge's own renderer already escapes them.
 * 2. **A comment edited in place forever grows without bound.** Every forge
 *    caps a comment body; past the cap, `upsertComment` starts failing and the
 *    sticky comment silently freezes at whichever round last fit. The
 *    `maxLength` budget below makes that bounded and *visible* instead: the
 *    newest round is always kept whole, older ones are dropped oldest-first,
 *    and the drop is stated in the comment rather than inferred from a gap.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';

/** One round's contribution to a role's sticky comment. */
export interface StickyRound {
  /** The round's 1-based ordinal — `rounds.number`. */
  readonly number: number;
  /**
   * A one-line gist, shown in the `<summary>` of a collapsed round and beside
   * the round number of the expanded one. Newlines are collapsed and HTML is
   * escaped before it reaches either — a `<summary>` is an HTML context, not
   * a markdown one, so raw markup there breaks the fold rather than styling it.
   */
  readonly headline: string;
  /** The round's markdown. Agent-authored, and treated as such — see the module docblock. */
  readonly body: string;
}

export interface StickyCommentInput {
  /** The role's human-facing heading — `'Developer'`, `'Reviewer'`, a harness's name. */
  readonly title: string;
  /**
   * Every round this role has produced, in any order — {@link renderStickyComment}
   * sorts by {@link StickyRound.number} itself rather than trusting the
   * caller's, because "which round is the newest" decides what a human sees
   * first and a caller's `ORDER BY` is too easy to lose in a refactor.
   */
  readonly rounds: readonly StickyRound[];
  /** Defaults to {@link DEFAULT_COMMENT_BODY_MAX_LENGTH}. */
  readonly maxLength?: number;
}

/**
 * The default ceiling on a rendered comment body, in UTF-16 code units.
 *
 * GitHub's documented cap on an issue-comment body is 65,536 characters; past
 * it the API answers 422 rather than truncating. This default sits deliberately
 * below that for two reasons that are cheaper to pay for than to discover in
 * production: an adapter prepends its own hidden marker (`@adl/forge-github`'s
 * `<!-- adl:role=… -->`) to whatever this function returns, so the string that
 * reaches the API is longer than the string measured here; and a forge whose
 * cap is lower than GitHub's would otherwise need every caller to know a second
 * number. A caller that knows its forge's exact limit passes
 * {@link StickyCommentInput.maxLength} instead.
 *
 * **Not verified against the live API** — no live GitHub App credentials exist
 * yet (`docs/plan/DEBT.md` § 1 item 1.7). The value being an *under*-estimate
 * is what makes that safe to defer: the failure mode of guessing too low is a
 * round collapsing earlier than it had to, which the omission notice states
 * out loud.
 */
export const DEFAULT_COMMENT_BODY_MAX_LENGTH = 60_000;

/** Rendered when a role has no rounds at all — never an empty comment body, which reads as a bug. */
const NO_ROUNDS_YET = '_No rounds have run for this role yet._';

const TRUNCATION_NOTICE =
  '\n\n_… truncated: this round exceeded the comment size budget._';

const SEPARATOR = '\n\n';

/**
 * The tag spellings that can break a `<details>` fold: its own open and close.
 *
 * `<summary>` is deliberately *not* here. A stray one renders as a second
 * summary — cosmetic — whereas an unbalanced `<details`/`</details` either
 * closes the fold early (spilling prior rounds into view) or opens one that
 * swallows every block after it. Escaping the minimum that preserves the
 * structure keeps legitimate HTML in agent prose legible.
 */
const COLLAPSIBLE_TAG = /<\/?details\b/gi;

/**
 * The source offsets of every code span and code block in `markdown`.
 *
 * A forge's own renderer escapes HTML inside a code fence, an indented code
 * block, and an inline code span, so `</details>` in any of the three is
 * already inert — escaping it there would turn a correct code sample into a
 * visible `&lt;/details>`. Verified against the installed
 * `mdast-util-from-markdown@2.0.3`, which reports `position.start.offset` /
 * `position.end.offset` for `code` (fenced *and* indented) and `inlineCode`
 * nodes.
 *
 * A parse failure yields no spans, which escapes everything: when the two
 * cannot both be had, the fold's structure is worth more than one code
 * sample's fidelity.
 */
function codeSpans(markdown: string): readonly (readonly [number, number])[] {
  let root: ReturnType<typeof fromMarkdown>;
  try {
    root = fromMarkdown(markdown);
  } catch {
    return [];
  }

  const spans: (readonly [number, number])[] = [];
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const n = node as {
      type?: unknown;
      position?: {
        start?: { offset?: number };
        end?: { offset?: number };
      };
      children?: unknown;
    };
    if (n.type === 'code' || n.type === 'inlineCode') {
      const start = n.position?.start?.offset;
      const end = n.position?.end?.offset;
      if (typeof start === 'number' && typeof end === 'number') {
        spans.push([start, end]);
      }
      // Neither node type has children carrying markup of its own.
      return;
    }
    if (Array.isArray(n.children)) for (const child of n.children) visit(child);
  };
  visit(root);
  return spans;
}

/**
 * Neutralise the `<details>` tags in `markdown` that would break the fold it
 * is about to be placed in, leaving the ones inside code spans alone.
 *
 * `<` becomes `&lt;`, which every forge renders back as a literal `<` — the
 * text a human reads is unchanged; only its power to close an element is.
 *
 * Exported because it is the one piece of this module a caller might need on
 * its own: a role that renders its round bodies into some *other* HTML
 * container needs exactly this treatment and must not hand-roll a second,
 * subtly different version of it.
 */
export function escapeCollapsibleTags(markdown: string): string {
  const spans = codeSpans(markdown);
  const insideCode = (index: number): boolean =>
    spans.some(([start, end]) => index >= start && index < end);

  // A fresh regex per call: `COLLAPSIBLE_TAG` is global, and a shared
  // `lastIndex` across calls is a re-entrancy bug waiting for a second caller.
  const pattern = new RegExp(COLLAPSIBLE_TAG.source, COLLAPSIBLE_TAG.flags);

  let out = '';
  let cursor = 0;
  for (
    let match = pattern.exec(markdown);
    match !== null;
    match = pattern.exec(markdown)
  ) {
    if (insideCode(match.index)) continue;
    out += `${markdown.slice(cursor, match.index)}&lt;${markdown.slice(
      match.index + 1,
      pattern.lastIndex,
    )}`;
    cursor = pattern.lastIndex;
  }
  return out + markdown.slice(cursor);
}

/**
 * One line of HTML-safe text for a `<summary>`.
 *
 * `<summary>` is an HTML context: a newline ends the element's own line and
 * raw `<` opens a tag rather than printing one. Both are escaped rather than
 * stripped, so a headline mentioning `a < b` still reads as `a < b`.
 */
function summaryText(text: string): string {
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();
}

/**
 * Slice without splitting a surrogate pair.
 *
 * A lone surrogate is not encodable as UTF-8; it survives `JSON.stringify` as
 * `\uD83D` and reaches the forge as U+FFFD. Cutting one code unit earlier
 * costs a character and keeps the body valid — and the only inputs that reach
 * this path are already being truncated, so a character is not the scarce
 * thing.
 */
function sliceSafely(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  const splitsAPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsAPair ? limit - 1 : limit);
}

function truncateTo(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= TRUNCATION_NOTICE.length) return sliceSafely(text, limit);
  return (
    sliceSafely(text, limit - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE
  );
}

function omissionNotice(count: number): string {
  return `_${String(count)} earlier round${count === 1 ? '' : 's'} omitted — this comment reached its size budget._`;
}

/**
 * The newest round, expanded.
 *
 * Its body is escaped too, even though nothing precedes it to be closed early:
 * an *unclosed* `<details>` here would swallow every collapsed round rendered
 * after it. One rule for every body is also one rule to test.
 */
function expandedBlock(round: StickyRound): string {
  const headline = summaryText(round.headline);
  const heading =
    headline === ''
      ? `**Round ${String(round.number)}**`
      : `**Round ${String(round.number)} — ${headline}**`;
  return `${heading}${SEPARATOR}${escapeCollapsibleTags(round.body).trim()}`;
}

/**
 * An earlier round, folded.
 *
 * The blank lines around the body are load-bearing, not formatting: a forge
 * processes the content of a raw HTML block as markdown only when it is
 * separated from the surrounding tags by a blank line. Without them the body
 * renders as literal text.
 */
function collapsedBlock(round: StickyRound): string {
  const headline = summaryText(round.headline);
  const summary =
    headline === ''
      ? `Round ${String(round.number)}`
      : `Round ${String(round.number)} — ${headline}`;
  return [
    '<details>',
    `<summary>${summary}</summary>`,
    '',
    escapeCollapsibleTags(round.body).trim(),
    '',
    '</details>',
  ].join('\n');
}

/**
 * Render one role's whole sticky comment.
 *
 * **The returned string is never longer than `maxLength`.** That is a
 * structural guarantee rather than a best effort — the final slice below holds
 * for any input and any positive `maxLength`, including one too small for even
 * the heading. It matters because the alternative is a comment that renders
 * once, exceeds the forge's cap on the next round, and then stops updating
 * with nothing on the pull request to say so.
 *
 * What gets dropped when the budget binds, in order:
 *
 * 1. Nothing — everything fits.
 * 2. The oldest collapsed rounds, one at a time, newest kept. The count that
 *    went is stated in the comment.
 * 3. The tail of the newest round's own body, with a truncation notice, if it
 *    alone exceeds the budget.
 *
 * The newest round is never dropped to make room for an older one: it is the
 * one a human opened the pull request to read.
 */
export function renderStickyComment(input: StickyCommentInput): string {
  const maxLength = input.maxLength ?? DEFAULT_COMMENT_BODY_MAX_LENGTH;
  const header = `### ${input.title}`;

  const newestFirst = [...input.rounds].sort((a, b) => b.number - a.number);
  const current = newestFirst[0];
  if (current === undefined) {
    return sliceSafely(`${header}${SEPARATOR}${NO_ROUNDS_YET}`, maxLength);
  }
  const priors = newestFirst.slice(1);

  // Held back from the start so the notice itself can never be the thing that
  // does not fit. Sized for the worst case (every prior round dropped); a
  // notice for fewer is never longer, since it differs only in digits and in
  // the plural `s` that the one-round case does not carry.
  const reserve =
    priors.length > 0
      ? omissionNotice(priors.length).length + SEPARATOR.length
      : 0;
  const budget = maxLength - reserve;

  let body = truncateTo(
    `${header}${SEPARATOR}${expandedBlock(current)}`,
    budget,
  );

  let kept = 0;
  for (const prior of priors) {
    const block = SEPARATOR + collapsedBlock(prior);
    if (body.length + block.length > budget) break;
    body += block;
    kept += 1;
  }

  const omitted = priors.length - kept;
  if (omitted > 0) body += SEPARATOR + omissionNotice(omitted);

  return sliceSafely(body, maxLength);
}
