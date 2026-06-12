import { describe, expect, it } from "vitest";
import { buildFileDigests, formatFileDigests } from "../src/core/compaction/file-digests.js";

describe("buildFileDigests", () => {
	it("derives a symbol digest per readable source file", async () => {
		const digests = await buildFileDigests(["a.ts"], (p) =>
			p === "a.ts" ? "export function f(){}\nexport class C{}\n" : null,
		);
		expect(digests["a.ts"]).toContain("f");
		expect(digests["a.ts"]).toContain("C");
	});

	it("skips files that fail to read", async () => {
		const digests = await buildFileDigests(["missing.ts"], () => null);
		expect(Object.keys(digests)).toHaveLength(0);
	});
});

describe("formatFileDigests", () => {
	it("renders a file-digests block, empty string when no digests", () => {
		expect(formatFileDigests({})).toBe("");
		const block = formatFileDigests({ "a.ts": "f, C" });
		expect(block).toContain("file-digests");
		expect(block).toContain("a.ts: f, C");
	});
});
