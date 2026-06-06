import { describe, expect, it } from "vitest";
import { estimateTextTokens } from "../src/core/compaction/compaction.js";
import { crushJson, JSON_CRUSH_TARGET_BYTES } from "../src/core/tools/json-crush.js";

/** Dense token estimate (chars/3.3), the same heuristic compaction uses for tool output. */
function tokens(s: string): number {
	return estimateTextTokens(s, true);
}

const READ_BUDGET = 50 * 1024; // read's blind head-cut byte budget today

// Realistic array-dominated tool outputs (the SmartCrusher sweet spot).
const payloads: Record<string, string> = {
	"gh api issues (array 400)": JSON.stringify(
		Array.from({ length: 400 }, (_, i) => ({
			number: i,
			title: `Issue ${i}: failure in module ${i % 7}`,
			state: i % 3 ? "open" : "closed",
			user: { login: `user${i % 20}` },
			labels: [{ name: "bug" }, { name: `p${i % 3}` }],
			comments: i % 10,
			body: `Repro ${i}. `.repeat(4),
		})),
	),
	"kubectl pods (items[] 400)": JSON.stringify({
		apiVersion: "v1",
		kind: "List",
		items: Array.from({ length: 400 }, (_, i) => ({
			metadata: { name: `pod-${i}`, namespace: i % 2 ? "prod" : "staging" },
			status: { phase: i % 5 ? "Running" : "Pending", restarts: i % 4 },
		})),
	}),
};

describe("json-crush token benchmark (phase 3 sizing)", () => {
	for (const [name, full] of Object.entries(payloads)) {
		it(`reduces tokens vs the blind head-cut: ${name}`, () => {
			const origTok = tokens(full);
			const blindHeadCut = tokens(full.slice(0, READ_BUDGET)); // what read sends today
			const crushed = crushJson(full, { targetChars: JSON_CRUSH_TARGET_BYTES });
			expect(crushed).toBeDefined();
			const crushedTok = tokens(crushed ?? "");

			const pctVsOrig = (100 * (1 - crushedTok / origTok)).toFixed(1);
			const pctVsBlind = (100 * (1 - crushedTok / blindHeadCut)).toFixed(1);
			console.log(
				`[bench] ${name}: ${(full.length / 1024) | 0}KB | original ${origTok} tok | ` +
					`read head-cut(50KB) ${blindHeadCut} tok | crushed ${crushedTok} tok | ` +
					`-${pctVsOrig}% vs original, -${pctVsBlind}% vs blind head-cut`,
			);

			expect(crushedTok).toBeLessThan(blindHeadCut);
			expect(crushedTok).toBeLessThan(origTok);
		});
	}
});
