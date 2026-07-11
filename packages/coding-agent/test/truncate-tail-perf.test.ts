import { describe, expect, it } from "vitest";
import { truncateTail } from "../src/core/tools/truncate.ts";

describe("truncateTail", () => {
	it("keeps the last N lines with byte-identical ordering (push+reverse)", () => {
		const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`);
		const content = lines.join("\n");
		const result = truncateTail(content, { maxLines: 100, maxBytes: 1024 * 1024 });

		expect(result.truncated).toBe(true);
		expect(result.content).toBe(lines.slice(-100).join("\n"));
		expect(result.outputLines).toBe(100);
	});

	it("handles large line counts without quadratic blowup", () => {
		const lines = Array.from({ length: 50_000 }, (_, i) => `L${i}`);
		const content = lines.join("\n");
		const started = performance.now();
		const result = truncateTail(content, { maxLines: 2000, maxBytes: 1024 * 1024 });
		const elapsedMs = performance.now() - started;

		expect(result.truncated).toBe(true);
		expect(result.content.startsWith("L48000") || result.content.includes("L49999")).toBe(true);
		expect(result.content).toContain("L49999");
		expect(result.content).not.toContain("L0\n");
		// O(n) path should finish well under a second even on slow CI.
		expect(elapsedMs).toBeLessThan(2_000);
	});

	it("preserves partial last-line when a single line exceeds maxBytes", () => {
		const huge = `prefix-${"x".repeat(500)}-suffix`;
		const result = truncateTail(huge, { maxLines: 10, maxBytes: 40 });
		expect(result.truncated).toBe(true);
		expect(result.lastLinePartial).toBe(true);
		expect(result.content.endsWith("-suffix")).toBe(true);
		expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(40);
	});
});
