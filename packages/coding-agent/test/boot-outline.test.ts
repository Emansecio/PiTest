import { describe, expect, it } from "vitest";
import { formatHotFileOutlines } from "../src/core/system-prompt.js";

describe("formatHotFileOutlines", () => {
	it("renders a suffix block of path -> symbols, capped", () => {
		const block = formatHotFileOutlines([{ path: "src/a.ts", symbols: ["alpha", "beta"] }]);
		expect(block).toContain("frequent_files_outline");
		expect(block).toContain("src/a.ts");
		expect(block).toContain("alpha");
	});

	it("returns empty string for no outlines or empty symbols", () => {
		expect(formatHotFileOutlines([])).toBe("");
		expect(formatHotFileOutlines([{ path: "x", symbols: [] }])).toBe("");
	});
});
