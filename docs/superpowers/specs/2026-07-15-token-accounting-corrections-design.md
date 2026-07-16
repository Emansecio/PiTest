# Token accounting corrections

## Reader and outcome

This design is for a Pit maintainer. After reading it, they should be able to
make token accounting consistent across normal turns, Fusion, subagents,
continuations, resumes, compacted sessions, and failed orchestration pipelines.

## Problem

Pit receives trustworthy per-response usage components from providers, but its
consumers apply different accounting rules. Main-agent and several Fusion paths
omit prompt-cache traffic, while subagents include it. In-memory continuation
and resume paths bypass usage recording. A freshly compacted context can display
a stale pre-compaction wire count. Session totals are derived from the current
materialized context instead of all persisted provider responses. Finally, a
late fanout or Fusion-verifier failure can discard usage incurred by earlier
stages.

The result is that counters disagree even when they describe the same work.
Goal budgets may be bypassed, follow-up work can be free, and the context gauge
can temporarily show the size that compaction just removed.

## Token semantics

Every consumed-token total uses one invariant:

```text
input + output + cacheRead + cacheWrite
```

The four components remain exclusive. Cache reads and writes continue to be
shown separately where the UI exposes component detail. Cost accounting remains
provider-priced and is not converted into token-equivalent units.

Three concepts remain distinct:

- **Current context occupancy:** the latest provider-confirmed request context,
  or a structural estimate when no trustworthy response exists.
- **Session consumption:** every persisted assistant response produced in the
  session, including responses no longer present in the compacted context.
- **Goal consumption:** all model work performed for the active objective,
  including main turns, Fusion stages, subagents, retries, resumes, and
  continuations.

## Design

### Shared usage operations

Introduce one small token-usage module that:

- computes the inclusive total from provider usage components;
- aggregates assistant messages into the subagent usage shape;
- combines multiple subagent-usage values without mutating inputs;
- tolerates missing or zero usage while preserving cost totals.

Callers stop reimplementing arithmetic. Provider adapters remain unchanged.

### Main and Fusion accounting

Main-agent turn recording and API-backed Fusion stages use the shared inclusive
total. Successful verifier runs and verifier failures both charge the usage
already incurred. Existing CLI-stage token reports remain authoritative when a
CLI supplies an explicit total; character estimation remains the fallback.

### Resume and continuation accounting

Before re-driving a live subagent, capture the transcript boundary. After the
prompt settles—successfully, with an error turn, or by throwing—aggregate only
new assistant messages. Charge that delta exactly once and merge it into the
original registry record so task listing, per-handle usage, turn count, and the
Goal ledger stay aligned.

Persisted resume continues to use the normal spawn path and must not be charged
a second time.

### Fanout failure accounting

Fanout maintains an aggregate containing scout and reviewer usage before
starting the worker. If the worker or its acceptance judge fails, combine the
prior aggregate with usage attached to the thrown error and reattach the full
pipeline usage. The coordinator records the aggregate once. Successful fanout
keeps its existing per-stage recording path.

### Post-compaction context occupancy

Wire estimation gains an explicit structural-only mode. In that mode it ignores
all assistant usage anchors and estimates messages, system prompt, pending
messages, and tool schemas from their current serialized structure.

Immediately after compaction, both the message estimate and wire estimate use
this structural-only path and carry the estimated marker. The first valid
post-compaction provider response replaces them with exact usage.

### Session totals

Session token and cost totals iterate persisted message entries rather than the
materialized model context. Compaction and branch navigation therefore cannot
erase already incurred consumption. Message, tool-call, and tool-result counts
continue to describe the active context and are not silently changed into
lifetime counts.

## Error handling and invariants

- Usage incurred before an error is charged once, never discarded or doubled.
- Native provider `totalTokens` does not override the inclusive component
  invariant used by Pit counters.
- A zero-usage synthetic or preflight failure contributes zero.
- Structural estimation never trains from or anchors to stale usage.
- No counter reset is tied to compaction; only current-context occupancy drops.
- Existing unrelated workspace changes remain untouched.

## TDD verification

Each correction starts with a focused failing regression:

1. Cached main and Fusion calls charge all four components.
2. A successful continuation increases both Goal spend and the original task
   record; repeated continuations add only their own new messages.
3. An errored in-memory resume still charges any usage returned by the provider.
4. Immediately after compaction, `wireTokens` and percent fall with the
   structural message count instead of retaining the old usage anchor.
5. Session totals retain responses removed from the active context by
   compaction.
6. A worker failure after successful scout/reviewer stages propagates the full
   fanout usage.
7. A Fusion verifier schema failure still charges verifier usage.

After each RED/GREEN cycle, run the focused token, session, coordinator, Fusion,
and footer suites. Final verification runs the static gate and fast monorepo
test gate.

## Non-goals

- Changing provider pricing or cache-discount calculations.
- Treating cached tokens as uncached input in component displays.
- Introducing a process-global billing database.
- Reworking compaction thresholds beyond correcting their observed context
  input.
- Changing the Goal budget overshoot policy for an operation that began before
  exhaustion.
