/**
 * Wrap MCP tools advertised by an McpManager as Pi `ToolDefinition`s so they
 * can be registered through the standard extension API.
 */

import type { TSchema } from "typebox";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { prepareArgsForLooseSchema } from "../tools/argument-prep.ts";
import { isJsonCrushEnabled, maybeCrushJsonOutput } from "../tools/json-crush.ts";
import {
	collapseRepeatedLines,
	DEFAULT_MAX_BYTES,
	formatSize,
	getOccupancyScale,
	truncateHead,
} from "../tools/truncate.ts";
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

/** Per-server output ceiling for browser/devtools MCP servers (verbose DOM/network logs). */
const MCP_CAP_BROWSER_BYTES = 24 * 1024;
/** Per-server output ceiling for filesystem/memory/sqlite MCP servers (larger payloads). */
const MCP_CAP_FILESYSTEM_BYTES = 96 * 1024;

const MCP_CAP_BROWSER_SERVER = /chrome|browser|playwright|puppeteer|devtools/i;
const MCP_CAP_FILESYSTEM_SERVER = /filesystem|fs|memory|sqlite/i;

/**
 * Resolve the byte budget for MCP text output from the server name. Default
 * follows {@link DEFAULT_MAX_BYTES} (context-window scaled at boot); known
 * server families get fixed floors (24KB browser, 96KB filesystem). Occupancy
 * scaling is applied on top so a full context window tightens every MCP cap.
 */
export function resolveMcpCapBytes(serverName?: string): number {
	let baseCap: number;
	if (serverName && MCP_CAP_FILESYSTEM_SERVER.test(serverName)) {
		baseCap = MCP_CAP_FILESYSTEM_BYTES;
	} else if (serverName && MCP_CAP_BROWSER_SERVER.test(serverName)) {
		baseCap = MCP_CAP_BROWSER_BYTES;
	} else {
		baseCap = DEFAULT_MAX_BYTES;
	}
	return Math.max(1, Math.round(baseCap * getOccupancyScale()));
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
export function capMcpText(text: string, serverName?: string): string {
	const maxBytes = resolveMcpCapBytes(serverName);
	const collapsed = collapseRepeatedLines(text);
	const truncation = truncateHead(collapsed, { maxBytes });
	if (!truncation.truncated) return collapsed;
	const crushed = maybeCrushJsonOutput({
		text: collapsed,
		shouldAttempt: isJsonCrushEnabled(),
		recoveryHint: "Refine the query to fetch any elided detail.",
	});
	if (crushed !== undefined) return crushed;
	return `${truncation.content}\n\n[MCP output truncated: ${formatSize(maxBytes)} limit, ${truncation.totalLines} lines total — refine the query for the rest]`;
}

/**
 * Flatten an MCP tool result into Pi content blocks under an AGGREGATE text
 * budget. Each text/resource block is first capped per-block by capMcpText, but
 * MCP results can carry many blocks; without a shared ceiling, N text blocks
 * would inject N × cap verbatim (the only tool surface that could blow past the
 * per-tool cap). We debit each capped block's size from a single server-aware
 * budget; once it is spent the remaining text/resource blocks are dropped and
 * replaced by one elision marker. The first text/resource block
 * is always emitted (so the common single-block case is byte-identical), and
 * images never count against the text budget nor get elided.
 */
function flattenMcpContent(result: McpCallToolResult, serverName?: string): FlattenedContent {
	const isError = result.isError ?? false;
	const blocks: FlattenedContent["content"] = [];
	const aggregateBudget = resolveMcpCapBytes(serverName);
	let remaining = aggregateBudget;
	let emittedText = false;
	let elidedCount = 0;
	let elidedBytes = 0;
	for (const block of result.content ?? []) {
		if (block.type === "image") {
			blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
			continue;
		}
		let text: string | null = null;
		if (block.type === "text") {
			text = capMcpText(block.text, serverName);
		} else if (block.type === "resource" && block.resource.text) {
			text = capMcpText(`[Resource ${block.resource.uri}]\n${block.resource.text}`, serverName);
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
	if (blocks.length === 0 && result.structuredContent !== undefined) {
		// Spec 2025-06-18: a server with an outputSchema may return only
		// `structuredContent` and omit `content[]`. Surface it as serialized JSON.
		let serialized: string;
		try {
			serialized = JSON.stringify(result.structuredContent, null, 2);
		} catch {
			serialized = String(result.structuredContent);
		}
		if (serialized !== undefined) {
			blocks.push({ type: "text", text: capMcpText(serialized, serverName) });
		}
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
	serverName: string,
): ToolDefinition {
	const description = schema.description?.trim().length ? schema.description.trim() : `MCP tool ${schema.name}`;
	const params = compileMcpSchema(schema.inputSchema);
	return {
		name: safeName(prefixedName),
		label: schema.name,
		description,
		parameters: params,
		prepareArguments: (args: unknown) =>
			prepareArgsForLooseSchema(args ?? {}, schema.inputSchema) as Record<string, unknown>,
		async execute(_id, providedArgs, signal) {
			const argRecord = (providedArgs ?? {}) as Record<string, unknown>;
			try {
				const result = await manager.callTool(prefixedName, argRecord, signal);
				const { content, isError } = flattenMcpContent(result, serverName);
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
