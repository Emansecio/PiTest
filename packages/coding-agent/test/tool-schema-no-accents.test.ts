import { describe, expect, it } from "vitest";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";

// Latin accented letters: À-Ö, Ø-ö, ø-ſ (Latin-1 Supplement letters + Latin
// Extended-A). The two gaps (× at ×, ÷ at ÷) and all typographic
// punctuation from   up (em dash —, ellipsis …, arrow →, bullet •) are
// intentionally NOT matched: those are legitimate in English tool descriptions.
// We only flag accented LETTERS, which in practice means a description slipped
// into Portuguese/another Latin language (guards the bash `timeout` regression).
const ACCENTED_LETTER = /[À-ÖØ-öø-ſ]/;

function collectDescriptions(node: unknown, path: string, out: Array<{ path: string; text: string }>): void {
	if (node === null || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (let i = 0; i < node.length; i++) {
			collectDescriptions(node[i], `${path}[${i}]`, out);
		}
		return;
	}
	for (const [key, value] of Object.entries(node)) {
		if (key === "description" && typeof value === "string") {
			out.push({ path: `${path}.description`, text: value });
		} else {
			collectDescriptions(value, `${path}.${key}`, out);
		}
	}
}

describe("tool schema descriptions stay ASCII (no accented letters)", () => {
	const defs = createAllToolDefinitions(process.cwd());

	for (const [name, def] of Object.entries(defs)) {
		it(`${name}: tool + parameter descriptions are ASCII-only`, () => {
			const descriptions: Array<{ path: string; text: string }> = [];
			if (typeof def.description === "string") {
				descriptions.push({ path: "description", text: def.description });
			}
			collectDescriptions(def.parameters, "parameters", descriptions);

			const offenders = descriptions.filter((d) => ACCENTED_LETTER.test(d.text));
			const report = offenders.map((o) => `  ${o.path}: ${JSON.stringify(o.text)}`).join("\n");
			expect(
				offenders.length,
				`Tool "${name}" has accented (non-ASCII) letters in a model-facing description. ` +
					`Keep tool schemas in English ASCII (typographic punctuation like — … is fine):\n${report}`,
			).toBe(0);
		});
	}
});
