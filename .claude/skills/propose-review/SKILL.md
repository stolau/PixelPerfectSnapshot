---
name: propose-review
description: Conductor — drive one task end-to-end through the actor subagents (proposer → plan-reviewer loop → implementer + test-author → code-reviewer loop → prove for real → terse PR, no merge). Owns the loop and abort rules. Run `/propose-review <task or focus area>`. Fan out many with the `fan-out` skill.
---

# propose-review · the conductor

Drives one unit from a task to an opened PR by sequencing the single-responsibility **actor
subagents** (defined in `.claude/agents/`). `$ARGUMENTS` = the task / focus area. **Each phase
runs as a SEPARATE subagent** — independence is the whole point. This skill owns only the loop
and abort rules; each phase's *job* lives in its own self-contained agent definition.

**How phases run:** spawn each phase with the `Agent` tool by `subagent_type` (`proposer`,
`plan-reviewer`, `implementer`, `test-author`, `code-reviewer`, `referee`) — each is a fresh,
isolated context. Pass it **only the inputs it needs** (e.g. the plan-reviewer gets the plan,
NOT the proposer's reasoning — that's the isolation point). The `Skill` tool runs in *this*
context; use it only for the conductor's own flow, never for a phase that must be independent.

## Sequence
1. **proposer** (`subagent_type: proposer`) — drafts one code-grounded, PR-sized plan.
2. **plan-reviewer** (`subagent_type: plan-reviewer`) — a fresh, isolated reviewer verifies it → **APPROVE / REVISE / PIVOT**.
   - Loop ≤ **3 rounds**: REVISE → fresh revision addressing the objections; PIVOT → fresh proposer
     for the narrowed/alternative scope; re-review. A pivoted plan the reviewer then APPROVEs is a
     legitimate convergence.
   - No APPROVE in 3 rounds → **escalate to `referee`** (`subagent_type: referee`): a fresh,
     clean-history arbiter gets the proposer's and reviewer's *final positions* (not the
     back-and-forth) and **picks or synthesizes** a plan — or declares an **honest abort** if
     neither is provable. Its verdict is final: proceed on it, or stop and report it + the last plan.
3. On APPROVE, run **autonomously through to the PR** (no human confirmation between here and the
   opened PR — that is what APPROVE authorizes):
   - **implementer** + **test-author** (`subagent_type: implementer` / `test-author`, sharing the
     unit's worktree) → the code + its real proof.
   - **code-reviewer** (`subagent_type: code-reviewer`) — a fresh, isolated reviewer checks the
     *diff* → **APPROVE / CHANGES**; address CHANGES and re-review until APPROVE. A stuck code loop
     **escalates to `referee`** too.
4. **Verify for real**, then push and open a PR with `gh` — body = terse bullets of what was done.
   **Do not merge**; report status (green/mergeable) + any honest deferrals for the supervisor.

## Two distinct review gates (the important split)
- **`plan-reviewer`** judges the *idea*, before any code — cheap to kill a bad premise or a fake proof.
- **`code-reviewer`** judges the *execution*, after the diff exists — catches drift, rigged tests, regressions.
Keeping them separate, and each a **fresh** subagent, is what keeps quality high.

## Actors at a glance (all in `.claude/agents/`)
`proposer` → `plan-reviewer` → (`implementer` + `test-author`) → `code-reviewer` → PR,
with **`referee`** breaking either review loop if it deadlocks.

To run many of these in parallel and land them, use **fan-out**; to go from "what's next?" all
the way through, use **campaign**.
