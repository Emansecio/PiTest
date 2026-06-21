/**
 * Rebinds the hindsight tools (recall/retain/reflect/forget) in a subagent's
 * tool catalog to a fixed agent scope, so the subagent's memory reads/writes are
 * scoped to its agent type. The scope is baked into per-spawn tool INSTANCES (no
 * module global) so parallel subagents of different types never race.
 */

import type { AgentTool } from "@pit/agent-core";
import { createForgetTool } from "./forget.ts";
import { createRecallTool } from "./recall.ts";
import { createReflectTool } from "./reflect.ts";
import { createRetainTool } from "./retain.ts";

const HINDSIGHT_TOOL_NAMES = new Set(["recall", "retain", "reflect", "forget"]);

/**
 * Replace any hindsight tool already in `tools` with a scope-bound instance.
 * When `autoAdd` is true (the type declared `memory: true`), also append scoped
 * recall+retain+reflect if absent. No-op when `scope` is undefined.
 */
export function withAgentScope(
	tools: AgentTool[],
	scope: string | undefined,
	cwd: string,
	autoAdd = false,
): AgentTool[] {
	if (!scope) return tools;
	const scoped = tools.map((tool) =>
		HINDSIGHT_TOOL_NAMES.has(tool.name) ? (makeScoped(tool.name, cwd, scope) ?? tool) : tool,
	);
	if (autoAdd) {
		const present = new Set(scoped.map((t) => t.name));
		for (const name of ["recall", "retain", "reflect"]) {
			if (!present.has(name)) {
				const made = makeScoped(name, cwd, scope);
				if (made) scoped.push(made);
			}
		}
	}
	return scoped;
}

function makeScoped(name: string, cwd: string, scope: string): AgentTool | undefined {
	if (name === "recall") return createRecallTool(cwd, { agentScope: scope });
	if (name === "retain") return createRetainTool(cwd, { agentScope: scope });
	if (name === "reflect") return createReflectTool(cwd, { agentScope: scope });
	if (name === "forget") return createForgetTool(cwd, { agentScope: scope });
	return undefined;
}
