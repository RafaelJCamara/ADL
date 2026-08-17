import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { LoadError } from '../../src/errors.js';
import {
  loadAdlTemplateSpec,
  MAX_SPEC_BYTES,
} from '../../src/spec/markdown.js';

/**
 * The markdown half of the intake surface (SPEC-01, CORE-05).
 *
 * `spine.e2e.test.ts` already proves the happy path end to end; this file
 * covers the refusals and the byte-exactness guarantee those tests only
 * touch once each. Several cases here are inline markdown strings rather than
 * fixture files — a leading frontmatter block or a fenced code block
 * containing a heading-shaped line is a one-line authoring mistake that is
 * more legible sitting next to the assertion it drives than round-tripped
 * through a separate file.
 */
function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/spec/good/${name}`, import.meta.url)),
    'utf8',
  );
}

const SPEC = fixture('spec.md');

describe('loadAdlTemplateSpec — required and optional headings', () => {
  it('parses the headings-only template with every optional section present', () => {
    const spec = loadAdlTemplateSpec(SPEC, 'feature-branch-cleanup');
    expect(spec.title).toBe('Feature Branch Cleanup');
    expect(spec.narrative).toContain('the git worktree');
    expect(spec.nonGoals).toEqual([
      'Reclaiming space inside the git object store.',
      'Any scheduling policy beyond "run on daemon startup and every hour".',
    ]);
    expect(spec.constraints).toHaveLength(1);
    expect(spec.contextRefs).toEqual([
      {
        path: 'docs/workspace-lifecycle.md',
        why: 'the state machine the terminal states come from',
      },
      { path: 'src/workspace/worktree.ts' },
    ]);
  });

  it('accepts a title and a criteria section with every optional heading absent', () => {
    const minimal =
      '# Just a title\n\n## Acceptance Criteria\n\n- The one thing that matters.\n';
    const spec = loadAdlTemplateSpec(minimal, 'minimal');
    expect(spec.title).toBe('Just a title');
    expect(spec.narrative).toBeUndefined();
    expect(spec.nonGoals).toBeUndefined();
    expect(spec.constraints).toBeUndefined();
    expect(spec.contextRefs).toEqual([]);
    expect(spec.acceptanceCriteria).toHaveLength(1);
  });

  it('gives a missing acceptance-criteria heading and an empty one two distinct errors', () => {
    const noHeading = '# T\n\n## Intent\n\nSome prose.\n';
    const emptyHeading =
      '# T\n\n## Acceptance Criteria\n\nJust a paragraph, no list.\n';

    let noHeadingMessage = '';
    try {
      loadAdlTemplateSpec(noHeading, 'x');
    } catch (error) {
      noHeadingMessage = (error as LoadError).message;
    }
    let emptyHeadingMessage = '';
    try {
      loadAdlTemplateSpec(emptyHeading, 'x');
    } catch (error) {
      emptyHeadingMessage = (error as LoadError).message;
    }

    expect(noHeadingMessage).toMatch(/no ".*Acceptance Criteria" heading/);
    expect(emptyHeadingMessage).toMatch(/contains no list items/);
    expect(noHeadingMessage).not.toBe(emptyHeadingMessage);
  });
});

describe('loadAdlTemplateSpec — top-level list items only (D-19)', () => {
  it('keeps a nested bullet inside its parent criterion rather than promoting it', () => {
    const spec = loadAdlTemplateSpec(SPEC, 'feature-branch-cleanup');
    // Three top-level bullets in the fixture; the two nested sub-bullets under
    // the second are detail, not criteria of their own.
    expect(spec.acceptanceCriteria).toHaveLength(3);
    const [, ac2] = spec.acceptanceCriteria;
    expect(ac2?.text).toContain('An expired lease means the worker died');
  });

  it('accepts both bullet and numbered lists, yielding the same criterion count', () => {
    const bulleted =
      '# T\n\n## Acceptance Criteria\n\n- First thing.\n- Second thing.\n- Third thing.\n';
    const numbered =
      '# T\n\n## Acceptance Criteria\n\n1. First thing.\n2. Second thing.\n3. Third thing.\n';

    const fromBullets = loadAdlTemplateSpec(bulleted, 'x');
    const fromNumbers = loadAdlTemplateSpec(numbered, 'x');

    expect(fromBullets.acceptanceCriteria).toHaveLength(3);
    expect(fromNumbers.acceptanceCriteria).toHaveLength(3);
    expect(fromBullets.acceptanceCriteria.map((c) => c.id)).toEqual(
      fromNumbers.acceptanceCriteria.map((c) => c.id),
    );
  });
});

describe('loadAdlTemplateSpec — verbatim retention', () => {
  it('recomputes every criterion text from raw.slice(...) at the recorded offsets', () => {
    const spec = loadAdlTemplateSpec(SPEC, 'feature-branch-cleanup');
    for (const criterion of spec.acceptanceCriteria) {
      expect(SPEC.slice(criterion.source.start, criterion.source.end)).toBe(
        criterion.text,
      );
    }
  });

  it('retains raw byte-identically', () => {
    expect(loadAdlTemplateSpec(SPEC, 'feature-branch-cleanup').raw).toBe(SPEC);
  });
});

describe('loadAdlTemplateSpec — frontmatter and fenced code (D-18)', () => {
  it('rejects a leading frontmatter block rather than absorbing it into the first section', () => {
    const withFrontmatter =
      '---\ntitle: Something\n---\n\n# T\n\n## Acceptance Criteria\n\n- One thing.\n';
    expect(() => loadAdlTemplateSpec(withFrontmatter, 'x')).toThrow(
      /frontmatter/,
    );
  });

  it('does not let a heading-shaped line inside a fenced code block create a section boundary', () => {
    // A criterion mentioning example markdown, with a heading-shaped line
    // fenced inside it. A naive line-scanner would treat "## Acceptance
    // Criteria" here as a second heading and truncate the real section.
    const withFence =
      '# T\n\n## Acceptance Criteria\n\n' +
      '- The docs explain the format:\n\n  ```\n  ## Acceptance Criteria\n  - not a real one\n  ```\n\n' +
      '- A second real criterion.\n';
    const spec = loadAdlTemplateSpec(withFence, 'x');
    expect(spec.acceptanceCriteria).toHaveLength(2);
    expect(spec.acceptanceCriteria[0]?.text).toContain(
      '## Acceptance Criteria',
    );
  });

  it('does not support GFM tables — a table inside a list item is literal pipe text', () => {
    // This parser has no table extension. A table-shaped line inside a
    // criterion arrives and is preserved as literal text with pipe characters,
    // which the verbatim slice keeps correctly. No logic here may assume a
    // `table` mdast node exists; if GFM tables are ever wanted, the extension
    // has to be added deliberately.
    const withTable =
      '# T\n\n## Acceptance Criteria\n\n- A table follows:\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n';
    const spec = loadAdlTemplateSpec(withTable, 'x');
    expect(spec.acceptanceCriteria).toHaveLength(1);
    expect(spec.acceptanceCriteria[0]?.text).toContain('| a | b |');
  });
});

describe('loadAdlTemplateSpec — size cap', () => {
  it('rejects a source above the 1 MB cap before the parser runs', () => {
    const huge =
      '# T\n\n## Acceptance Criteria\n\n- ' +
      'x'.repeat(MAX_SPEC_BYTES + 1_000) +
      '\n';
    expect(() => loadAdlTemplateSpec(huge, 'x')).toThrow(/exceeds/);
  });
});
