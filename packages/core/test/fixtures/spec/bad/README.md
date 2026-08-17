# Why there are no bad `.feature` files in this directory

The degenerate Gherkin inputs live **inline in `test/spec/gherkin.test.ts`**, in
the `DEGENERATE_INPUTS` array, not as files here.

That is deliberate. Several of them are empty, whitespace-only, or a single
comment. A file containing nothing is invisible in a diff, survives no editor
that trims trailing whitespace on save, and is exactly the kind of thing a
well-meaning "clean up stray files" commit deletes without anyone noticing the
test that depended on it. Inline string literals cannot be lost that way, and
the reason each one exists sits on the line above it.

Each entry is labelled with the row of `01-RESEARCH.md § Pitfall 2` it
reproduces, and the array's length is asserted, so a case cannot be quietly
dropped.

## The nine inputs, and what each proves

| Row | Input | Parser | Loader must |
| --- | ----- | ------ | ----------- |
| 1 | Empty file | accepts, `doc.feature === undefined` | reject: no feature declared |
| 2 | Whitespace only | accepts, `doc.feature === undefined` | reject: no feature declared |
| 3 | Comment only | accepts, `doc.feature === undefined` | reject: no feature declared |
| 4 | `Feature:` with no scenarios | accepts, `children.length === 0` | reject: zero scenarios |
| 5 | `Scenario:` with no steps | accepts, `steps.length === 0` | reject, naming the scenario |
| 6 | `Scenario Outline` with no `Examples` | accepts | reject, naming the outline |
| 7 | Two `Feature:` blocks | **throws** `CompositeParserException` | surface with line and column |
| 8 | Ragged `Examples` table | **throws** `CompositeParserException` | surface with line and column |
| 9 | Free text at top level | **throws** `CompositeParserException` | surface with line and column |

Rows 1–6 are the dangerous half. The parser reports **success** on every one of
them, so a loader that treats parser success as sufficient lets a feature into
the loop with zero acceptance criteria — and a gate with nothing to check
against cannot fail, so it goes green.

A tenth case sits beside these in the same test file for the same reason: an
orphan step written outside any scenario (`01-RESEARCH.md § Pitfall 3`). It also
parses successfully, and the author's step is discarded with no error anywhere.
It is caught by step-count reconciliation rather than by a structural check.

## One correction to `01-RESEARCH.md § Pitfall 2`

That section's prose splits the nine as "five parse, four throw". The table
directly beneath it, and re-running the parser against
`@cucumber/gherkin@42.0.1` while implementing this loader, both give **six parse,
three throw**. The table is right and the prose is not.

Row 7 also only throws when the two `Feature:` blocks are separated by real
content. `"Feature: A\nFeature: B\n"` on two adjacent lines parses **successfully**
— the second line is absorbed as the first feature's description. The fixture
therefore uses the separated form, which is what an author actually writes.
