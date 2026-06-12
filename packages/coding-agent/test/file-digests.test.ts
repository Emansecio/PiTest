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

	it("skips the symbol parse for bodies above the size cap", async () => {
		const huge = "export const x = 1;\n".repeat(20000); // > 256 KB
		const digests = await buildFileDigests(["big.ts", "small.ts"], (p) =>
			p === "big.ts" ? huge : "export function keep(){}\n",
		);
		expect(digests["big.ts"]).toBeUndefined(); // over cap → not parsed
		expect(digests["small.ts"]).toContain("keep"); // still digested
	});

	it("honors an already-aborted signal: no reads, empty result", async () => {
		const controller = new AbortController();
		controller.abort();
		let reads = 0;
		const digests = await buildFileDigests(
			["a.ts", "b.ts"],
			() => {
				reads++;
				return "export function f(){}\n";
			},
			controller.signal,
		);
		expect(Object.keys(digests)).toHaveLength(0);
		expect(reads).toBe(0); // short-circuited before reading
	});

	it("preserves input order across concurrent reads", async () => {
		const digests = await buildFileDigests(
			["z.ts", "a.ts", "m.ts"],
			(p) => `export const ${p.replace(".ts", "")} = 1;\n`,
		);
		expect(Object.keys(digests)).toEqual(["z.ts", "a.ts", "m.ts"]);
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
