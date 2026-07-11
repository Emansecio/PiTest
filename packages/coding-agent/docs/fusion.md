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

- **Alt+P** cycles permission/orchestration: Plan → Auto → **Fusion·Plan** → Plan.
  Fusion is always Plan (read-only). If the panel isn't configured yet, Alt+P
  opens `/fusion` instead of entering an empty Fusion mode.
- **`/fusion`** opens a single setup screen: pick two advisors (searchable), see
  the synthesizer (active `/model`), and toggle `verify` / `brief`. Completing
  setup activates Fusion orchestration. The active `/model` is the synthesizer
  (judge + writer), not a panel member.

## Configuration

Fusion uses the same credentials as the main Pit session — no separate CLI
login is needed. Settings live under `fusion` in `settings.json` (see also
[Settings → Fusion](settings.md#fusion)):

```json
{
  "fusion": {
    "panel": [
      { "cli": "claude", "model": "claude-sonnet-4-6" },
      { "cli": "codex", "model": "gpt-4o" }
    ],
    "staggerSameCliMs": 400,
    "verify": true,
    "lean": true,
    "brief": true
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `panel` | array | `[]` | Up to two members, each with `cli` (`"claude"` or `"codex"`) and `model` |
| `timeoutMs` | number | `600000` | Hard wall-clock cap per panel member (ms) |
| `idleTimeoutMs` | number | `90000` | Kill a member only after this long with no output |
| `staggerSameCliMs` | number | `400` | Delay before launching a second member on the same CLI |
| `verify` | boolean | `true` | Run read-only fact-checking of unsupported claims before the writer |
| `verifyTimeoutMs` | number | `60000` | Wall-clock cap for the verify subagent |
| `lean` | boolean | `true` | Run panel CLIs lean (skip user hooks/skills/MCP where supported) |
| `brief` | boolean | `true` | Synthesizer rewrites the prompt for advisors before the panel |
| `showSynthesis` | boolean | `false` | Surface the judge's structured analysis inline in the summary |

To determine which CLI a registered provider maps to, Pit uses:

| Provider | CLI |
|----------|-----|
| `anthropic` | `claude` |
| `openai-codex` | `codex` |

## Data flow

- Before panel/judge/writer, Fusion runs the same context-economy preflight as
  solo turns: join any predictive background compaction, hard-threshold compact
  if needed, then a presend overflow check that includes the pending user text
  in the wire estimate. (It does not call `agent.continue()` after compacting —
  Fusion owns the turn.)
- If a goal token budget is exhausted, Fusion emits a synthetic message and
  skips the panel (does not fall through to solo).
- Each panel member writes its answer to a temp file, read back and capped at
  the output budget.
- The judge and writer run as a single-model LLM call against the **active
  session model** (the synthesizer).
- The verifier runs read-only tool calls (`read`, `grep`, `find`, `ls`,
  `symbol`, `find_symbol`) through the Pit harness, gated by the session
  permission checker when available.
- Abort (Esc) before the writer persists the user prompt and an interrupted
  note so the transcript stays consistent.
- If both panel members fail:
  - `degraded: "both-failed"` / `"both-throttled"` — falls through to the
    synthesizer as a normal solo turn (with a note)
  - `degraded: "solo-synth"` — only one member survived; the synthesizer still
    writes the answer (judge skipped when a single survivor)

## Results

The Fusion summary contains:

- **Members**: CLI, model, success status, elapsed time, output size
- **Judge**: counts of consensus, contradictions, partial coverage, unique
  insights, and blind spots
- **Verification**: confirmed / refuted / unverified counts
- **Synthesis**: actionable items grouped by kind (consensus, contradiction,
  partial, unique, blind-spot) when `showSynthesis` is true

## When to use it

Fusion mode is most valuable for:

- **Planning**: architectural decisions benefit from multiple perspectives.
- **Debugging**: competing hypotheses tested in parallel, then cross-checked.
- **Code review**: two models catch different categories of issues.
- **Risk reduction**: high-stakes changes where a blind spot could be costly.

For simple tasks, single-model mode is faster and cheaper. Fusion adds latency
equal to the slowest panel member plus the judge/writer pass.
