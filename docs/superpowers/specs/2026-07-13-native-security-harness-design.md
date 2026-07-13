# Native Security Harness Design

**Status:** Approved by the user on 2026-07-13

## Scope

Pit will ship a zero-configuration, lazy security harness for authorized audit work. The implementation is limited to:

- universal secret redaction at diagnostic, evidence, artifact, HTTP-capture, and spill-to-disk boundaries;
- bounded CDP HTTP capture for request/response metadata and bodies;
- deterministic baseline/control/mutation replay and comparison;
- explicit finding lifecycle: `candidate -> reproduced -> validated`, with `retracted` as a terminal correction;
- anti-false-positive validation using a unique marker, semantic body differences, clean reproduction, interleaved timing samples, and complete chains;
- bundled security rule packs executed by the existing `ast_grep` N-API/CLI path;
- bundled OpenAPI parsing into endpoint and request inventories;
- local benchmark fixtures with a separate held-out oracle;
- five hidden tools discoverable through the existing tool search and activated only when selected.

No workspace trust model, sandbox, Semgrep, OSV, active recon, scope manager, or new `PIT_*` setting is included.

## Architecture

Security-domain logic lives under `packages/coding-agent/src/core/security/` and remains independent of the interactive session. Tool adapters live in the built-in tool registry and expose the domain through:

- `security_surface_map`
- `security_static_scan`
- `security_http_replay_diff`
- `security_validate_finding`
- `security_evidence`

All five registry entries use `coding: false`. They are therefore absent from the default active prompt, indexed by the existing hidden-tool discovery mechanism, and activated through `search_tool_bm25` without configuration.

## Data and Validation Model

Static matches are emitted only as `candidate` findings. A finding can become `reproduced` only with recorded reproduction evidence, and `validated` only when every validation check required by the claim passes. Any non-retracted finding can transition to `retracted`; a retracted finding cannot transition again.

Validation is deterministic:

- marker: non-empty marker occurs in the mutation and not in baseline/control;
- body diff: normalized response body differs from both controls, not merely by status code;
- clean reproduction: at least two clean attempts and all succeed;
- timing: when timing is claimed, baseline/control/mutation are interleaved, each arm has at least five samples, and the median effect exceeds a robust jitter threshold;
- chain: when a chain is required, every declared step has evidence and the chain is complete.

## HTTP Capture and Replay

CDP records method, URL, resource type, request headers/body, response status/headers/body, protocol, timestamps, duration, encoded length, and failures. Per-field and aggregate limits prevent unbounded memory use. Sensitive headers are replaced structurally and remaining text passes through the shared secret redactor before it can reach memory-backed evidence, model output, diagnostics, or disk.

Replay accepts explicit baseline, control, and mutation requests. It executes them in stable round order, applies identical timeouts and response limits, canonicalizes JSON bodies, and returns status/header/body/timing comparisons plus content hashes. It performs no retry that could hide a failed reproduction.

## OpenAPI and Static Analysis

`@scalar/openapi-parser` is a regular `@pit/coding-agent` dependency. Local OpenAPI/Swagger input is parsed into a stable inventory of methods, paths, parameters, security requirements, content types, and request templates. Remote references are not fetched implicitly.

Security static analysis reuses `@ast-grep/napi` through the existing ast-grep implementation. Bundled packs contain conservative sink-oriented JavaScript/TypeScript rules. Results include rule IDs and locations but are always lifecycle `candidate` records.

## Evidence and Benchmarks

Evidence is append-only JSONL beneath the Pit agent directory, partitioned by workspace. Before append, every serialized record passes through the shared disk redactor. The evidence API validates lifecycle transitions and supports append, list, and get operations.

The benchmark runner receives only fixture inputs. Expected decisions live in separate oracle files and are loaded after execution. It reports false-positive/false-negative counts, validation latency, and fixture-provided discovery-to-PoC duration, and fails when the oracle disagrees.

## Acceptance Criteria

- Synthetic credentials never appear in diagnostics, spill artifacts, evidence, CDP capture, or replay output.
- CDP tests prove bounded full request/response preservation.
- Illegal lifecycle transitions fail; static matches never skip `candidate`.
- Replay produces stable results for identical inputs and detects semantic mutation body changes.
- OpenAPI fixtures generate deterministic endpoint/request inventories.
- Security tools are hidden from the initial surface and discoverable without settings.
- Held-out benchmark fixtures pass with zero false positives and zero false negatives.

