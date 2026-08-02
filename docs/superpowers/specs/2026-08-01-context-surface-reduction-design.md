# Context surface reduction design

## Goal

Reduce the normal Pit turn prompt from roughly 14k tokens to at most half of
that size, without removing capabilities. Specialized skills and browser tools
remain available on demand.

## Current evidence

- Normal default runtime: 44 active tools, about 51.9k prompt/wire characters
  (about 14k tokens) in the local reconstruction.
- Loaded skill metadata contributes about 22.7k characters to the system prompt.
- Chrome DevTools contributes 19 tools to every turn even when the request is
  unrelated to a browser.

## Design

1. **Skills are retrieval-first.** The cacheable prompt contains a short hint
   that points to `search_skills`/`read`. A deterministic matcher appends up to
   three relevant skill cards after the dynamic marker for the current prompt.
   The full catalog remains available through the existing tools.
2. **Chrome tools are turn-scoped.** The default active surface excludes the
   Chrome family. A small built-in extension classifies browser intent and
   activates only a relevant Chrome subset for that turn. The next user prompt
   recomputes the surface, removing the prior browser family first.
3. **No AGENTS/context-file change in this slice.** Those files are project
   instructions and remain authoritative; reducing them would trade away
   behavior rather than remove duplicated routing metadata.
4. **Compatibility is fail-open.** If matching or routing fails, Pit keeps the
   existing active tools and system prompt. The discovery tool remains the
   fallback for tools not selected by the heuristic.

## Acceptance criteria

- Default non-browser prompt has no Chrome tools active.
- Default non-browser system prompt contains no full skill catalog.
- Explicit/relevant skills are surfaced as at most three compact cards.
- Browser prompts activate only the relevant Chrome subset and remove it on
  the next non-browser prompt.
- Existing full prompt APIs keep their default behavior for external callers.
- Focused tests cover skill matching, prompt rendering, and browser routing.

## Self-review

- **Overengineering:** avoided a new settings surface and reused the existing
  extension event, active-tool API, and discovery index.
- **Hidden behavior:** browser activation is visible in the active tool list and
  the prompt receives a compact routing note.
- **Failure mode:** all new logic is bounded, synchronous, and fail-open; a
  matcher error does not block a turn.
- **Measurement:** the runtime benchmark is rerun after implementation against
  the same default settings reconstruction.
