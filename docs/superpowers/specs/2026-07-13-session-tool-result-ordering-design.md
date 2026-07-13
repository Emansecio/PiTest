# Session tool-result ordering repair

## Reader and outcome

This design is for a Pit maintainer. After reading it, they should be able to
implement and verify recovery from a persisted session where an internal steer
was inserted between an assistant tool call and its result.

## Problem

Anthropic requires every `tool_result` to correspond to a `tool_use` in the
immediately preceding assistant message. A priority recovery steer currently
enters the live transcript while a tool is still executing, so persistence can
produce this invalid sequence:

1. assistant with `toolCall`
2. internal custom message, converted to a user message
3. matching `toolResult`

The malformed sequence survives reload. Every later prompt then fails before
the model can continue the session.

## Design

Use two narrow defenses:

1. Queue priority steers through the agent's existing front-of-queue API. The
   agent loop will persist them only after the current tool-result batch, while
   still draining them before older steering messages.
2. During provider message transformation, defer user messages that interrupt a
   pending tool-result batch. Emit matching real results first, synthesize only
   results that are genuinely missing, then emit the deferred user messages.
   Unmatched standalone results are omitted because no valid placement can be
   inferred.

No session file is rewritten. Existing malformed sessions are repaired only in
the outbound provider view, preserving the append-only transcript.

## Invariants

- A real matching tool result is never replaced by a synthetic result.
- Priority steers retain priority over older queued steers.
- Valid histories keep the fast path and their original object identity.
- Repair is provider-neutral because the tool-call/result ordering contract is
  shared by the supported chat APIs.
- Unrelated session WIP and persisted entries remain untouched.

## Verification

- A focused transformation test reproduces `assistant toolCall -> user steer ->
  matching toolResult` and expects `assistant -> matching toolResult -> user`.
- A queue/session test injects a priority custom steer while a tool is blocked
  and verifies both in-memory and persisted ordering.
- Existing transformation, queue, and session-recovery focused suites pass.
- The captured session shape produces a valid outbound Anthropic sequence after
  transformation, allowing a subsequent user turn.
