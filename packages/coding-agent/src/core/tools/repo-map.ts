import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AgentTool } from "@pit/agent-core";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { scanSourceFiles } from "./source-scan.js";
import { listDeclarations } from "./symbol.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const repoMapSchema = Type.Object(
	{
		path: Type.Optional(Type.String({ description: "Subdirectory to map (default: project root)." })),
		max_files: Type.Optional(Type.Number({ description: "Cap on files scanned (default 200)." })),
	},
	{ additionalProperties: false },
);

const MAX_BYTES = 50 * 1024;

export interface RepoMapToolOptions {}

export function createRepoMapToolDefinition(cwd: string): ToolDefinition<typeof repoMapSchema, undefined> {
	return {
		name: "repo_map",
		label: "repo_map",
		activity: "navigation",
		description:
			"Project skeleton: one line per file with its top-level symbol names (no bodies). Heuristic outline for orienting in an unfamiliar repo — verify with read/grep before editing.",
		promptSnippet: "Outline the repo's top-level symbols per file (no bodies).",
		parameters: repoMapSchema,
		async execute(_toolCallId, args, signal) {
			const root = args.path ? join(cwd, args.path) : cwd;
			const files = await scanSourceFiles(root, { maxFiles: args.max_files ?? 200, signal });
			const lines: string[] = ["Repo map (heuristic, not AST — verify with read/grep):"];
			let bytes = lines[0]!.length;
			for (const file of files) {
				if (signal?.aborted) break;
				let content: string;
				try {
					content = await readFile(file, "utf8");
				} catch {
					continue;
				}
				const names = listDeclarations(content, file).map((d) => d.name);
				if (names.length === 0) continue;
				const line = `${relative(cwd, file)}: ${names.join(", ")}`;
				bytes += line.length + 1;
				if (bytes > MAX_BYTES) {
					lines.push("… (truncated)");
					break;
				}
				lines.push(line);
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: undefined };
		},
	};
}

export function createRepoMapTool(cwd: string): AgentTool<typeof repoMapSchema> {
	return wrapToolDefinition(createRepoMapToolDefinition(cwd));
}
