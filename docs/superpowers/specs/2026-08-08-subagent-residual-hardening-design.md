# Subagent Residual Hardening

## Objective

Implement the confirmed, implementation-ready recommendations H2, H3, H5, H6,
M4, M5, M6, M7, M12, L1, and L8 from
`docs/agents/subagent-layer-review-2026-08-07.md` without restructuring the
coordinator or adding optional product policies.

## Scope

### Output recovery (H3)

Keep `task({ op: "read", name })` backward compatible as the first page of a
bounded recovery protocol. Add an optional byte cursor and bounded page size.
Pages must not split UTF-8 code points. Results expose the total byte count,
current cursor, next cursor, and whether more data remains. Registry-backed and
store-backed output use the same semantics. User-facing text must describe
recovery as paged, session-scoped, bounded, redacted on disk, and best-effort.
The existing tool output cap remains only a final safety net.

### Permission truth and mutation-policy boundary (H5, M7)

Plan and Ask prompts must describe the existing host-proven read-only delegation
carve-out instead of categorically blocking all coordinator tools. Secondary
documentation and the shipped Pit knowledge reference must match the canonical
permission documentation and current cacheable-prefix placement. Mutation policy
must be described as an edit-tool/path policy, not a filesystem sandbox; Bash
continues to be governed by permissions and guards rather than naive command
parsing.

### Live re-drive budget symmetry (H2, M12)

Tier-1 live `resume` and `continue` reserve the existing conservative subagent
budget before publishing lifecycle start, mutating retained transcript state, or
starting a provider call. Rejected operations leave their handles and Agents
unchanged. Settlement records only newly appended usage against the reservation,
and every success, failure, cancellation, and idle-wait path releases unused
reservation tokens. Concurrent callers sharing one in-flight lifecycle also
share one reservation.

### Diagnostics (H6)

Failures in best-effort output retention, resume/checkpoint persistence, and the
outer subagent guard replay wrapper emit bounded diagnostics through the existing
runtime diagnostics channel. Expected missing files, normal capacity eviction,
and successful cleanup do not emit failures. Diagnostics do not change fail-open
guard behavior, task success, store return values, or checkpoint ordering.

### Operational observability (M4, M5, M6, L1, L8)

`op:"list"` exposes high-signal context already held by the coordinator: canonical
model identifier, cost, depth, worktree/manifest summary, partial/error state,
denied tools, and governor remaining/reserved values. Live `resume` and `continue`
completion callbacks report per-operation turn and usage deltas. FIFO eviction of
live continuable/resumable Agents becomes visible through bounded markers or
diagnostics, with continuable loss called out distinctly from disk-backed resume.
The malformed eviction separator is corrected. Registry records remain `pending`
while waiting for a process-wide run slot and transition to `running` only after
slot acquisition.

### Safety-edge coverage (M12)

Add direct tests for Ask-mode worktree rejection, runtime interception of a real
write outside `allowedPaths`, and exhausted-governor rejection of live resume and
continue. Existing successful Plan/Ask read-only delegation tests remain unchanged.

## Non-goals

- M9 fanout reviewer-depth semantics.
- Aggregate task deadlines or fanout empty/all-failed policy.
- Bash command parsing as a mutation sandbox.
- Durable continue or durable final-output storage.
- Worktree isolation expansion, scheduler redesign, or coordinator splitting.
- Findings classified as optional, measurement-dependent, rejected, or already
  resolved in the source review.

## Delivery sequence

1. Permission/documentation truth and paged output recovery.
2. Live re-drive budget reservation and rejection coverage.
3. Retention and guard diagnostics.
4. List/lifecycle/eviction/queue observability.
5. Remaining safety-edge tests and documentation consistency.

Each package follows test-driven development: add a focused failing test, confirm
the expected failure, implement the minimum change, and rerun the focused suite.
After each package, a fresh `gpt-5.6-luna` reviewer inspects the diff for bugs,
regressions, edge cases, and test gaps. Accepted findings are fixed and the focused
checks rerun before the next package.

## Verification policy

Commands are bounded to at most two minutes. Use focused Vitest files during each
cycle, then `npx tsgo --noEmit`, `npm run check:static`, and a bounded focused
coordinator suite at final integration. Do not start the known long-running full
pre-push gate during the implementation session; report that limitation explicitly.
