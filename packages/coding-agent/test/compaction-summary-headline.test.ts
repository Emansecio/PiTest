import { beforeAll, describe, expect, it } from "vitest";
import { createCompactionSummaryMessage } from "../src/core/messages.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

function render(tokensBefore: number, tokensAfter?: number, expanded = false): string {
	const message = createCompactionSummaryMessage("resumo", tokensBefore, new Date().toISOString(), tokensAfter);
	const component = new CompactionSummaryMessageComponent(message, undefined);
	component.setExpanded(expanded);
	return component
		.render(120)
		.map((l) => stripAnsi(l).trimEnd())
		.join("\n");
}

/** `toLocaleString()` groups with `,` or `.` depending on the host locale, so
 * every assertion on a formatted number matches the separator loosely. */
function grouped(...parts: string[]): RegExp {
	return new RegExp(parts.join("[.,\\s  ]"));
}

describe("compaction headline", () => {
	// The before-value alone cannot distinguish a fold that reclaimed 80% from one
	// that reclaimed 8% — both printed the identical "Compacted from N tokens".
	it("reports the delta when the after-size is known", () => {
		const out = render(195_467, 113_204);
		expect(out).toMatch(grouped("195", "467 → 113", "204 tokens"));
		expect(out).toContain("-42%");
	});

	it("makes a near-useless fold visibly near-useless", () => {
		const out = render(195_467, 176_000);
		expect(out).toContain("-10%");
	});

	it("falls back to the original wording when the after-size is absent", () => {
		// A transcript reloaded from disk: tokensAfter is not persisted on the entry.
		const out = render(195_467);
		expect(out).toMatch(grouped("Compacted from 195", "467 tokens"));
		expect(out).not.toContain("→");
	});

	it("keeps the expand hint on the collapsed line", () => {
		expect(render(195_467, 113_204)).toContain("to expand");
	});

	it("uses the same headline when expanded, above the summary", () => {
		const out = render(195_467, 113_204, true);
		expect(out).toMatch(grouped("195", "467 → 113", "204 tokens"));
		expect(out).toContain("resumo");
	});

	it("does not divide by zero on a zero before-size", () => {
		expect(() => render(0, 0)).not.toThrow();
		expect(render(0, 0)).toContain("Compacted from 0 tokens");
	});
});
