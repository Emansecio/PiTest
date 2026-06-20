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
		max_files: Type.Optional(Type.Number({ description: "Cap on files scanned (default 1000)." })),
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
			const maxFiles = args.max_files ?? 1000;
			const files = await scanSourceFiles(root, { maxFiles, signal });
			// scanSourceFiles stops silently at maxFiles; surface that so the model does
			// not conclude a symbol is absent merely because its file fell outside the cap.
			const fileCapHit = files.length >= maxFiles;
			const lines: string[] = ["Repo map (heuristic, not AST — verify with read/grep):"];
			let bytes = Buffer.byteLength(lines[0]!, "utf8");
			let byteCapHit = false;
			// Read files in bounded-concurrency batches so disk I/O overlaps on a cold
			// cache (mirrors ls.ts). listDeclarations is pure and the byte-cap check below
			// stays in declaration order, so the output is byte-identical to a serial read.
			const BATCH_SIZE = 24;
			outer: for (let batchStart = 0; batchStart < files.length; batchStart += BATCH_SIZE) {
				if (signal?.aborted) break;
				const batch = files.slice(batchStart, batchStart + BATCH_SIZE);
				const settled = await Promise.allSettled(batch.map((file) => readFile(file, "utf8")));
				for (let i = 0; i < batch.length; i++) {
					if (signal?.aborted) break outer;
					const result = settled[i]!;
					if (result.status !== "fulfilled") continue;
					const file = batch[i]!;
					const names = listDeclarations(result.value, file).map((d) => `${d.kind} ${d.name}:${d.line}`);
					if (names.length === 0) continue;
					const line = `${relative(cwd, file)}: ${names.join(", ")}`;
					bytes += Buffer.byteLength(line, "utf8") + 1;
					if (bytes > MAX_BYTES) {
						byteCapHit = true;
						lines.push("… (truncated: byte limit reached — pass path= to focus on a subdirectory)");
						break outer;
					}
					lines.push(line);
				}
			}
			if (fileCapHit && !byteCapHit) {
				lines.push(
					`… (file cap of ${maxFiles} reached; more files may exist — raise max_files or pass path= to narrow)`,
				);
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: undefined };
		},
	};
}

export function createRepoMapTool(cwd: string): AgentTool<typeof repoMapSchema> {
	return wrapToolDefinition(createRepoMapToolDefinition(cwd));
}
