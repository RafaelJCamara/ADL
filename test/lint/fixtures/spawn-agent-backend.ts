// This file EXISTS to be reported by `adl/no-direct-spawn` and must never be
// "fixed". `04-01-PLAN.md`'s § "The spawn-ban assertion" (04-RESEARCH.md
// Pitfall 5) asks the planner to VERIFY, not assume, that adding
// `packages/agent-claude-code` does not require widening the spawn-ban
// exemption (`WORKSPACE_EXEMPTION` in `eslint.config.js`, which is scoped to
// `packages/workspace/**` only). This fixture is that verification: a
// deliberate direct `execa` import shaped like the mistake an agent-adapter
// author would make if they shelled out to `claude` themselves instead of
// going through the `Workspace` instance a caller passes in. It proves the
// ban reaches a new package outside `packages/workspace` exactly the way it
// reaches every existing one, and `test/lint/no-restricted-imports.test.ts`
// is what turns "reaches" into a measured, resolved-config assertion rather
// than a read of this file's imports.
import { execa } from 'execa';

export async function directlySpawnClaude(): Promise<void> {
  await execa('claude', ['--version']);
}
