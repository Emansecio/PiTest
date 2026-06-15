/**
 * Built-in memory extension.
 *
 * Registers:
 *   - `memory_append` tool — appends a new entry to MEMORY.md (project or global)
 *   - `/memory` slash command — opens MEMORY.md in the user's editor
 *
 * Discovery and prompt injection happen via DefaultResourceLoader (so the
 * persistent memory ships as part of the system prompt automatically when
 * the file exists).
 */

import { existsSync, readFileSync } from "node:fs";
import { type Static, Type } from "typebox";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { ExtensionAPI } from "../extensions/types.ts";
import { appendMemory, getGlobalMemoryPath, getProjectMemoryPath } from "../memory/index.ts";

function makeMemoryAppendSchema(configDirName: string) {
	return Type.Object({
		scope: Type.Union([Type.Literal("project"), Type.Literal("global")], {
			description: `Where to store the entry. 'project' = ./${configDirName}/memory/MEMORY.md; 'global' = ~/${configDirName}/agent/memory/MEMORY.md`,
		}),
		entry: Type.String({ description: "Single fact, insight, or convention worth remembering across sessions." }),
		heading: Type.Optional(
			Type.String({ description: "Optional H2 heading for the entry (otherwise rendered as a bullet)." }),
		),
	});
}

type MemoryAppendInput = Static<ReturnType<typeof makeMemoryAppendSchema>>;

export interface MemoryExtensionOptions {
	cwd: string;
	agentDir: string;
}

export function createMemoryExtension(options: MemoryExtensionOptions) {
	return (pi: ExtensionAPI) => {
		const { cwd, agentDir } = options;
		const configDirName = CONFIG_DIR_NAME;

		pi.registerTool({
			name: "memory_append",
			label: "memory",
			description:
				"Append a single durable note to MEMORY.md. Use sparingly for facts that should survive across sessions: conventions, user preferences, project gotchas, or stable architectural decisions. Never store ephemeral state, transient task progress, or anything derivable from git history. The entry is dated automatically.",
			promptSnippet: "Append a durable, cross-session note to MEMORY.md (scope: project | global).",
			parameters: makeMemoryAppendSchema(configDirName),
			async execute(_id, { scope, entry, heading }: MemoryAppendInput) {
				const result = appendMemory({
					scope,
					cwd,
					agentDir,
					configDirName,
					entry,
					heading,
				});
				return {
					content: [
						{
							type: "text" as const,
							text: `${result.created ? "Created" : "Updated"} ${result.path}`,
						},
					],
					details: undefined,
				};
			},
		});

		pi.registerCommand("memory", {
			description: "Show paths and contents of the project and global MEMORY.md files",
			async handler(_args, ctx) {
				const project = getProjectMemoryPath(cwd, configDirName);
				const global = getGlobalMemoryPath(agentDir);
				const lines: string[] = [];
				lines.push(`Project: ${project}${existsSync(project) ? "" : " (not yet created)"}`);
				lines.push(`Global:  ${global}${existsSync(global) ? "" : " (not yet created)"}`);
				if (existsSync(project)) {
					lines.push(`\n--- project memory ---\n${readFileSync(project, "utf-8")}`);
				}
				if (existsSync(global)) {
					lines.push(`\n--- global memory ---\n${readFileSync(global, "utf-8")}`);
				}
				if (ctx.hasUI) {
					ctx.ui.notify(lines.join("\n"), "info");
				} else {
					console.log(lines.join("\n"));
				}
			},
		});
	};
}
