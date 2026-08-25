import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMENT_BODY_MAX_LENGTH,
  escapeCollapsibleTags,
  renderStickyComment,
  type StickyRound,
} from '../../src/forge/index.js';

/**
 * FORGE-06's renderer (M05 step 5.11).
 *
 * Two properties carry this module, and both are asserted here against the
 * exact defect they exist to catch rather than against a happy path: an
 * agent-authored round body cannot break the fold it is placed in, and the
 * rendered comment cannot outgrow the forge's cap on a body — which would
 * freeze the sticky comment silently at whichever round last fit.
 */

function round(number: number, headline: string, body: string): StickyRound {
  return { number, headline, body };
}

describe('renderStickyComment — structure', () => {
  it('renders a single round expanded, with no fold at all', () => {
    const out = renderStickyComment({
      title: 'Developer',
      rounds: [round(1, 'committed `abc1234`', 'Implemented the toggle.')],
    });

    expect(out).toContain('### Developer');
    expect(out).toContain('**Round 1 — committed `abc1234`**');
    expect(out).toContain('Implemented the toggle.');
    expect(out).not.toContain('<details>');
  });

  it('shows the newest round expanded and folds every earlier one, newest first', () => {
    const out = renderStickyComment({
      title: 'Developer',
      rounds: [
        round(1, 'first', 'round one body'),
        round(2, 'second', 'round two body'),
        round(3, 'third', 'round three body'),
      ],
    });

    expect(out).toContain('**Round 3 — third**');
    // Exactly the two earlier rounds are folded — not three, not one.
    expect(out.match(/<details>/g)).toHaveLength(2);
    expect(out.match(/<\/details>/g)).toHaveLength(2);
    expect(out.indexOf('Round 2 — second')).toBeLessThan(
      out.indexOf('Round 1 — first'),
    );
    // The expanded round precedes both folds.
    expect(out.indexOf('**Round 3 — third**')).toBeLessThan(
      out.indexOf('<details>'),
    );
  });

  it('sorts by round number rather than trusting the caller order', () => {
    const out = renderStickyComment({
      title: 'Developer',
      rounds: [
        round(2, 'second', 'b'),
        round(3, 'third', 'c'),
        round(1, 'first', 'a'),
      ],
    });

    expect(out).toContain('**Round 3 — third**');
    expect(out).not.toContain('**Round 2');
    expect(out).not.toContain('**Round 1');
  });

  it('separates a folded body from its tags with blank lines, so the forge renders it as markdown', () => {
    const out = renderStickyComment({
      title: 'Developer',
      rounds: [round(1, 'first', '- a bullet'), round(2, 'second', 'newest')],
    });

    // The blank lines here are load-bearing: without them a forge renders the
    // body as literal text inside the raw HTML block instead of as markdown.
    expect(out).toContain(
      '<details>\n<summary>Round 1 — first</summary>\n\n- a bullet\n\n</details>',
    );
  });

  it('renders a round with no headline without a dangling separator', () => {
    const out = renderStickyComment({
      title: 'Developer',
      rounds: [round(1, '', 'older'), round(2, '   ', 'newest')],
    });

    expect(out).toContain('**Round 2**');
    expect(out).not.toContain('Round 2 — ');
    expect(out).toContain('<summary>Round 1</summary>');
  });

  it('says so explicitly rather than rendering an empty body when a role has no rounds', () => {
    const out = renderStickyComment({ title: 'Reviewer', rounds: [] });

    expect(out).toContain('### Reviewer');
    expect(out).toContain('No rounds have run for this role yet.');
  });
});

describe('renderStickyComment — a round body cannot break its own fold', () => {
  it('escapes a closing </details> in a folded body, which would otherwise spill every earlier round into view', () => {
    const out = renderStickyComment({
      title: 'Developer',
      rounds: [
        round(1, 'first', 'I removed the </details> tag from the footer.'),
        round(2, 'second', 'newest'),
      ],
    });

    expect(out).toContain('&lt;/details>');
    // Exactly one real closing tag: the fold's own.
    expect(out.match(/(?<!&lt;)<\/details>/g)).toHaveLength(1);
  });

  it('escapes an opening <details> in the EXPANDED body, which would otherwise swallow every fold after it', () => {
    const out = renderStickyComment({
      title: 'Developer',
      rounds: [
        round(1, 'first', 'older'),
        round(2, 'second', 'Added a <details> block to the README.'),
      ],
    });

    // One opening tag survives — the fold's — and the prose one is neutralised.
    expect(out).toContain('&lt;details>');
    expect(out.match(/(?<!&lt;)<details>/g)).toHaveLength(1);
  });

  it('leaves </details> alone inside a fenced code block, where a forge already escapes it', () => {
    const body = [
      'Here is the markup:',
      '',
      '```html',
      '<details>x</details>',
      '```',
    ].join('\n');
    const out = renderStickyComment({
      title: 'Developer',
      rounds: [round(1, 'first', body), round(2, 'second', 'newest')],
    });

    expect(out).toContain('<details>x</details>');
    expect(out).not.toContain('&lt;details>x');
  });

  it('leaves </details> alone inside an inline code span', () => {
    const out = renderStickyComment({
      title: 'Developer',
      rounds: [
        round(1, 'first', 'The `</details>` tag closes it.'),
        round(2, 'second', 'newest'),
      ],
    });

    expect(out).toContain('`</details>`');
    expect(out).not.toContain('&lt;/details>`');
  });

  it('leaves </details> alone inside an indented code block', () => {
    const out = renderStickyComment({
      title: 'Developer',
      rounds: [
        round(1, 'first', 'Example:\n\n    </details>\n'),
        round(2, 'second', 'newest'),
      ],
    });

    expect(out).toContain('    </details>');
  });

  it('escapes a </details> in a blockquote, which a forge treats as real HTML', () => {
    const out = renderStickyComment({
      title: 'Developer',
      rounds: [
        round(1, 'first', '> the agent wrote </details> here'),
        round(2, 'second', 'newest'),
      ],
    });

    expect(out).toContain('&lt;/details>');
  });

  it('does not touch other HTML — only the two tags that can break the fold', () => {
    const out = renderStickyComment({
      title: 'Developer',
      rounds: [round(1, 'first', 'A <b>bold</b> <summary> claim.')],
    });

    expect(out).toContain('<b>bold</b>');
    expect(out).toContain('<summary> claim.');
  });

  it('escapes markup and collapses newlines in a headline, which is an HTML context', () => {
    const out = renderStickyComment({
      title: 'Developer',
      rounds: [
        round(1, 'a < b\nand </details>', 'older'),
        round(2, 'newest', 'newest'),
      ],
    });

    expect(out).toContain(
      '<summary>Round 1 — a &lt; b and &lt;/details&gt;</summary>',
    );
  });
});

