import { sliceSafe } from "../../utils/surrogate.ts";

export interface GoalCriterion {
	id: string;
	text: string;
}

export interface GoalContract {
	version: 1;
	revision: number;
	source: "explicit-list" | "whole-objective" | "legacy-restore";
	criteria: GoalCriterion[];
}

export const MAX_GOAL_CRITERIA = 16;
const HEADER = /^(?:requisitos|critérios? de aceite|acceptance criteria|requirements)\s*:??$/i;

function itemsFromLines(lines: string[]): string[] {
	return lines
		.map((line) => line.trim())
		.map((line) =>
			line
				.replace(/^[-*+]\s+/, "")
				.replace(/^\d+[.)]\s+/, "")
				.replace(/^\[[ xX]\]\s*/, "")
				.trim(),
		)
		.filter(Boolean);
}

export function deriveGoalContract(objective: string, revision = 1, source?: GoalContract["source"]): GoalContract {
	const original = sliceSafe(objective.trim(), 0, 4000);
	const lines = original.replace(/\r\n?/g, "\n").split("\n");
	const checkboxes = itemsFromLines(lines.filter((line) => /^\s*[-*+]?\s*\[[ xX]\]\s+\S/.test(line)));
	let criteria = checkboxes;
	let selectedSource: GoalContract["source"] = source ?? "whole-objective";
	if (criteria.length === 0) {
		const headerIndex = lines.findIndex((line) => HEADER.test(line.trim()));
		if (headerIndex >= 0) {
			const section: string[] = [];
			for (const line of lines.slice(headerIndex + 1)) {
				if (/^\s*#{1,6}\s+/.test(line) || (/\S/.test(line) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(line))) break;
				section.push(line);
			}
			criteria = itemsFromLines(section.filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line)));
			selectedSource = source ?? "explicit-list";
		}
	}
	if (criteria.length === 0) {
		criteria = itemsFromLines(lines.filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)));
		if (criteria.length >= 2) selectedSource = source ?? "explicit-list";
		else criteria = [];
	}
	if (criteria.length === 0 || criteria.length > MAX_GOAL_CRITERIA) {
		criteria = [original];
		selectedSource = source ?? "whole-objective";
	}
	return {
		version: 1,
		revision: Math.max(1, Math.floor(revision)),
		source: selectedSource,
		criteria: criteria.map((text, i) => ({ id: `c${i + 1}`, text })),
	};
}

export function renderGoalContract(contract: GoalContract, status: string, objective: string): string {
	const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const renderedCriteria = contract.criteria.map((criterion) => {
		const text = criterion.text.trim() === objective.trim() ? "Complete the objective above." : criterion.text;
		return `[${criterion.id}] ${escapeText(text)}`;
	});
	return `<goal status="${escapeText(status)}" contract_revision="${contract.revision}">\nObjetivo: ${escapeText(objective)}\n${renderedCriteria.join("\n")}\n</goal>`;
}
