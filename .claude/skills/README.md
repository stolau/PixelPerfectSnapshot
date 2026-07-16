# Building-flow skills

A generic, copy-anywhere system for AI-orchestrated software work. **Two tiers, by directory:**

- **`.claude/skills/` — commands you call** (3 orchestrators).
- **`.claude/agents/` — internal actors, auto-spawned, never called directly** (7 subagents).

That split *is* the hierarchy: if it's in `skills/`, you invoke it; if it's in `agents/`, the
machinery spawns it.

## Tier 1 — Skills you call (`.claude/skills/`)
| Command | What it does |
|---|---|
| **`campaign`** | The master, survey-driven. `/campaign <area>` → survey → **you pick** → architect gate → fan out → report PRs. **Start here for "what's next?"** |
| **`feature`** | The master, author-driven. `/feature <request>` → **clarify with you** → architect gate → break down → build. **Start here for "build me X".** |
| `architect-review` | Standalone **read-only audit** of the product's architecture (SOLID + soundness) → prioritized concerns. No build. |
| `propose-review` | Run **one** task through the full cycle (proposer → reviews → PR). |
| `fan-out` | Run **several** independent tasks in parallel worktrees and land them. |

## Tier 2 — Actors, auto-spawned (`.claude/agents/`)
Self-contained subagents the orchestrators spawn by `subagent_type`. Each runs in a **fresh,
isolated context**; reviewers/proposer/surveyor/referee are **read-only** (can't edit code).
| Subagent | Role |
|---|---|
| `surveyor` | Investigate → N moves + ranked recommendation |
| `architect` | Judge a *design* (SOUND / CONCERNS) or audit the *product* — vs SOLID + anti-over-engineering |
| `proposer` | One PR-sized plan, grounded in the code |
| `plan-reviewer` | Judge the *idea*, pre-code → APPROVE / REVISE / PIVOT |
| `implementer` | Build exactly the approved plan |
| `test-author` | Tests + the *real* proof (never rig a fixture) |
| `code-reviewer` | Judge the *diff*, post-code → APPROVE / CHANGES |
| `referee` | Break a deadlock → PICK / SYNTHESIZE / honest-abort |

## Skill vs subagent (the composition rule)
- **`Skill`** = compose *behavior* **within one context** (the caller switches mode). Used by an
  orchestrator for its own flow.
- **A subagent** (`Agent` tool) = compose *isolation* **across contexts** (fresh context, doesn't
  see the caller's history). Every **independent phase** runs as a subagent — that's what makes
  the cold reviewers and clean-history referee independent *by construction*.

The two masters differ only at the *front* — how work is chosen — then share an **architect
SOLID gate** and one build half:
```
/campaign <area>   → surveyor → ⏸ you pick ─────┐
                                                 ├→ architect (SOLID gate) → fan-out → unit per item
/feature <request> → ⏸ clarify-loop → design ───┘                              └─ propose-review (per unit)
                                                                                    proposer → plan-reviewer
                                                                                    → implementer + test-author
                                                                                    → code-reviewer → PR
                                                                                    └─ referee (deadlock / collision)
                                                 → supervise: verify claims, collect PRs, land per policy

/architect-review [area] → architect (product audit) → prioritized concerns  (read-only; no build)
```

## Principles
Ground in the real code · independent critique (the reviewer never trusts the proposer) · honest
proof or no ship (never rig a fixture) · honest aborts/pivots beat fake progress · one PR-sized
change at the simplest altitude · the supervisor **verifies** load-bearing claims, never trusts.

Project-specific conventions (branch/merge policy, PR style, what "real validation" means) come
from the project's own docs/memory — this system is the generic flow they plug into.
