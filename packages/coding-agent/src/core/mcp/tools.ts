/**
 * Wrap MCP tools advertised by an McpManager as Pi `ToolDefinition`s so they
 * can be registered through the standard extension API.
 */

import type { TSchema } from "typebox";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { isJsonCrushEnabled, maybeCrushJsonOutput } from "../tools/json-crush.ts";
import { collapseRepeatedLines, DEFAULT_MAX_BYTES, formatSize, truncateHead } from "../tools/truncate.ts";
import type { McpManager } from "./manager.ts";
import type { McpCallToolResult, McpToolSchema } from "./types.ts";

function safeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Convert MCP JSON Schema (loose) to a Typebox `TSchema`.
 *
 * The MCP server may ship an arbitrary JSON Schema. Pi's tool validator is
 * permissive about extra fields, so we wrap the original schema with
 * `Type.Unsafe` and rely on `prepareArguments` to forward the args unchanged.
 */
function compileMcpSchema(inputSchema: Record<string, unknown> | undefined): TSchema {
	if (!inputSchema || typeof inputSchema !== "object") {
		return Type.Object({}, { additionalProperties: true });
	}
	return Type.Unsafe<Record<string, unknown>>(inputSchema as Record<string, unknown>);
}

interface FlattenedContent {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	isError: boolean;
}

/**
 * Cap an MCP text block before it enters the context. MCP is the only tool-output
 * surface without a built-in ceiling — a single large return (page fetch, SQL
 * dump, network log) would otherwise persist verbatim in every subsequent turn
 * until compaction. Mirror the native tools: collapse identical repeated lines
 * (lossless) then truncate to DEFAULT_MAX_BYTES, exactly like read/grep do. MCP
 * is the surface most likely to return large JSON (API responses, SQL dumps,
 * network logs), so when the output overflows, prefer a structural crush
 * (schema + head/tail samples) over a blind head-cut — exactly like bash/read.
 */
export function capMcpText(text: string): string {
	const collapsed = collapseRepeatedLines(text);
	const truncation = truncateHead(collapsed, { maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return collapsed;
	const crushed = maybeCrushJsonOutput({
		text: collapsed,
		shouldAttempt: isJsonCrushEnabled(),
		recoveryHint: "Refine the query to fetch any elided detail.",
	});
	if (crushed !== undefined) return crushed;
	return `${truncation.content}\n\n[MCP output truncated: ${formatSize(DEFAULT_MAX_BYTES)} limit, ${truncation.totalLines} lines total — refine the query for the rest]`;
}

/**
 * Flatten an MCP tool result into Pi content blocks under an AGGREGATE text
 * budget. Each text/resource block is first capped per-block by capMcpText, but
 * MCP results can carry many blocks; without a shared ceiling, N text blocks
 * would inject N × DEFAULT_MAX_BYTES verbatim (the only tool surface that could
 * blow past the per-tool cap). We debit each capped block's size from a single
 * DEFAULT_MAX_BYTES budget; once it is spent the remaining text/resource blocks
 * are dropped and replaced by one elision marker. The first text/resource block
 * is always emitted (so the common single-block case is byte-identical), and
 * images never count against the text budget nor get elided.
 */
function flattenMcpContent(result: McpCallToolResult): FlattenedContent {
	const isError = result.isError ?? false;
	const blocks: FlattenedContent["content"] = [];
	let remaining = DEFAULT_MAX_BYTES;
	let emittedText = false;
	let elidedCount = 0;
	let elidedBytes = 0;
	for (const block of result.content) {
		if (block.type === "image") {
			blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
			continue;
		}
		let text: string | null = null;
		if (block.type === "text") {
			text = capMcpText(block.text);
		} else if (block.type === "resource" && block.resource.text) {
			text = capMcpText(`[Resource ${block.resource.uri}]\n${block.resource.text}`);
		}
		if (text === null) continue;
		const size = Buffer.byteLength(text, "utf8");
		// Always emit the first text/resource block (keeps the single-block case
		// identical even when its own per-block cap pushes it just past the budget).
		if (!emittedText || size <= remaining) {
			blocks.push({ type: "text", text });
			emittedText = true;
			remaining -= size;
			continue;
		}
		elidedCount += 1;
		elidedBytes += size;
	}
	if (elidedCount > 0) {
		blocks.push({
			type: "text",
			text: `[+${elidedCount} blocos (${formatSize(elidedBytes)}) elididos — refine a query]`,
		});
	}
	if (blocks.length === 0) {
		blocks.push({ type: "text", text: isError ? "Tool reported error with no content." : "(empty response)" });
	}
	return { content: blocks, isError };
}

export function wrapMcpToolAsDefinition(
	manager: McpManager,
	prefixedName: string,
	schema: McpToolSchema,
): ToolDefinition {
	const description = schema.description?.trim().length ? schema.description.trim() : `MCP tool ${schema.name}`;
	const params = compileMcpSchema(schema.inputSchema);
	return {
		name: safeName(prefixedName),
		label: schema.name,
		description,
		parameters: params,
		prepareArguments: (args: unknown) => (args ?? {}) as Record<string, unknown>,
		async execute(_id, providedArgs, signal) {
			const argRecord = (providedArgs ?? {}) as Record<string, unknown>;
			try {
				const result = await manager.callTool(prefixedName, argRecord, signal);
				const { content, isError } = flattenMcpContent(result);
				return { content, isError, details: undefined };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `MCP tool error: ${message}` }],
					isError: true,
					details: undefined,
				};
			}
		},
	};
}
