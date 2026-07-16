---
name: feature
description: Master conductor for a stated feature request — interrogates the author until the feature is fully specified, gets an architect (SOLID) design review, then breaks it into PR-sized work and runs the build cycle. Run `/feature <request>`. Like `campaign`, but author-driven instead of survey-driven.
---

# feature · the feature conductor

`/feature <request>`. Turn an author's feature request into shipped, reviewed PRs — but only
*after* you actually understand the feature and its shape is architecturally sound. `$ARGUMENTS`
= the feature request. A **thin conductor**; its special jobs are the **clarification loop** and
the **architect gate**.

## Arc
1. **Capture** — restate the request as you understand it, so the author can correct you early.
2. **Clarify (loop with the author)** — ask focused questions until the full picture is clear:
   scope & **non-goals**, behavior, inputs/outputs, constraints, edge cases, **acceptance
   criteria**, and how it fits the existing system. Use `AskUserQuestion` rounds; **stop asking
   when nothing material is unresolved** (don't interrogate past the point of value). Then
   **summarize the agreed spec** back to the author.
3. **Design** — draft the **simplest** concrete approach that satisfies the spec: the
   components/changes, where they live, the key abstractions, how it integrates with existing
   seams.
4. **Architect gate (SOLID)** — spawn the **`architect`** subagent (`subagent_type: architect`,
   blank context) with the design + spec → **SOUND / CONCERNS**. On CONCERNS, revise the design
   and re-review (≤ 2–3 rounds; a stuck design loop → **`referee`**). The architect guards both
   soundness **and** over-engineering — take "too complex" as seriously as "too rigid".
5. **Break down & build** — split the sound design into **PR-sized work items**; run **`fan-out`**
   → **`propose-review`** per item (`proposer → plan-reviewer → implementer + test-author →
   code-reviewer → PR`), with **`referee`** on deadlock. Flag items that can't run in parallel
   (shared surface) and sequence those.
6. **Supervise** — verify each unit's load-bearing claims yourself, collect the PRs, relay honest
   aborts, and land per the project's merge policy.

## vs `campaign`
`campaign` *finds* what to do (the `surveyor`); `feature` *is told* what to do (the author). Both
share the **architect SOLID gate** and the build half; `feature`'s one extra front-end gate is the
**author-clarification loop** (+ an explicit design step) — because a feature's distinctive risk is
**misunderstanding the ask**, caught cheaply *before* any design or code.

## Composition
(author request) → clarify-loop → design → `architect` (SOLID) → `fan-out` → `propose-review` × N → (`referee`) → PRs.
