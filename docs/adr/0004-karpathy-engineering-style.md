# ADR-0004: Karpathy Guidelines as Engineering Style

## Status
Accepted

## Context
Runtime enforcement (read guard, diff limit) catches failures AFTER they happen. We also need prevention — biasing the model toward correct behavior from the start. Andrej Karpathy published observations on common LLM coding pitfalls that align with our failure patterns.

We considered:
1. **No prompt additions** — rely purely on runtime enforcement.
2. **Always-on guidelines** — inject Karpathy-derived rules into every system prompt.
3. **Configurable profiles** — user selects "strict" / "balanced" / "creative".

## Decision
Always-on guidelines (option 2). The guidelines are injected into `buildSystemPrompt()` as engineering style bullets. They complement runtime enforcement:

- **"Think before coding"** → reduces need for doom-loop intervention
- **"Simplicity first"** → reduces need for diff-limit pauses
- **"Surgical changes"** → reduces blast radius of edits
- **"Goal-driven execution"** → improves self-verification before moving on

**Token cost:** ~400 tokens in system prompt. Pays for itself by preventing 1-2 over-engineering turns per session (~2000+ tokens each).

**Implementation:** Added via `engineering-styles.ts` module that exports style bullets. Integrated into `buildSystemPrompt()` after tool guidelines. The file `src/core/engineering-styles.ts` already exists in PiTest.

## Consequences
- **Positive:** Model produces smaller, more focused changes on first attempt. Fewer correction loops.
- **Negative:** 400 tokens per turn in system prompt. Negligible vs. the 15k+ saved by preventing mistakes.
- **Not configurable initially.** If users complain about over-restriction, we add profiles later. YAGNI until proven otherwise.
