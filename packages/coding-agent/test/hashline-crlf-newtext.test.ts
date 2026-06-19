import { describe, expect, it } from "vitest";
import { applyHashlineEdits, computeAnchorIndex } from "../src/core/tools/edit-hashline-diff.ts";

/**
 * Regression for #5: edit_v2 (applyHashlineEdits) must normalize new_text to LF
 * before splitting. Otherwise a new_text carrying CRLF leaves a stray \r at the
 * end of each inserted line, which restoreLineEndings later turns into \r\r\n,
 * corrupting CRLF files.
 */
describe("hashline new_text CRLF normalization", () => {
	const content = Array.from({ length: 10 }, (_, i) => `line_${i}`).join("\n");
	const index = computeAnchorIndex(content);
	const hashAtLine = (line: number): string => {
		const entry = [...index.entries()].find(([, lines]) => lines.includes(line));
		if (!entry) throw new Error(`no anchor window starts at line ${line}`);
		return entry[0];
	};

	it("strips CR from CRLF new_text so no stray \\r survives in the result", () => {
		const beforeHash = hashAtLine(0);
		const afterHash = hashAtLine(5);
		const { newContent } = applyHashlineEdits(
			content,
			[{ before_hash: beforeHash, after_hash: afterHash, new_text: "alpha\r\nbeta" }],
			"f.ts",
		);
		expect(newContent.includes("\r")).toBe(false);
		expect(newContent.split("\n")).toContain("alpha");
		expect(newContent.split("\n")).toContain("beta");
	});
});
