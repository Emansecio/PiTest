import type { AgentTool } from "@pit/agent-core";

/** Name of the coordinator-spawned tools. Stripped/rebuilt per nesting level. */
export const COORDINATOR_TOOL_NAMES = new Set(["task", "parallel", "fanout"]);

/**
 * Brand stamped on every coordinator-spawned tool. The recursion guard strips
 * tools by this brand rather than by name.
 */
export const COORDINATOR_TOOL_BRAND: unique symbol = Symbol("pit.coordinatorTool");

/** True when `tool` is a coordinator tool (carries the brand). */
export function isCoordinatorTool(tool: AgentTool | { name?: string }): boolean {
	return (tool as { [COORDINATOR_TOOL_BRAND]?: boolean })[COORDINATOR_TOOL_BRAND] === true;
}

/** Stamp the coordinator brand onto a tool definition (or AgentTool). */
export function brandCoordinatorTool<T extends { name: string }>(tool: T): T {
	return Object.assign({}, tool, { [COORDINATOR_TOOL_BRAND]: true });
}
