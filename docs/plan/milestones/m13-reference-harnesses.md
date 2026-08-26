# M13 — Reference Harnesses & Third-Party Gates

**Status:** 🔒 Blocked on M12 (dogfood gate)
**Depends on:** M12
**Requirements:** HARN-05, HARN-06 (2)

**Goal:** the extension point is proven real by a working security gate in the box, and by
existing tools becoming gates with configuration alone.

> Highest marketing-to-effort ratio available: it reframes the best-funded competitors as
> plugins, and requires only the plain-command gate contract M07 already shipped.

---

## Done when

- [ ] A security-checking harness ships working, in the box, built on **the same gate
      interface a third party would use** — no privileged access, no special-casing.
- [ ] An existing tool (semgrep, CodeRabbit, or Greptile) is wired in as a gate with
      _configuration rather than code_, and it can send a feature back to the developer.
- [ ] A third-party gate's findings map onto acceptance-criterion IDs, so its output lands
      in the same coverage story as ADL's own gates.

---

## Step sketch

- [ ] **13.1** — The reference security harness, on M07's public interface.
- [ ] **13.2** — Finding → `criterionId` mapping for third-party output.
- [ ] **13.3** — Wire semgrep as a config-only gate.
- [ ] **13.4** — Wire one commercial reviewer (CodeRabbit or Greptile) as a config-only gate.
- [ ] **13.5** — Prove send-back works from a third-party gate.
- [ ] **13.6** — Document the gate contract for external authors.

## Notes

**Ship the _interface_ only.** Registry, discovery, versioning and marketplace are
explicitly out of scope for v1 — they are v2 (`ECO-02`).

ADL does not compete with CodeRabbit, Greptile or semgrep. Those rest on years of
code-graph investment. It _consumes_ them. That is the whole strategic point of the gate
interface, and this milestone is where the claim becomes demonstrable.
