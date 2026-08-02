/**
 * Per-turn skill router.
 *
 * The base prompt carries only the stable retrieval hint. This extension adds
 * at most three compact skill cards after the dynamic marker when the user's
 * prompt matches a loaded skill, leaving the full instructions on disk for the
 * existing `read`/`search_skills` flow.
 */

import { SYSTEM_PROMPT_DYNAMIC_MARKER } from "@pit/ai";
import type { ExtensionAPI } from "../extensions/index.js";
import { formatSelectedSkillsForPrompt, type Skill, selectSkillsForPrompt } from "../skills.ts";

export function createSkillRoutingExtension(options: { cwd: string; getSkills?: () => Skill[] }) {
	return (pi: ExtensionAPI) => {
		pi.on("before_agent_start", (event) => {
			try {
				const skills = options.getSkills?.() ?? [];
				if (skills.length === 0 || !event.systemPrompt.includes(SYSTEM_PROMPT_DYNAMIC_MARKER)) {
					return undefined;
				}
				const selected = selectSkillsForPrompt(skills, event.prompt, 3);
				if (selected.length === 0) return undefined;
				const cards = formatSelectedSkillsForPrompt(selected, options.cwd);
				return { systemPrompt: `${event.systemPrompt}\n\n${cards}` };
			} catch {
				return undefined;
			}
		});
	};
}
