import type { AgentTool } from "@pit/agent-core";
import { Type } from "typebox";
import { getAgentDir } from "../../config.js";
import type { ToolDefinition } from "../extensions/types.js";
import { loadSkills } from "../skills.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const searchSkillsSchema = Type.Object(
	{
		query: Type.String({ description: "Keywords to match against skill names and full descriptions (triggers)." }),
	},
	{ additionalProperties: false },
);

const MAX_RESULTS = 8;

export interface SearchSkillsToolOptions {}

/** Term-overlap score of a query against a skill's name + full description. */
export function scoreSkillForQuery(query: string, name: string, description: string): number {
	const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
	const hay = `${name} ${description}`.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (hay.includes(term)) score++;
	}
	return score;
}

export function createSearchSkillsToolDefinition(cwd: string): ToolDefinition<typeof searchSkillsSchema, undefined> {
	return {
		name: "search_skills",
		label: "search_skills",
		activity: "navigation",
		description:
			"Search installed skills by trigger keyword (covers skills shown only in index form in the prompt). Returns name + location; read the location to load the skill's full instructions.",
		promptSnippet: "Find a skill by trigger keywords.",
		parameters: searchSkillsSchema,
		async execute(_toolCallId, { query }) {
			let skills: Awaited<ReturnType<typeof loadSkills>>["skills"];
			try {
				skills = loadSkills({ cwd, agentDir: getAgentDir() ?? "", skillPaths: [], includeDefaults: true }).skills;
			} catch {
				skills = [];
			}
			const ranked = skills
				.filter((s) => !s.disableModelInvocation)
				.map((s) => ({ s, score: scoreSkillForQuery(query, s.name, s.description) }))
				.filter((r) => r.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, MAX_RESULTS);
			const text =
				ranked.length > 0
					? `Matching skills (read the path to load):\n${ranked.map((r) => `${r.s.name} — ${r.s.filePath}`).join("\n")}`
					: `No installed skill matched "${query}".`;
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	};
}

export function createSearchSkillsTool(cwd: string): AgentTool<typeof searchSkillsSchema> {
	return wrapToolDefinition(createSearchSkillsToolDefinition(cwd));
}
