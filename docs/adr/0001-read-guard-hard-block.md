# ADR-0001: Read Guard as Hard Block

## Status
Accepted

## Context
The most common model failure pattern is editing files without reading them first. The model hallucinates file content, generates diffs against a non-existent version, and either the edit fails (best case) or silently corrupts the file (worst case).

We considered three approaches:
1. **Soft nudge** — system prompt instruction to read before editing. No enforcement.
2. **Hard block** — tool hook rejects edit/write if file wasn't read in session.
3. **Hybrid** — allow but track, inject reminder if rate exceeds threshold.

## Decision
Hard block (option 2). Implemented as a built-in extension that hooks `tool_call` events for `edit` and `write` tools.

**Scope:** Read tracking persists per-session but resets after compaction. Post-compaction, the model must re-read files before editing, since file content may have changed and the model's "memory" of the content is now a summary.

**Implementation:** Uses `FrequentFilesTracker` to determine which files have been read. The extension checks `tracker.entries.has(path)` before allowing edit/write.

## Consequences
- **Positive:** Eliminates hallucinated-content edits entirely. Zero false negatives.
- **Negative:** Adds one extra read call when the model "knows" the content from a previous compaction window. Acceptable cost (~200 tokens per forced read) vs. the cost of a corrupted file (entire recovery turn, ~2000+ tokens).
- **Edge case:** Model creates a new file with `write` — no prior read needed. Guard only applies to existing files (checked via filesystem existence).
