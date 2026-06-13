/**
 * MEMORY.md — cross-session persistent knowledge.
 *
 * Discovery order (first match wins per scope; global + project both included):
 *   - <agentDir>/memory/MEMORY.md
 *   - <agentDir>/MEMORY.md
 *   - <cwd>/.<config-dir>/memory/MEMORY.md
 *   - <cwd>/MEMORY.md
 *
 * The discovered files are surfaced as `MemoryFile[]` and injected into the
 * system prompt under <persistent_memory>...</persistent_memory> by the
 * built-in memory extension.
 *
 * Writes happen via the `memory_append` extension tool. We never auto-edit
 * the user's file; the LLM has to explicitly call the tool.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactForDisk } from "../secret-redactor.ts";

export interface MemoryFile {
	scope: "global" | "project";
	path: string;
	content: string;
}

export interface DiscoverMemoryOptions {
	cwd: string;
	agentDir: string;
	configDirName: string;
}

const FILE_NAME = "MEMORY.md";

function readIfExists(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

export function getGlobalMemoryPath(agentDir: string): string {
	return join(agentDir, "memory", FILE_NAME);
}

export function getProjectMemoryPath(cwd: string, configDirName: string): string {
	return join(cwd, configDirName, "memory", FILE_NAME);
}

export function discoverMemoryFiles(options: DiscoverMemoryOptions): MemoryFile[] {
	const { cwd, agentDir, configDirName } = options;
	const files: MemoryFile[] = [];

	const globalCandidates = [getGlobalMemoryPath(agentDir), join(agentDir, FILE_NAME)];
	for (const path of globalCandidates) {
		const content = readIfExists(path);
		if (content !== undefined) {
			files.push({ scope: "global", path, content });
			break;
		}
	}

	const projectCandidates = [getProjectMemoryPath(cwd, configDirName), join(cwd, FILE_NAME)];
	for (const path of projectCandidates) {
		const content = readIfExists(path);
		if (content !== undefined) {
			files.push({ scope: "project", path, content });
			break;
		}
	}

	return files;
}

export function formatMemoryForPrompt(files: readonly MemoryFile[]): string {
	if (files.length === 0) return "";
	const sections = files.map(
		(file) => `<memory_entry scope="${file.scope}" path="${file.path}">\n${file.content}\n</memory_entry>`,
	);
	return `\n\n<persistent_memory>\nLong-lived notes you maintain across sessions. Update with the memory_append tool when you learn something durable.\n\n${sections.join("\n\n")}\n</persistent_memory>\n`;
}

export interface AppendMemoryOptions {
	scope: "global" | "project";
	cwd: string;
	agentDir: string;
	configDirName: string;
	entry: string;
	heading?: string;
}

/**
 * Append a new entry to the appropriate MEMORY.md. Creates the directory and
 * file as needed. Adds a date stamp and optional heading.
 */
export function appendMemory(options: AppendMemoryOptions): { path: string; created: boolean } {
	const path =
		options.scope === "global"
			? getGlobalMemoryPath(options.agentDir)
			: getProjectMemoryPath(options.cwd, options.configDirName);
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const created = !existsSync(path);
	const now = new Date();
	const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const heading = options.heading?.trim();
	const block = heading
		? `\n\n## ${heading} (${stamp})\n${options.entry.trim()}\n`
		: `\n\n- (${stamp}) ${options.entry.trim()}\n`;
	const existing = readIfExists(path) ?? `# Persistent Memory (${options.scope})\n\n`;
	// Redact only the newly appended block on the way to disk: `existing` was
	// already on disk (and already scrubbed if it passed through here), so we
	// avoid re-rewriting the user's prose, and a credential the model put in the
	// new entry never lands verbatim in a pushed file.
	writeFileSync(path, `${existing}${redactForDisk(block)}`, "utf-8");
	return { path, created };
}