describe('escapeCollapsibleTags', () => {
  it('is case-insensitive, matching HTML tag matching itself', () => {
    expect(escapeCollapsibleTags('</DETAILS> and <Details>')).toBe(
      '&lt;/DETAILS> and &lt;Details>',
    );
  });

  it('leaves a word merely starting with "details" alone', () => {
    expect(escapeCollapsibleTags('see <detailsheet>')).toBe(
      'see <detailsheet>',
    );
  });

  it('returns text with no tags unchanged', () => {
    expect(escapeCollapsibleTags('plain prose')).toBe('plain prose');
  });
});

describe('renderStickyComment — the budget', () => {
  const big = (n: number, size: number): StickyRound =>
    round(n, `round ${String(n)}`, 'x'.repeat(size));

  it('keeps the newest round whole and drops the oldest folds, saying how many went', () => {
    const rounds = [1, 2, 3, 4, 5].map((n) => big(n, 400));
    const out = renderStickyComment({
      title: 'Developer',
      rounds,
      maxLength: 1_200,
    });

    expect(out.length).toBeLessThanOrEqual(1_200);
    // The newest round survives in full — it is what a human opened the pull
    // request to read.
    expect(out).toContain('**Round 5 — round 5**');
    expect(out).toContain('x'.repeat(400));
    expect(out).toMatch(/\d earlier rounds omitted/);
    // Folds are kept newest-first: round 4 before round 1 is ever considered.
    expect(out).not.toContain('<summary>Round 1');
  });

  it('never drops a newer fold while keeping an older one', () => {
    const rounds = [1, 2, 3, 4].map((n) => big(n, 300));
    const out = renderStickyComment({
      title: 'Developer',
      rounds,
      maxLength: 900,
    });

    const positions = [3, 2, 1].map((n) =>
      out.indexOf(`<summary>Round ${String(n)}`),
    );
    // Once one fold is absent, every older one is absent too — no gaps, which
    // would misrepresent the round history.
    const firstMissing = positions.findIndex((p) => p === -1);
    if (firstMissing !== -1) {
      expect(positions.slice(firstMissing).every((p) => p === -1)).toBe(true);
    }
  });

  it('truncates visibly when the newest round alone exceeds the budget', () => {
    const out = renderStickyComment({
      title: 'Developer',
      rounds: [big(1, 100), big(2, 5_000)],
      maxLength: 800,
    });

    expect(out.length).toBeLessThanOrEqual(800);
    expect(out).toContain(
      'truncated: this round exceeded the comment size budget',
    );
  });

  it('states the omitted count exactly', () => {
    const rounds = [1, 2, 3, 4, 5, 6].map((n) => big(n, 500));
    const out = renderStickyComment({
      title: 'Developer',
      rounds,
      maxLength: 1_400,
    });

    const stated = /(\d+) earlier rounds? omitted/.exec(out);
    expect(stated).not.toBeNull();
    const folded = (out.match(/<summary>Round /g) ?? []).length;
    // 6 rounds: 1 expanded + folded + omitted must account for all of them.
    expect(Number(stated?.[1]) + folded + 1).toBe(6);
  });

  it('never exceeds maxLength, for any budget down to a single character', () => {
    const rounds = [1, 2, 3, 4].map((n) => big(n, 2_000));
    for (const maxLength of [1, 5, 20, 60, 137, 500, 2_000, 9_999]) {
      const out = renderStickyComment({
        title: 'Developer',
        rounds,
        maxLength,
      });
      expect(out.length).toBeLessThanOrEqual(maxLength);
    }
  });

  it('never splits a surrogate pair when it truncates', () => {
    // A body of astral-plane characters: every truncation point is a potential
    // lone surrogate, which is not encodable as UTF-8 and reaches a forge as
    // U+FFFD.
    const rounds = [round(1, 'emoji', '😀'.repeat(2_000))];
    for (let maxLength = 30; maxLength < 90; maxLength += 1) {
      const out = renderStickyComment({
        title: 'D',
        rounds,
        maxLength,
      });
      expect(out.length).toBeLessThanOrEqual(maxLength);
      // A lone surrogate would survive this round trip as U+FFFD.
      expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
    }
  });

  it('applies the documented default when no budget is given', () => {
    const out = renderStickyComment({
      title: 'Developer',
      rounds: [
        round(1, 'huge', 'y'.repeat(DEFAULT_COMMENT_BODY_MAX_LENGTH * 2)),
      ],
    });

    expect(out.length).toBeLessThanOrEqual(DEFAULT_COMMENT_BODY_MAX_LENGTH);
    expect(DEFAULT_COMMENT_BODY_MAX_LENGTH).toBeLessThan(65_536);
  });
});
