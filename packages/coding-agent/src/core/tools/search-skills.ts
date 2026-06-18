import type { AgentTool } from "@pit/agent-core";
import { Type } from "typebox";
import { getAgentDir } from "../../config.js";
import type { ToolDefinition } from "../extensions/types.js";
import { loadSkills, type Skill } from "../skills.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const searchSkillsSchema = Type.Object(
	{
		query: Type.String({ description: "Keywords to match against skill names and full descriptions (triggers)." }),
	},
	{ additionalProperties: false },
);

const MAX_RESULTS = 8;

export interface SearchSkillsToolOptions {
	/**
	 * Returns the already-loaded skill list (the same set the system prompt is
	 * built from, e.g. `resourceLoader.getSkills().skills`). When provided, the
	 * tool searches this list instead of re-loading from disk, so its results
	 * never diverge from what the prompt advertises. Falls back to a fresh
	 * `loadSkills(...)` when absent or when the getter throws.
	 */
	getSkills?: () => Skill[];
}

/** Weight applied to a query term matching the skill name (vs the description). */
const NAME_MATCH_WEIGHT = 3;

/**
 * Term-overlap score of a query against a skill's name + full description.
 * A term hitting the name is weighted above one hitting only the description,
 * so name matches rank ahead of incidental trigger-text matches.
 */
export function scoreSkillForQuery(query: string, name: string, description: string): number {
	const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
	const nameHay = name.toLowerCase();
	const descHay = description.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (nameHay.includes(term)) score += NAME_MATCH_WEIGHT;
		else if (descHay.includes(term)) score++;
	}
	return score;
}

export function createSearchSkillsToolDefinition(
	cwd: string,
	options?: SearchSkillsToolOptions,
): ToolDefinition<typeof searchSkillsSchema, undefined> {
	const getSkills = options?.getSkills;
	return {
		name: "search_skills",
		label: "search_skills",
		activity: "navigation",
		description:
			"Search installed skills by trigger keyword (covers skills shown only in index form in the prompt). Returns name + location; read the location to load the skill's full instructions.",
		promptSnippet: "Find a skill by trigger keywords.",
		parameters: searchSkillsSchema,
		async execute(_toolCallId, { query }) {
			let skills: Skill[];
			try {
				// Prefer the prompt's own skill list (single source of truth) so
				// search results never diverge from what the prompt advertises.
				// Fall back to a fresh disk load when no getter is wired or it throws.
				skills =
					getSkills?.() ??
					loadSkills({ cwd, agentDir: getAgentDir() ?? "", skillPaths: [], includeDefaults: true }).skills;
			} catch {
				skills = [];
			}
			const ranked = skills
				.filter((s) => !s.disableModelInvocation)
				.map((s) => ({ s, score: scoreSkillForQuery(query, s.name, s.description) }))
				.filter((r) => r.score > 0)
				.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
				.slice(0, MAX_RESULTS);
			const text =
				ranked.length > 0
					? `Matching skills (read the path to load):\n${ranked.map((r) => `${r.s.name} — ${r.s.filePath}`).join("\n")}`
					: `No installed skill matched "${query}".`;
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	};
}

export function createSearchSkillsTool(
	cwd: string,
	options?: SearchSkillsToolOptions,
): AgentTool<typeof searchSkillsSchema> {
	return wrapToolDefinition(createSearchSkillsToolDefinition(cwd, options));
}
