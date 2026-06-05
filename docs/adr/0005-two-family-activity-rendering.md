# Two-Family Activity Rendering (Navigation Folds, Action Gets Its Own Line)

**Status:** accepted

The interactive TUI groups a turn's tool calls to keep the agent's prose in the foreground. Commit `58366b8c` folded *every* tool call — navigation and action alike — into a single aggregated counter line (`✓ Did 4 files · 2 edits · 1 command`), chasing maximum minimalism. We are reverting that: **navigation** tools (read/grep/ls/find/symbol — read-only orientation) fold into one Activity Group (`✓ Explored 3 files · 1 search`), but **action** tools (edit/write/bash/web/eval — observable effect) each get their own line with a category verb (`✓ Edited foo.ts +12 -3`, `✓ Ran $ npm test`).

## Why

Folding everything optimized signal/noise too far: it buried the *actions*, which are the signal, not the bastidor. A `2 edits` counter hides exactly what the human wants to audit (which files changed, what command ran). Navigation is disposable orientation; action is observable work. The `✓ Did` verb is also semantically empty (and produced nonsense like `Did 1 question` for the `ask` tool, which performs no action — it is a turn exchange, now rendered outside the group entirely).

The reference we had been targeting (Amp) already uses this two-family split — pure-folding drifted *away* from the north star, not toward it. Minimalism is preserved on other axes (no gutter, light counter, clickable paths, tight spacing).

## Considered Options

- **Fold everything (the 58366b8c status quo).** Rejected: hides actions; generic `Did` verb; `Did 1 question` is wrong.
- **No grouping at all (one block per call).** Rejected: this is the original signal/noise problem the grouping work set out to solve.
- **Two families (chosen).** Navigation folds; action breaks the group and emits its own verb-led line. Unknown/extension/MCP tools default to `action` (shows rather than hides).

## Consequences

- `ActivityStacker.placeCall` must branch on `ToolExecutionComponent.getActivityFamily()` (infrastructure already present): an action closes the open group and is added to the chat as its own line.
- A future reader scanning git history will see fold-everything → two-family without this record; that is the surprise this ADR exists to explain.
- The escape-hatch setting (`tui.toolActivity: "grouped" | "legacy"`) remains for one-off reversion.
