/**
 * M25a — aggregate project_context cap.
 * Verifies that applyAggregateContextCap() enforces a total char budget
 * across all context files, converting excess files to 1-line read-pointers
 * while leaving files that fit within the budget untouched.
 */
import { describe, expect, it } from "vitest";
import {
	applyAggregateContextCap,
	normalizeProjectContextFiles,
	PROJECT_CONTEXT_AGGREGATE_MAX_CHARS,
} from "../src/core/context-files.js";

describe("applyAggregateContextCap (M25a)", () => {
	it("leaves a single small file unchanged", () => {
		const file = { path: "C:/proj/AGENTS.md", content: "small content" };
		const [out] = applyAggregateContextCap([file], "C:/proj");
		expect(out.content).toBe("small content");
	});

	it("converts a file that alone exceeds the aggregate cap to a pointer", () => {
		const bigContent = "x".repeat(PROJECT_CONTEXT_AGGREGATE_MAX_CHARS + 1);
		const file = { path: "C:/proj/AGENTS.md", content: bigContent };
		const [out] = applyAggregateContextCap([file], "C:/proj");
		expect(out.content).not.toBe(bigContent);
		expect(out.content).toContain("read(");
		expect(out.content).toContain("AGENTS.md");
		expect(out.content).toContain(`${bigContent.length} chars`);
	});

	it("first files get body, files exceeding aggregate become pointers", () => {
		const half = PROJECT_CONTEXT_AGGREGATE_MAX_CHARS / 2;
		const f1 = { path: "C:/proj/AGENTS.md", content: "a".repeat(half) };
		const f2 = { path: "C:/proj/RULES.md", content: "b".repeat(half) };
		const f3 = { path: "C:/proj/EXTRA.md", content: "c".repeat(half) };

		const out = applyAggregateContextCap([f1, f2, f3], "C:/proj");

		// f1 and f2 together fill exactly the budget → both have body content
		expect(out[0].content).toBe(f1.content);
		expect(out[1].content).toBe(f2.content);
		// f3 pushes past the cap → becomes a pointer
		expect(out[2].content).toContain("read(");
		expect(out[2].content).toContain("EXTRA.md");
	});

	it("all files after cap threshold become pointers", () => {
		const fill = "x".repeat(PROJECT_CONTEXT_AGGREGATE_MAX_CHARS + 1);
		const f1 = { path: "C:/proj/BIG.md", content: fill };
		const f2 = { path: "C:/proj/ALSO.md", content: "small" };
		const f3 = { path: "C:/proj/MORE.md", content: "also small" };

		const out = applyAggregateContextCap([f1, f2, f3], "C:/proj");

		// f1 alone exceeds the cap → pointer
		expect(out[0].content).toContain("read(");
		// f2 and f3 are past the cap threshold → also pointers
		expect(out[1].content).toContain("read(");
		expect(out[2].content).toContain("read(");
	});

	it("pointer is exactly 1 line (no embedded newlines)", () => {
		const bigContent = "x".repeat(PROJECT_CONTEXT_AGGREGATE_MAX_CHARS + 1);
		const file = { path: "C:/proj/BIG.md", content: bigContent };
		const [out] = applyAggregateContextCap([file], "C:/proj");
		expect(out.content).not.toContain("\n");
	});

	it("constant PROJECT_CONTEXT_AGGREGATE_MAX_CHARS equals 16000", () => {
		expect(PROJECT_CONTEXT_AGGREGATE_MAX_CHARS).toBe(16_000);
	});
});

describe("normalizeProjectContextFiles aggregate cap integration (M25a)", () => {
	it("total content length is bounded by aggregate cap when N large files are present", () => {
		// Each file is above the per-file inline cap so will be excerpted first,
		// then aggregate cap must still hold.
		const largeContent = "rule line\n".repeat(1500); // > 8000 chars each
		const files = [
			{ path: "C:/proj/A.md", content: largeContent },
			{ path: "C:/proj/B.md", content: largeContent },
			{ path: "C:/proj/C.md", content: largeContent },
		];

		const out = normalizeProjectContextFiles(files, "C:/proj");

		const totalChars = out.reduce((sum, f) => sum + f.content.length, 0);
		// At least one pointer must be present (aggregate would overflow otherwise)
		const hasPointer = out.some((f) => f.content.includes("read(") && f.content.includes("chars"));
		expect(hasPointer).toBe(true);

		// Total inline chars should not exceed aggregate cap + reasonable pointer overhead
		// Pointers are ~1 line each so we allow some slack for the pointer text itself.
		const pointerOverhead = 200 * out.length;
		expect(totalChars).toBeLessThanOrEqual(PROJECT_CONTEXT_AGGREGATE_MAX_CHARS + pointerOverhead);
	});

	it("single small file passes through normalizeProjectContextFiles unchanged", () => {
		const content = "# Project rules\nKeep it simple.\n";
		const [out] = normalizeProjectContextFiles([{ path: "C:/proj/AGENTS.md", content }], "C:/proj");
		expect(out.content).toBe(content);
	});
});
