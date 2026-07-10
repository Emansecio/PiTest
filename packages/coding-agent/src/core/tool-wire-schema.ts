/**
 * Wire-minimal tool schemas for provider requests (E1).
 *
 * Full schemas remain on AgentTool for validation; the provider sees compact
 * descriptions and property trees without per-field description prose.
 */

import type { AgentTool } from "@pit/agent-core";
import type { Context, Tool } from "@pit/ai";
import { truncateWithEllipsis } from "../utils/surrogate.ts";
import type { WireToolSurface } from "./compaction/compaction.ts";

/** Max chars for tool descriptions on the provider wire (T01 — was 120). */
export const LAZY_TOOL_DESCRIPTION_MAX_CHARS = 40;

function firstLine(text: string): string {
	const line = text.split("\n")[0]?.trim() ?? "";
	return line;
}

function stripSchemaDescriptions(node: unknown): unknown {
	if (node === null || node === undefined) return node;
	if (Array.isArray(node)) return node.map(stripSchemaDescriptions);
	if (typeof node !== "object") return node;

	const obj = node as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		// Strip schema metadata only — never drop a property literally named
		// "title" (e.g. exit_plan.title). JSON Schema `title` on object nodes is
		// unused in our TypeBox tool schemas, so we do not strip it at all.
		if (key === "description" || key === "$comment") continue;
		out[key] = stripSchemaDescriptions(value);
	}
	return out;
}

/** Compact a JSON-schema payload for wire (strip nested descriptions). */
export function compactToolSchemaForWire(parameters: unknown): unknown {
	return stripSchemaDescriptions(parameters);
}

function compactToolDescription(description: string): string {
	const line = firstLine(description);
	return truncateWithEllipsis(line, LAZY_TOOL_DESCRIPTION_MAX_CHARS);
}

export function compactWireToolSurface(tool: WireToolSurface): WireToolSurface {
	return {
		name: tool.name,
		description: compactToolDescription(tool.description),
		parameters: compactToolSchemaForWire(tool.parameters),
	};
}

export function agentToolToWireSurface(tool: AgentTool): WireToolSurface {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	};
}

export function compactAgentToolForWire(tool: AgentTool): AgentTool {
	return {
		...tool,
		description: compactToolDescription(tool.description),
		parameters: compactToolSchemaForWire(tool.parameters) as AgentTool["parameters"],
	};
}

export function compactAgentToolsForWire(tools: AgentTool[]): AgentTool[] {
	return tools.map(compactAgentToolForWire);
}

export function compactToolsForProviderContext(context: Context): Context {
	if (!context.tools || context.tools.length === 0) return context;
	return {
		...context,
		tools: context.tools.map((tool) => ({
			...tool,
			description: compactToolDescription(tool.description),
			parameters: compactToolSchemaForWire(tool.parameters) as Tool["parameters"],
		})),
	};
}

/** Stable sort for prompt-cache keying on the tools block (E2). */
export function sortToolsForWireCache<T extends { name: string }>(tools: T[]): T[] {
	return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}
