import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import type { AgentTool } from "@pit/agent-core";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { scanSourceFiles } from "./source-scan.js";
import { detectKind, findDeclarationLine } from "./symbol.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const findSymbolSchema = Type.Object(
	{
		name: Type.String({ description: "Symbol name to locate (declaration) across the project." }),
	},
	{ additionalProperties: false },
);

const MAX_LOCATIONS = 30;

// Mirrors symbol.ts SYMBOL_MAX_FILE_BYTES: this tool buffers each source file in
// full to regex one declaration, so a multi-MB minified/generated/vendored source
// would OOM. The scan can hit many such files in one call, so skip anything above
// this cap before readFile to keep peak heap bounded.
const FIND_SYMBOL_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB

// Bound concurrent disk reads so a 2000-file repo isn't serialized one read at a
// time on the agent loop, without fanning out to thousands of open handles.
const READ_CONCURRENCY = 8;

export interface FindSymbolToolOptions {}

export function createFindSymbolToolDefinition(cwd: string): ToolDefinition<typeof findSymbolSchema, undefined> {
	return {
		name: "find_symbol",
		label: "find_symbol",
		activity: "navigation",
		description:
			"Locate where a symbol is DECLARED across the project (cheaper than a blind grep of its name). Returns path:line per declaration. For usages/references, use grep or lsp. Heuristic regex, not AST.",
		promptSnippet: "Find where a named symbol is declared across files.",
		parameters: findSymbolSchema,
		async execute(_toolCallId, { name }, signal) {
			const files = await scanSourceFiles(cwd, { signal });
			// Scan one file: returns its "path:line" hit, or null when no declaration
			// (or the file is unreadable / too large to safely buffer).
			const scanFile = async (file: string): Promise<string | null> => {
				let size: number;
				try {
					size = (await stat(file)).size;
				} catch {
					return null;
				}
				if (size > FIND_SYMBOL_MAX_FILE_BYTES) return null;
				let content: string;
				try {
					content = await readFile(file, "utf8");
				} catch {
					return null;
				}
				const lineIdx = findDeclarationLine(content.split(/\r?\n/), name, detectKind(file));
				return lineIdx >= 0 ? `${relative(cwd, file)}:${lineIdx + 1}` : null;
			};
			// Read with bounded concurrency but emit hits in scan order so output stays
			// deterministic; stop once MAX_LOCATIONS scan-order hits are confirmed.
			const hits: string[] = [];
			for (let base = 0; base < files.length; base += READ_CONCURRENCY) {
				if (signal?.aborted) break;
				const batch = files.slice(base, base + READ_CONCURRENCY);
				const results = await Promise.all(batch.map(scanFile));
				for (const hit of results) {
					if (hit !== null) {
						hits.push(hit);
						if (hits.length >= MAX_LOCATIONS) break;
					}
				}
				if (hits.length >= MAX_LOCATIONS) break;
			}
			const text =
				hits.length > 0
					? `${name} declared at:\n${hits.join("\n")}`
					: `No declaration of "${name}" found. Try grep for usages, or lsp workspace symbols.`;
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	};
}

export function createFindSymbolTool(cwd: string): AgentTool<typeof findSymbolSchema> {
	return wrapToolDefinition(createFindSymbolToolDefinition(cwd));
}
