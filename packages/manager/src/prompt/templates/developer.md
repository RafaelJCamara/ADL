<!--
  Rendered DETERMINISTICALLY by buildDeveloperPrompt() (packages/manager/src/
  prompt/build.ts): the same feature on the same commit must produce a
  byte-identical rendered prompt every time — that is phase 04's success
  criterion 4, and packages/manager/test/prompt/determinism.test.ts proves it
  across two real, separate processes.

  Do NOT add anything here (or to build.ts) that interpolates a timestamp, a
  random id, an environment value, or a host filesystem path. Any of those
  would make two runs on one commit differ for a reason nobody chose, which
  breaks that success criterion. See build.ts's own module docblock for the
  full list of what the renderer may never touch, and why.
-->

## Feature: {{title}}

{{narrative}}

## Acceptance Criteria

{{acceptanceCriteriaChecklist}}

## Repository Context

{{declaredContextFiles}}

## Raw specification (verbatim)

{{rawSpec}}
