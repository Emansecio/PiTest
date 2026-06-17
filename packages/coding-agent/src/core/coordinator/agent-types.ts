/**
 * Reusable subagent "types" loaded from Markdown files, mirroring Claude Code's
 * `.claude/agents/*.md`. A type is a curated, versioned preset — system prompt
 * (the file body) plus optional tool subset, model, and thinking level — that the
 * `task` tool can spawn by name via `type: "<name>"` instead of re-specifying
 * everything ad-hoc each call.
 *
 * Discovery: `<cwd>/.pit/agents/*.md` (project) overrides `~/.pit/agents/*.md`
 * (user) on name collision. The file's `name` frontmatter wins; otherwise the
 * basename is used. Malformed files are skipped, never fatal (fail-open).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../../utils/frontmatter.ts";

export interface AgentTypeDef {
	/** Stable identifier referenced by `task({type})`. */
	name: string;
	/** One-line summary, surfaced in the `task` tool description for discovery. */
	description: string;
	/** System prompt for the spawned subagent (the Markdown body). */
	systemPrompt: string;
	/** Optional tool-name subset the subagent may use. */
	tools?: string[];
	/** Optional model pattern (e.g. "haiku", "opus:high"). */
	model?: string;
	/** Optional thinking level (minimal|low|medium|high|xhigh). */
	thinkingLevel?: string;
	/** Where it was loaded from — project overrides user. */
	source: "project" | "user";
}

interface AgentTypeFrontmatter {
	name?: string;
	description?: string;
	tools?: string | string[];
	model?: string;
	thinking?: string;
	[key: string]: unknown;
}

/** Accepts `tools: a, b, c` (string) or a YAML list; trims and drops blanks. */
function parseToolsField(raw: string | string[] | undefined): string[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	const list = Array.isArray(raw) ? raw.map((t) => String(t)) : String(raw).split(",");
	const cleaned = list.map((t) => t.trim()).filter((t) => t.length > 0);
	return cleaned.length > 0 ? cleaned : undefined;
}

function loadDir(dir: string, source: "project" | "user", out: Map<string, AgentTypeDef>): void {
	if (!existsSync(dir)) return;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const fileName of names) {
		if (!fileName.endsWith(".md")) continue;
		const full = join(dir, fileName);
		try {
			if (!statSync(full).isFile()) continue;
			const content = readFileSync(full, "utf8");
			const { frontmatter, body } = parseFrontmatter<AgentTypeFrontmatter>(content);
			const name = (frontmatter.name ?? fileName.replace(/\.md$/, "")).trim();
			if (!name) continue;
			out.set(name, {
				name,
				description: (frontmatter.description ?? "").trim(),
				systemPrompt: body.trim(),
				tools: parseToolsField(frontmatter.tools),
				model: frontmatter.model?.trim() || undefined,
				thinkingLevel: frontmatter.thinking?.trim() || undefined,
				source,
			});
		} catch {
			// Skip an unreadable / malformed agent file — never fatal.
		}
	}
}

/**
 * Loads agent types from `~/.pit/agents` (user) then `<cwd>/.pit/agents`
 * (project), so a project type shadows a user type of the same name. `homeDir`
 * is injectable for tests.
 */
export function loadAgentTypes(cwd: string, homeDir: string = homedir()): AgentTypeDef[] {
	const map = new Map<string, AgentTypeDef>();
	loadDir(join(homeDir, ".pit", "agents"), "user", map);
	loadDir(join(cwd, ".pit", "agents"), "project", map);
	return [...map.values()];
}
