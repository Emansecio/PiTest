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

/**
 * Max chars for a FALLBACK wire description — the tool's own first line, cut
 * mechanically. Used only when a tool ships no `promptSnippet` (MCP tools,
 * extension/SDK tools, plain AgentTool overrides).
 *
 * Two levels by design (T01): a `promptSnippet` is a complete, hand-written
 * sentence and ships whole (up to {@link WIRE_TOOL_SNIPPET_MAX_CHARS}), while a
 * first line has to be cut somewhere. At the original 40 chars nearly all ~64
 * built-ins reached the model mid-word ("Read the contents of a file. Supports
 * te…"), a plausible misfire source — and a misfire costs a whole round-trip,
 * far more than the chars saved. 110 keeps the cut off the middle of a phrase
 * for realistic first lines; the extra chars land in the CACHED prefix, so they
 * are paid once per session, not per turn.
 */
export const LAZY_TOOL_DESCRIPTION_MAX_CHARS = 110;

/**
 * Defensive ceiling for a hand-written `promptSnippet` on the wire (T01).
 * Snippets are short by design (the longest built-in is ~112 chars), so this is
 * a seatbelt against an extension shipping a paragraph as its "snippet", not a
 * budget anyone is expected to hit.
 */
export const WIRE_TOOL_SNIPPET_MAX_CHARS = 140;

const compactProviderToolsCache = new WeakMap<NonNullable<Context["tools"]>, NonNullable<Context["tools"]>>();

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

/** Collapse a snippet to one line of single-spaced text (it is prose, not code). */
function normalizeSnippet(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * The description a tool ships with on the wire.
 *
 * Prefers the hand-written `promptSnippet` — a complete sentence authored to
 * summarize the tool, already used by the system prompt's `Available tools`
 * section — and only falls back to cutting the long description's first line
 * when there is none.
 */
function compactToolDescription(description: string, promptSnippet?: string): string {
	const snippet = promptSnippet ? normalizeSnippet(promptSnippet) : "";
	if (snippet) return truncateWithEllipsis(snippet, WIRE_TOOL_SNIPPET_MAX_CHARS);
	return truncateWithEllipsis(firstLine(description), LAZY_TOOL_DESCRIPTION_MAX_CHARS);
}

/** Read the `promptSnippet` passthrough attached by `wrapToolDefinition`. */
function toolPromptSnippet(tool: object): string | undefined {
	return (tool as { promptSnippet?: unknown }).promptSnippet as string | undefined;
}

export function compactWireToolSurface(tool: WireToolSurface): WireToolSurface {
	return {
		name: tool.name,
		// Snippet folded into `description`; the compacted surface carries no
		// separate `promptSnippet` so size estimates never count it twice.
		description: compactToolDescription(tool.description, tool.promptSnippet),
		parameters: compactToolSchemaForWire(tool.parameters),
	};
}

export function agentToolToWireSurface(tool: AgentTool): WireToolSurface {
	const promptSnippet = toolPromptSnippet(tool);
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(promptSnippet ? { promptSnippet } : {}),
	};
}

export function compactAgentToolForWire(tool: AgentTool): AgentTool {
	return {
		...tool,
		description: compactToolDescription(tool.description, toolPromptSnippet(tool)),
		parameters: compactToolSchemaForWire(tool.parameters) as AgentTool["parameters"],
	};
}

export function compactAgentToolsForWire(tools: AgentTool[]): AgentTool[] {
	return tools.map(compactAgentToolForWire);
}

export function compactToolsForProviderContext(context: Context): Context {
	if (!context.tools || context.tools.length === 0) return context;
	let tools = compactProviderToolsCache.get(context.tools);
	if (!tools) {
		// `context.tools` is the live AgentTool array (agent.ts passes state.tools
		// straight through), so the `promptSnippet` passthrough is present here even
		// though the provider-facing `Tool` type does not declare it.
		tools = context.tools.map((tool) => ({
			...tool,
			description: compactToolDescription(tool.description, toolPromptSnippet(tool)),
			parameters: compactToolSchemaForWire(tool.parameters) as Tool["parameters"],
		}));
		compactProviderToolsCache.set(context.tools, tools);
	}
	return {
		...context,
		tools,
	};
}
