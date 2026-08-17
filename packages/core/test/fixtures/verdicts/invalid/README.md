# Invalid verdict fixtures

This directory intentionally holds no JSON files.

The corpus lives as inline arrays inside
`packages/core/test/verdict/json-schema-equivalence.test.ts`, not as loose
files here, so each payload carries a one-line label naming the constraint it
probes — a seventh outcome, an empty `checked` array, a fingerprint of the
wrong length, and so on — and so the corpus cannot silently drift out of sync
with the assertions that consume it.

This directory exists because `.planning/phases/01-core-contracts/01-VALIDATION.md`
§ Wave 0 Requirements names it as part of the expected test-fixture layout. An
empty directory with no explanation rots; this file is that explanation.

See `packages/core/test/verdict/json-schema-equivalence.test.ts` for the
actual corpus.
