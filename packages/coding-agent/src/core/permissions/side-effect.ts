/**
 * Canonical tool side-effect classification for plan-mode gating.
 *
 * `describeToolAction` still maps known built-ins to read/write/exec for path
 * and command deny rules. `ToolSideEffect` closes the gap for `type:"tool"`
 * actions (memory mutators, coordinator tools, extension tools) so plan mode
 * does not silently allow an undeclared mutator.
 */

export type ToolSideEffect = "none" | "workspace" | "agent" | "exec" | "opaque";

/** Side effects that plan mode must block on the defensive `type:"tool"` branch. */
const PLAN_BLOCKING: ReadonlySet<ToolSideEffect> = new Set(["workspace", "agent", "exec", "opaque"]);

export function isPlanBlockingSideEffect(sideEffect: ToolSideEffect | undefined): boolean {
	return sideEffect !== undefined && PLAN_BLOCKING.has(sideEffect);
}

/**
 * Extension / coordinator tools that are not in TOOL_REGISTRY but still need a
 * stable plan-mode classification when the session has not yet refreshed the
 * checker lookup (tests, early init).
 */
export const EXTENSION_TOOL_SIDE_EFFECTS: Readonly<Record<string, ToolSideEffect>> = {
	task: "agent",
	parallel: "agent",
	fanout: "agent",
	exit_plan: "none",
	memory_append: "workspace",
};

/** Default for `registerTool` when the definition omits `sideEffect`. */
export const DEFAULT_REGISTER_TOOL_SIDE_EFFECT: ToolSideEffect = "opaque";
