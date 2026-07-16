---
name: campaign
description: Master conductor — run the full build workload end to end: investigate → propose ~5 next moves + a recommendation → YOU pick → fan out the chosen moves to parallel worktrees → each runs the full propose-review cycle (with referee on deadlock) → supervise and report the PRs. Run `/campaign [area]`. The one entry point that ties the whole skill set together.
---

# campaign · the master conductor

The single command for "investigate what's next, then run it." `$ARGUMENTS` = an optional focus
area. A **thin conductor** over the actor subagents + the `fan-out`/`propose-review` skills — its
one special job is the **human pick gate**.

## Arc
1. **Survey** — spawn the **`surveyor`** subagent (`Agent`, `subagent_type: surveyor`): investigate → ~5 candidate moves (each scored) + a ranked recommendation.
2. **⏸ PRESENT & STOP** — show the moves + your recommendation and **wait for the human to pick** one or several. Default is to stop here; **never auto-select** unless explicitly told to run autonomously. Flag any picks that can't run in parallel (shared surface).
3. **Architect gate (SOLID)** — spawn the **`architect`** subagent (`subagent_type: architect`, blank context) on the chosen moves' intended approach → **SOUND / CONCERNS**. On CONCERNS, revise the approach or drop the move before spending build effort. Keep it light for trivial moves (a doc fix is SOUND on sight); spend the scrutiny on moves with real structural impact.
4. **Fan out** — for the (sound) chosen move(s), run **fan-out**: one background worktree unit per move, each running the **propose-review** conductor (which spawns `proposer → plan-reviewer → implementer + test-author → code-reviewer → PR` subagents), with **`referee`** breaking any stuck loop.
5. **Supervise** — as units report, **verify their load-bearing claims yourself** (don't trust "done"), collect the PRs, relay honest aborts, and land per the project's merge policy. If two units produced overlapping/competing work, **referee** the tie-break.

## Composition
`surveyor` → (human pick) → `architect` (SOLID gate) → `fan-out` → `propose-review` × N → (`referee` on deadlock) → PRs.
Each phase is a separate, fresh subagent. This skill owns only the **pick gate** and the
end-to-end relay; every phase's real work lives in its own self-contained agent.
