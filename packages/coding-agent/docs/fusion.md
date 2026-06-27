# Fusion Mode

Fusion mode turns Pit into a multi-model panel: it dispatches the same prompt to
two or more models in parallel, has a **judge** synthesize their answers, optionally
**verifies** key claims against the actual code, and a **writer** produces the final
answer. The result is broader coverage and fewer blind spots than any single model
would achieve.

## How it works

```
User prompt
  │
  ├─► Panel: model A (claude) ──┐
  ├─► Panel: model B (codex) ──┤  (parallel, with optional staggering)
  │                             │
  ├─► Judge ──► consensus / contradictions / unique insights / blind spots
  │            └─► unsupported claims (flagged for verification)
  │
  ├─► Verifier ──► fact-checks unsupported claims against the code (read-only)
  │
  └─► Writer ──► synthesized answer (corrects or hedges based on verification)
```

1. **Fan-out**: each panel member runs its own model CLI (`claude` or `codex`)
   in parallel. Members of the same CLI are staggered by a brief delay to avoid
   correlated throttling.
2. **Judge**: a structured pass that identifies consensus, contradictions,
   partial coverage, unique insights, and blind spots across the surviving
   panel answers.
3. **Verifier** (optional): reads the codebase to fact-check any unsupported
   claims, returning `confirmed`, `refuted`, or `unverified` for each.
4. **Writer**: synthesizes the single best answer, respecting the verifier's
   findings — refuted claims are corrected or dropped, unverified ones are
   hedged.

## Activation

Toggle fusion mode with **Alt+P** (cycles through plan → auto → fusion).
The current mode is shown in the footer.

Fusion mode is also available as the `/fusion` slash command.

## Configuration

Fusion uses the same credentials as the main Pit session — no separate CLI
login is needed. The panel member list is defined in `settings.json`:

```json
{
  "fusion": {
    "panel": [
      { "cli": "claude", "model": "claude-sonnet-4-6" },
      { "cli": "codex", "model": "gpt-4o" }
    ],
    "staggerSameCliMs": 3000,
    "verification": true
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `panel` | array | — | List of panel members, each with `cli` (`"claude"` or `"codex"`) and `model`. |
| `staggerSameCliMs` | number | `3000` | Delay between launching same-CLI members (avoids correlated throttling). |
| `verification` | boolean | `true` | Enable read-only fact-checking of unsupported claims against the code. |

To determine which CLI a registered provider maps to, Pit uses:

| Provider | CLI |
|----------|-----|
| `anthropic` | `claude` |
| `openai-codex` | `codex` |

## Data flow

- Each panel member writes its answer to a temp file, read back and capped at
  the output budget.
- The judge and writer run as a single-model LLM call against the configured
  provider (the **synthesizer** — typically one panel member's model).
- The verifier runs read-only tool calls (`read`, `grep`, `find`, `ls`) 
  through the Pit harness.
- If both panel members fail:
  - `degraded: "both-failed"` — the request falls through to the default model
  - `degraded: "solo-synth"` — only one member survived; the synthesizer still
    writes the answer, but without the judge's multi-perspective analysis.

## Results

The Fusion summary contains:

- **Members**: CLI, model, success status, elapsed time, output size
- **Judge**: counts of consensus, contradictions, partial coverage, unique
  insights, and blind spots
- **Verification**: confirmed / refuted / unverified counts
- **Synthesis**: actionable items grouped by kind (consensus, contradiction,
  partial, unique, blind-spot)

## When to use it

Fusion mode is most valuable for:

- **Planning**: architectural decisions benefit from multiple perspectives.
- **Debugging**: competing hypotheses tested in parallel, then cross-checked.
- **Code review**: two models catch different categories of issues.
- **Risk reduction**: high-stakes changes where a blind spot could be costly.

For simple tasks, single-model mode is faster and cheaper. Fusion adds latency
equal to the slowest panel member plus the judge/writer pass.
