---
name: architect-review
description: Run a standalone architectural audit of the whole product (or a named area) — spawns the blank-context `architect` to assess the existing code against SOLID + sound design and report prioritized concerns + remediations. Read-only; builds nothing. Run `/architect-review [area]`.
---

# architect-review · standalone architecture audit

`/architect-review [area]` — a clean-eyed read on the product's architecture as it stands today.
`$ARGUMENTS` = an optional area (omit = whole product). **Read-only: it assesses, it doesn't build.**

## Arc
1. **Scope** — confirm what's under review (whole product, or the named area + its boundaries).
2. **Audit** — spawn the **`architect`** subagent (`subagent_type: architect`, blank context) in
   **product-audit** mode: assess the existing code against SOLID + cohesion/coupling, fit with
   the established patterns, testability, and over-engineering. It verifies against the real codebase.
3. **Report** — relay the architect's findings verbatim-in-substance: genuine **strengths**, then
   **prioritized concerns** (numbered, principle-tagged, each with a concrete remediation).
4. **(Optional) hand off** — high-leverage remediations are natural next moves: run them through
   **`feature`** (a concern needing a designed change) or **`campaign`/`fan-out`** (independent
   fixes). This skill itself **stops at the report** — it never edits code.

## vs the architect gate
Inside `feature`/`campaign` the architect reviews a *proposed* design before building.
`architect-review` points the same lens at the *product as it stands* — a periodic health check,
not a per-change gate.
