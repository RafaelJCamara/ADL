import * as z from 'zod';
import { describe, expect, it } from 'vitest';

import { parseYamlDocument } from '../../src/config/yaml-parse.js';
import { LoadError } from '../../src/errors.js';

/**
 * The parser's hardened behaviours, proven by execution.
 *
 * This is deliberately *not* redundant with 01-RESEARCH.md § Security Domain.
 * The research verified that `yaml@2.9.0` is safe by default; this file
 * verifies that ADL's single pinned entry point *still has those properties*
 * after any future edit to its options block. Every one of the six is a
 * library default rather than a guarantee, so a well-meaning `{ merge: true }`
 * added to fix somebody's anchor would silently re-open a hole. That edit now
 * fails here.
 *
 * Threat T-1-10, dispositioned `accept` precisely because these assertions
 * exist.
 */

describe('parseYamlDocument: resource exhaustion', () => {
  /** The classic billion-laughs shape, one order of magnitude per level. */
  const ALIAS_BOMB = [
    'a: &a ["x","x","x","x","x","x","x","x","x"]',
    'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
    'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
    'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
    'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
    'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
    'g: [*f,*f,*f,*f,*f,*f,*f,*f,*f]',
    '',
  ].join('\n');

  it('raises on an alias bomb rather than expanding it', () => {
    expect(() => parseYamlDocument(ALIAS_BOMB)).toThrow(LoadError);
  });

  it('says what happened, in words the person who wrote the file can act on', () => {
    expect(() => parseYamlDocument(ALIAS_BOMB)).toThrow(/alias/i);
  });

  it('raises quickly — the bomb is refused, not evaluated', () => {
    const started = Date.now();
    expect(() => parseYamlDocument(ALIAS_BOMB)).toThrow(LoadError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('parseYamlDocument: ambiguity', () => {
  it('raises on a duplicate mapping key instead of silently taking the last one', () => {
    // Last-wins is how a maintainer ends up with a setting they believe is in
    // effect and is not — the exact class of quiet wrongness this file format
    // is designed against.
    expect(() => parseYamlDocument('version: 1\nversion: 2\n')).toThrow(
      LoadError,
    );
    expect(() => parseYamlDocument('version: 1\nversion: 2\n')).toThrow(
      /unique|duplicate/i,
    );
  });

  it('raises on a source containing more than one document', () => {
    expect(() => parseYamlDocument('version: 1\n---\nversion: 2\n')).toThrow(
      LoadError,
    );
    expect(() => parseYamlDocument('version: 1\n---\nversion: 2\n')).toThrow(
      /document/i,
    );
  });
});

describe('parseYamlDocument: deserialization', () => {
  const PAYLOAD =
    "a: !!js/function 'function(){ globalThis.__adlPwned = true }'\n";

  it('resolves an inert function-like tag to a plain string', () => {
    const value = parseYamlDocument(PAYLOAD) as { a: unknown };
    expect(typeof value.a).toBe('string');
    expect(value.a).toBe('function(){ globalThis.__adlPwned = true }');
  });

  it('executes nothing while doing so', () => {
    expect(
      (globalThis as Record<string, unknown>)['__adlPwned'],
    ).toBeUndefined();
    parseYamlDocument(PAYLOAD);
    expect(
      (globalThis as Record<string, unknown>)['__adlPwned'],
    ).toBeUndefined();
  });

  it('treats a merge key as a literal key rather than merging', () => {
    const value = parseYamlDocument(
      'base: &b { x: 1 }\nchild:\n  <<: *b\n  y: 2\n',
    ) as {
      child: Record<string, unknown>;
    };
    // `<<` survives as an ordinary key. It is then an unrecognised key to
    // every strict schema in this package, which is what makes merge-key
    // abuse a loud config error rather than a silent injection of fields.
    expect(Object.keys(value.child).sort()).toEqual(['<<', 'y']);
    expect(value.child['x']).toBeUndefined();
  });
});

describe('parseYamlDocument: prototype pollution', () => {
  const PAYLOAD = '__proto__:\n  polluted: yes\nversion: 1\n';

  it('leaves the global object prototype unchanged', () => {
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    parseYamlDocument(PAYLOAD);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('leaves the polluting key absent from the validated output object', () => {
    // Two halves, because they fail independently: the parser must not
    // pollute, *and* the schema must not carry the key through. A schema
    // using `.passthrough()` or `.catchall()` would pass the first and fail
    // the second.
    const raw = parseYamlDocument(PAYLOAD);
    const validated = z.strictObject({ version: z.literal(1) }).parse(raw);
    expect(Reflect.ownKeys(validated)).toEqual(['version']);
    expect(Object.prototype.hasOwnProperty.call(validated, '__proto__')).toBe(
      false,
    );
  });
});

describe('parseYamlDocument: error positions', () => {
  it('raises a LoadError carrying a line and a column on a syntactically invalid source', () => {
    // C-8: the parse goes through the document-level API precisely so that
    // this position exists. "Invalid YAML" without a position is a support
    // ticket, and these errors are shown to users.
    let caught: unknown;
    try {
      parseYamlDocument('commands:\n  build: [npm, ci\n  test: [npm, test]\n');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LoadError);
    const position = (caught as LoadError).position;
    expect(position).toBeDefined();
    expect(position?.line).toBeGreaterThanOrEqual(1);
    expect(position?.column).toBeGreaterThanOrEqual(1);
  });

  it('carries a position on a duplicate key too', () => {
    let caught: unknown;
    try {
      parseYamlDocument('version: 1\nversion: 2\n');
    } catch (error) {
      caught = error;
    }
    expect((caught as LoadError).position?.line).toBe(2);
  });
});

describe('parseYamlDocument: ordinary sources still work', () => {
  it('parses a well-formed document to plain JavaScript values', () => {
    const value = parseYamlDocument(
      'version: 1\nfeatures_dir: features\npipeline: [develop]\n',
    );
    expect(value).toEqual({
      version: 1,
      features_dir: 'features',
      pipeline: ['develop'],
    });
  });

  it('parses an empty source to null rather than throwing', () => {
    // An empty `adl.yml` is a *schema* error naming the missing keys, not a
    // parse error. Keeping the two apart is what makes the message useful.
    expect(parseYamlDocument('')).toBeNull();
  });
});
