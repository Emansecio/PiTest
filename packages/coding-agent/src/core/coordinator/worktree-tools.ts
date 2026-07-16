/**
 * Worktree tool retargeting (see SpawnSubagentDependencies.retargetToolsForCwd).
 *
 * A subagent spawned with `worktree: true` must actually WORK inside the
 * worktree. The parent's tool instances are bound to the parent checkout's cwd,
 * so handing them to the child verbatim silently defeats the isolation: every
 * relative path (and bash execution) resolves against the parent tree. This
 * rebuilds the cwd-sensitive core tools bound to the worktree path instead.
 *
 * Filesystem/exec/search/runtime tools are rebound — the set below. Everything
 * else (memory, messaging, MCP/extension tools, chrome, web search) keeps its
 * original instance: those are either cwd-insensitive or host-level singletons.
 * Coordinator tools and `code` are withheld: their closures/dispatcher are
 * bound to the parent session and could escape the worktree on nested calls.
 *
 * The rebuilt instances use default tool options (no parent mtime/read-dedupe
 * stores, no shell command prefix): the worktree is a distinct checkout, so
 * sharing the parent's per-file stores would be wrong anyway. Rebinding is
 * fail-closed for cwd-sensitive tools — retaining a parent-bound instance would
 * silently violate the isolation contract.
 */

import type { AgentTool } from "@pit/agent-core";
import { allToolNames, createTool, type ToolName } from "../tools/index.ts";
import { isCoordinatorTool } from "./brand.ts";

/** Core tools whose behavior is rooted at a cwd (paths, exec, search). */
const CWD_SENSITIVE_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"bash",
	"edit",
	"edit_v2",
	"write",
	"grep",
	"find",
	"ls",
	"symbol",
	"find_symbol",
	"ast_grep",
	"ast_edit",
	"repo_map",
	"security_surface_map",
	"security_static_scan",
	"security_http_replay_diff",
	"security_validate_finding",
	"security_evidence",
	"inspect_image",
	"eval",
	"lsp",
	"debug",
	"preview",
]);

/** Parent-session dispatchers/closures that cannot be safely rebound. */
const WORKTREE_BLOCKED_TOOLS: ReadonlySet<string> = new Set(["code"]);

export type WorktreeToolFactory = (toolName: ToolName, cwd: string) => AgentTool;

/**
 * Replace each cwd-sensitive core tool in `tools` with an instance bound to
 * `cwd`. Non-core and cwd-insensitive tools pass through untouched.
 */
export function retargetToolsForWorktree(
	tools: AgentTool[],
	cwd: string,
	factory: WorktreeToolFactory = (name, targetCwd) => createTool(name, targetCwd) as unknown as AgentTool,
): AgentTool[] {
	const retargeted: AgentTool[] = [];
	for (const tool of tools) {
		if (isCoordinatorTool(tool) || WORKTREE_BLOCKED_TOOLS.has(tool.name)) continue;
		if (!CWD_SENSITIVE_TOOLS.has(tool.name)) {
			retargeted.push(tool);
			continue;
		}
		if (!(allToolNames as Set<string>).has(tool.name)) {
			throw new Error(`worktree tool retarget failed: unknown cwd-sensitive tool "${tool.name}"`);
		}
		try {
			retargeted.push(factory(tool.name as ToolName, cwd));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`worktree tool retarget failed for "${tool.name}": ${message}`);
		}
	}
	return retargeted;
}
