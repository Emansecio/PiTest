import type { ToolDefinition } from "../../../core/extensions/types.ts";

export type ToolActivity = "navigation" | "action";

/** Resolve a tool's activity family. Defaults to "action" (safe: own line). */
export function toolActivityFamily(def: ToolDefinition<any, any> | undefined): ToolActivity {
	return def?.activity ?? "action";
}
