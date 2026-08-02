# Tools

**Canonical docs:** `packages/coding-agent/docs/usage.md` (§ Tool Options — the
authoritative surface list) · `packages/coding-agent/docs/settings.md`
(§ Tool Discovery and the per-tool feature sections) · `Taxonomia.md` area 4.
**Code anchors:** `src/core/tools/index.ts` (`TOOL_REGISTRY` — the single source
of truth for built-in names), `src/core/built-ins/coordinator-extension.ts`
(`task`/`parallel`/`fanout`).

Tools *do* things. *Whether they may* is a separate layer (permissions, grounding,
preconditions, verification — `Taxonomia.md` area 5). Never explain a block by
the tool; explain it by the guard.

## By category

**Read & search** — `read`, `grep`, `find`, `ls`, `symbol` (symbol lookup),
`find_symbol`, `repo_map` (project skeleton), `impact` (query over the persisted
import graph), `inspect_image`, `recall_history`.

**Edit & write** — `edit`, `edit_v2` (hashline-based editing), `write`, `undo`
(reverts the last edit/write of one file from its automatic pre-image snapshot),
`ast_edit` (structural edit), `resolve` (stage/commit previews).

**Execute** — `bash`, `eval` (persistent Python/JS kernels), `code` (code-mode
VM), `debug` (DAP), `recipe` (task-runner abstraction).

**Structure & semantics** — `ast_grep` (AST structural search), `lsp` (language
server: diagnostics, references, rename …), `render_mermaid`, `calc`.

**Task cognition** — `todo` (the universal tracker), `plan` (versioned DAG with
verify commands, for long multi-phase work), `goal_complete`, `pin`.

**Memory** — `retain` / `recall` / `reflect` / `forget` (hindsight memory).

**Orchestration** — `task`, `parallel`, `fanout` (subagents; from the coordinator
extension, not the registry), `message` (typed messages from sub-agent to parent,
gated by `agentMessaging.enabled`).

**Discovery** — `search_skills`, `search_tool_bm25`, `recall_tool_output`.

**Web & browser** — `web_search`, `preview`, the `chrome_devtools_*` family
(navigate, click, fill, evaluate, screenshot, read console/network, snapshot,
element-to-source, …).

**Security** — `security_surface_map`, `security_static_scan`,
`security_http_replay_diff`, `security_validate_finding`, `security_evidence`.
Every match is a *candidate*, never a validated vulnerability.

Feature tools join the surface when their settings are enabled (most default on);
Chrome DevTools tools and `preview` are activated for browser-oriented turns and
otherwise stay discoverable.

## Tool discovery (BM25)

Not every tool sits on the active surface — a large surface costs tokens on every
turn. `search_tool_bm25` is **always registered** and searches a hidden index of
off-surface tools by keyword; the model calls it, then uses whatever it surfaced.

| Setting | Default | Effect |
|---|---|---|
| `toolDiscovery.enabled` | `true` | Seed the hidden index at session boot |
| `toolDiscovery.alwaysActive` | `[]` | Keep these tools on the active surface even if they would be hidden |
| `toolDiscovery.hiddenByDefault` | `[]` | Remove these from the active surface and index them as hidden |

The same idea applies to skills (`search_skills` + on-demand `read` of the
`SKILL.md`) and to deferred MCP servers (`mcp.defer`, or `PIT_DEFER_MCP=1` to
force every MCP tool into the index). Large historical tool outputs can be
deferred to a session store and pulled back with `recall_tool_output`
(`PIT_DEFER_HISTORY=1`).

## Shaping the surface from the CLI

| Flag | Effect |
|---|---|
| `--tools <list>`, `-t <list>` | Allowlist specific built-in, extension and custom tools |
| `--no-builtin-tools`, `-nbt` | Drop built-ins, keep extension/custom tools |
| `--no-tools`, `-nt` | No tools at all |

A read-only session without touching permissions:
`pit --tools read,grep,find,ls -p "Review the code"`.

## Adding tools

New tools normally arrive as **extensions** (`packages/coding-agent/docs/extensions.md`)
or through **MCP servers** (`packages/coding-agent/docs/mcp.md`, tools namespaced
`mcp__<server>__<tool>`), not by growing the core. MCP tools are denied outright
in the read-only Modes.
