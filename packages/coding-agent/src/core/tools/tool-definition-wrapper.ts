import type { AgentTool, AgentToolResult } from "@pit/agent-core";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { formatSize, TOOL_OUTPUT_HARD_CAP_BYTES, truncateHead } from "./truncate.ts";

/**
 * Safety net: cap any text block in a tool result that exceeds
 * TOOL_OUTPUT_HARD_CAP_BYTES. Applied uniformly to every wrapped tool so a tool
 * with no truncation of its own (many extensions, some MCP returns) can never
 * flood the context. The ceiling sits above the 50KB per-tool cap, so tools that
 * already truncate keep their own (more specific) note untouched.
 */
function capToolOutputBytes<TDetails>(result: AgentToolResult<TDetails>): AgentToolResult<TDetails> {
	const content = result?.content;
	if (!Array.isArray(content)) return result;
	let changed = false;
	const capped = content.map((block) => {
		if (block.type !== "text" || typeof block.text !== "string") return block;
		// Byte-only ceiling: pass maxLines=Infinity so tools that legitimately
		// return many lines (e.g. `read` showing its own 2000-line page) are never
		// re-cut by the default line limit — this net is purely about raw bytes.
		const truncation = truncateHead(block.text, {
			maxBytes: TOOL_OUTPUT_HARD_CAP_BYTES,
			maxLines: Number.POSITIVE_INFINITY,
		});
		if (!truncation.truncated) return block;
		changed = true;
		return {
			...block,
			text: `${truncation.content}\n\n[tool output exceeded ${formatSize(TOOL_OUTPUT_HARD_CAP_BYTES)} and was truncated (${truncation.totalLines} lines total)]`,
		};
	});
	return changed ? { ...result, content: capped } : result;
}

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) =>
			capToolOutputBytes(
				await definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.() as ExtensionContext),
			),
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
