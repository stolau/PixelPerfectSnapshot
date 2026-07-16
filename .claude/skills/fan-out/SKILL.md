---
name: fan-out
description: Run many independent units of work in parallel, each in its own isolated worktree, with a supervisor who VERIFIES results rather than trusting them — then lands them. Use for breadth (several tasks at once) or to try several approaches in parallel. Generic — works on any codebase; pairs with the `propose-review` skill.
---

# fan-out

Do N independent pieces of work at once, then land them. **You are the supervisor:** you spawn
the units, relay their results, **verify their load-bearing claims yourself**, resolve the
(usually additive) merge conflicts, and merge per the project's policy.

Use it when the pieces are genuinely **independent**, or to explore several approaches in
parallel. **Don't** fan out trivial work, or a chain where each step depends on the previous —
do that serially, inline.

## Spawn
**Sync local main first** (`git checkout main && git pull`) — worktrees are cut from local HEAD,
so a stale base silently builds on old code. Then spawn one **background** unit per task, each in
its **own worktree**:
```
Agent(run_in_background: true, isolation: "worktree",
      prompt: "<the task>, following the propose-review skill")
```
Isolation is required: each unit branches and writes files; a shared tree would collide. For
heavy or fully-independent runs, `isolation: "remote"` puts each in its own cloud sandbox. Each
worktree unit runs the **propose-review** conductor, which in turn spawns the actor subagents
(`proposer`, `plan-reviewer`, `implementer`, `test-author`, `code-reviewer`, `referee`) — so the
parallelism is *units × their internal phases*, all isolated.

## Supervise — VERIFY, don't trust
As each unit reports back:
- **Relay what matters** — the converged plan, the PR, any honest deferral or abort.
- **Independently verify the load-bearing claims before you trust them.** Agents (and CI) report
  "green / done / fixed" that isn't — a unit-test-only "fix", a stale or flaky build, an
  environment red-herring. Pull the real artifact and check the one thing that matters *yourself*:
  run the real proof, read the actual failing log, diff the real change. **This single habit is
  what makes fan-out trustworthy.**
- An honest **abort** from a unit is a good outcome — don't re-spawn it to force a result.

## Land them
- **Map the conflicts up front.** Disjoint-file PRs merge cleanly; the overlap is usually
  additive (a shared registry/list, a CODEMAP, a changelog) — resolve those mechanically.
- **Merge per the project's policy** (commonly: one at a time; rebase/retarget the next branch
  onto the new main before merging). A unit that was green *in its own branch* can still break
  **combined** with a sibling — verify the merged result, don't assume.
- If two units produced **competing solutions to the same task**, send both to **`referee`** — a
  clean-history arbiter that picks the stronger or synthesizes the best of both.

## Recovery
Background units **don't survive a supervisor restart** — their in-flight state is lost, but
**anything they already pushed survives**. Re-spawn the unfinished ones from current main. If a
unit idles waiting on a long external job (CI, a deploy), resume it and tell it to actively
block on that job's result rather than idle.

## Why it works
Breadth without chaos: isolation keeps parallel work from colliding, the independent actors in
each unit — a Proposer plus a separate **Plan Reviewer** and **Code Reviewer** (the
**`propose-review`** conductor) — keep quality up, and a supervisor who **verifies instead of
trusting** keeps bad/fake "done"s from landing. Honest aborts are expected and fine — a unit
that stops with a reason beats one that forces a result.
