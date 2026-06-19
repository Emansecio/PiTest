import { describe, expect, it } from "vitest";
import { applyHashlineEdits, computeAnchorIndex } from "../src/core/tools/edit-hashline-diff.ts";

/**
 * When after_hash exists only BEFORE the before_hash window, the old error said
 * "not found — re-read", which is misleading (the anchor is there, just
 * mispositioned) and triggers a sterile retry. The error must now name the real
 * cause and the line where after_hash actually is.
 */
describe("hashline after_hash positioned before before_hash", () => {
	const content = Array.from({ length: 10 }, (_, i) => `line_${i}`).join("\n");
	const index = computeAnchorIndex(content);
	const hashAtLine = (line: number): string => {
		const entry = [...index.entries()].find(([, lines]) => lines.includes(line));
		if (!entry) throw new Error(`no anchor window starts at line ${line}`);
		return entry[0];
	};

	it("reports that after_hash exists but is mispositioned, not 'not found'", () => {
		// before window at line index 5; after window at index 0 (earlier) — invalid.
		const beforeHash = hashAtLine(5);
		const afterHash = hashAtLine(0);
		expect(() =>
			applyHashlineEdits(content, [{ before_hash: beforeHash, after_hash: afterHash, new_text: "X" }], "f.ts"),
		).toThrow(/exists at line\(s\) 1 but at\/before/);
	});

	it("a genuinely absent after_hash still says not found / re-read", () => {
		const beforeHash = hashAtLine(0);
		expect(() =>
			applyHashlineEdits(content, [{ before_hash: beforeHash, after_hash: "deadbeef", new_text: "X" }], "f.ts"),
		).toThrow(/not found.*Re-read/i);
	});
});
