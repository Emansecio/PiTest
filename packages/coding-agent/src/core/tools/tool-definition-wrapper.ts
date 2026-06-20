import type { AgentTool, AgentToolResult } from "@pit/agent-core";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { formatSize, TOOL_OUTPUT_HARD_CAP_BYTES, truncateHead, truncateHeadTail } from "./truncate.ts";

/**
 * Per-definition override for the generic output cap.
 * - `maxBytes`: ceiling for this tool's text blocks (replaces the 64KB default).
 * - `mode`: "head" keeps the first bytes (default behaviour); "headTail" keeps
 *   the first AND last bytes, eliding the middle (so a recalled output never loses
 *   its tail — error/stack/final status).
 *
 * Opt-in is structural: a definition object may carry an `outputCap` field without
 * the shared `ToolDefinition` interface declaring it, so only the recall tool pays
 * for it and every other tool keeps the 64KB head-only net unchanged.
 */
export interface OutputCapConfig {
	maxBytes: number;
	mode: "head" | "headTail";
}

/** Definitions may opt into a custom output cap by carrying this field. */
type WithOutputCap = { outputCap?: OutputCapConfig };

/**
 * Attach a custom output cap to a tool definition (opt-in to {@link capToolOutputBytes}).
 * Returns the same definition typed with the extra field so call sites stay clean
 * and the shared ToolDefinition interface does not need to know about it.
 */
export function withOutputCap<T extends ToolDefinition<any, any>>(definition: T, cap: OutputCapConfig): T {
	return Object.assign(definition, { outputCap: cap });
}

/**
 * Safety net: cap any text block in a tool result that exceeds the cap. By default
 * this is TOOL_OUTPUT_HARD_CAP_BYTES (64KB) applied head-only and uniformly to
 * every wrapped tool, so a tool with no truncation of its own (many extensions,
 * some MCP returns) can never flood the context. The default ceiling sits above
 * the 50KB per-tool cap, so tools that already truncate keep their own (more
 * specific) note untouched.
 *
 * A definition may carry an `outputCap` override (see {@link withOutputCap}) to
 * raise the ceiling and/or switch to head+tail truncation — used by
 * `recall_tool_output`, where a head-only re-cut would drop the recalled tail.
 */
function capToolOutputBytes<TDetails>(
	result: AgentToolResult<TDetails>,
	cap?: OutputCapConfig,
): AgentToolResult<TDetails> {
	const content = result?.content;
	if (!Array.isArray(content)) return result;
	const maxBytes = cap?.maxBytes ?? TOOL_OUTPUT_HARD_CAP_BYTES;
	const mode = cap?.mode ?? "head";
	let changed = false;
	const capped = content.map((block) => {
		if (block.type !== "text" || typeof block.text !== "string") return block;
		if (mode === "headTail") {
			// Keep head AND tail within the dedicated cap, eliding only the middle.
			const ht = truncateHeadTail(block.text, { maxBytes });
			if (!ht.truncated) return block;
			changed = true;
			return {
				...block,
				text: `${ht.content}\n\n[tool output exceeded ${formatSize(maxBytes)}; kept head + tail (${ht.totalLines} lines total)]`,
			};
		}
		// Byte-only head ceiling: pass maxLines=Infinity so tools that legitimately
		// return many lines (e.g. `read` showing its own 2000-line page) are never
		// re-cut by the default line limit — this net is purely about raw bytes.
		const truncation = truncateHead(block.text, {
			maxBytes,
			maxLines: Number.POSITIVE_INFINITY,
		});
		if (!truncation.truncated) return block;
		changed = true;
		return {
			...block,
			text: `${truncation.content}\n\n[tool output exceeded ${formatSize(maxBytes)} and was truncated (${truncation.totalLines} lines total)]`,
		};
	});
	return changed ? { ...result, content: capped } : result;
}

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	const outputCap = (definition as WithOutputCap).outputCap;
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
				outputCap,
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
