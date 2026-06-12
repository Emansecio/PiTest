import { readFile } from "node:fs/promises";
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
			const hits: string[] = [];
			for (const file of files) {
				if (signal?.aborted) break;
				let content: string;
				try {
					content = await readFile(file, "utf8");
				} catch {
					continue;
				}
				const lineIdx = findDeclarationLine(content.split(/\r?\n/), name, detectKind(file));
				if (lineIdx >= 0) {
					hits.push(`${relative(cwd, file)}:${lineIdx + 1}`);
					if (hits.length >= MAX_LOCATIONS) break;
				}
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
