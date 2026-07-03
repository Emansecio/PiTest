/**
 * Rebinds the hindsight tools (recall/retain/reflect/forget) in a subagent's
 * tool catalog to a fixed agent scope, so the subagent's memory reads/writes are
 * scoped to its agent type. The scope is baked into per-spawn tool INSTANCES (no
 * module global) so parallel subagents of different types never race.
 */

import type { AgentTool } from "@pit/agent-core";
import type { HindsightBank } from "../hindsight/index.ts";
import { createForgetTool } from "./forget.ts";
import { hindsightToolNames } from "./index.ts";
import { createRecallTool } from "./recall.ts";
import { createReflectTool } from "./reflect.ts";
import { createRetainTool } from "./retain.ts";

// Single source of truth is the registry's `hindsight` gate (index.ts) — keeps
// this list from drifting the way the TUI/discovery-seed lists once did.
const HINDSIGHT_TOOL_NAMES = new Set<string>(hindsightToolNames);

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
	/** Preserve a bank override (e.g. an injected test double) across the rebind. */
	bank?: HindsightBank,
): AgentTool[] {
	if (!scope) return tools;
	const scoped = tools.map((tool) =>
		HINDSIGHT_TOOL_NAMES.has(tool.name) ? (makeScoped(tool.name, cwd, scope, bank) ?? tool) : tool,
	);
	if (autoAdd) {
		const present = new Set(scoped.map((t) => t.name));
		// Intentionally recall/retain/reflect only, NOT forget: a `memory: true`
		// agent type gets read/write/search by default, not delete — matching the
		// explicit allowlist coordinator-extension.ts builds for the same flag
		// (`["recall", "retain", "reflect"]`) and the doc comment on
		// AgentType.memory in coordinator/agent-types.ts. Least-privilege by
		// design, not an oversight.
		for (const name of ["recall", "retain", "reflect"]) {
			if (!present.has(name)) {
				const made = makeScoped(name, cwd, scope, bank);
				if (made) scoped.push(made);
			}
		}
	}
	return scoped;
}

function makeScoped(name: string, cwd: string, scope: string, bank?: HindsightBank): AgentTool | undefined {
	if (name === "recall") return createRecallTool(cwd, { agentScope: scope, bank });
	if (name === "retain") return createRetainTool(cwd, { agentScope: scope, bank });
	if (name === "reflect") return createReflectTool(cwd, { agentScope: scope, bank });
	if (name === "forget") return createForgetTool(cwd, { agentScope: scope, bank });
	return undefined;
}
