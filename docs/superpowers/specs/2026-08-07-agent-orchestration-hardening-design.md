# Agent Orchestration Hardening

## Objective

Make Pit agent and subagent execution terminate predictably, remain cancellable,
and accept every authenticated model exposed by the active harness while keeping
safety limits configurable and preserving existing public APIs where practical.

## Lifecycle

Coordinator operations share one cancellation contract. Parent interruption,
session shutdown, and direct session disposal abort blocking runs, detached runs,
resume, continue, and join. Worktree setup and provider stream construction also
observe cancellation. Teardown drains cooperative work under a finite grace period
without waiting forever for non-cooperative extensions or providers.

`session_before_*` hooks remain serial because they may cancel transitions, but
each handler is bounded and abort-aware. A timeout is reported as an extension
error and does not freeze session replacement.

## Models And Providers

The coordinator resolves models from one session view containing the registry,
SDK-scoped models, and the current parent model. Explicit `provider/model`
selection remains deterministic. Built-in agent types do not hardcode a model
family that may be unauthenticated; they inherit the parent unless the session can
select an authenticated small model.

Subagents use the parent session request policy for auth, credential pools,
headers, retries, timeouts, provider hooks, and dynamic transports. Auth fallback
uses structured classification with a conservative message fallback. Resume state
stores the model that actually ran after fallback.

## Rules And Limits

Safety backstops remain, but do not reject productive work incorrectly:

- Plan and Ask may delegate only when the effective child tool catalog is
  side-effect-free and no worktree is requested.
- Identical-call loop protection does not hard-abort known polling operations.
- Doom-loop cooldown is honored by the identical-call ladder.
- Plan step verification timeout is configurable and may be revised explicitly.
- `max_turns` is a positive integer. Existing default turn, depth, concurrency,
  queue, and token limits remain configurable.
- Goal completion respects verification enablement and session ownership.

## Goals And Persistence

Goal contract enforcement and all built-in callers migrate atomically. The schema
matches runtime requirements, and tests/faux models provide contract evidence.
Background verification gates inspect only jobs owned by the active session.

Interrupted subagents checkpoint resumable state after each completed turn when
their worktree is retainable. Writes remain best-effort and redacted. Large output
recovery supports bounded paging rather than claiming a capped head-tail response
is integral.

## Diagnostics

Unknown `allowed_tools`, malformed agent definitions, model fallback, lifecycle
timeouts, and output retention failures produce actionable diagnostics. Parallel
and fanout results expose the same fallback provenance as blocking task results.

## Compatibility

Existing task operations and model strings remain valid. New configuration fields
have safe defaults. Compatibility is retained only for persisted resume/goal data
and existing public SDK call shapes; no general legacy shim is added.

## Verification

Add focused regression tests for abort propagation, direct dispose, worktree
cancellation, bounded lifecycle hooks, cross-provider and SDK-scoped model
selection, auth fallback, fallback resume, goal ownership, verification disablement,
positive turn validation, per-turn checkpoints, and paged output reads. Then run
the touched package tests, `npm run check:fast`, `npm run check`, and `test.ps1`.
