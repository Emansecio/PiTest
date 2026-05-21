import { describe, expect, it } from "vitest";
import { extractErrorMessage, fingerprintToolArgs, ToolCallStats } from "../src/core/tool-call-stats.js";

describe("ToolCallStats.record", () => {
	it("counts calls and errors per tool", () => {
		const stats = new ToolCallStats();
		stats.record("read", false);
		stats.record("read", false);
		stats.record("read", true, "boom");
		stats.record("edit", true, "no match");

		const snapshot = stats.snapshot();
		const read = snapshot.find((s) => s.tool === "read");
		expect(read).toMatchObject({ tool: "read", calls: 3, errors: 1, errorRate: 1 / 3 });
		expect(read?.topErrors[0]?.message).toBe("boom");
		const edit = snapshot.find((s) => s.tool === "edit");
		expect(edit).toMatchObject({ tool: "edit", calls: 1, errors: 1, errorRate: 1 });
	});

	it("sorts tools by descending error count then call count", () => {
		const stats = new ToolCallStats();
		stats.record("a", false);
		stats.record("a", false);
		stats.record("b", true, "x");
		stats.record("b", true, "x");
		stats.record("c", true, "y");

		const snapshot = stats.snapshot();
		expect(snapshot.map((s) => s.tool)).toEqual(["b", "c", "a"]);
	});

	it("collapses similar errors via fingerprint normalization", () => {
		const stats = new ToolCallStats();
		// Same error shape, only numerics differ — should fold into one bucket.
		stats.record("read", true, "validation failed at line 12 column 4");
		stats.record("read", true, "validation failed at line 99 column 7");
		const snapshot = stats.snapshot();
		expect(snapshot[0].topErrors).toHaveLength(1);
		expect(snapshot[0].topErrors[0].count).toBe(2);
	});

	it("caps fingerprint variety per tool and routes overflow to <other>", () => {
		const stats = new ToolCallStats({ maxErrorFingerprintsPerTool: 2 });
		stats.record("read", true, "a");
		stats.record("read", true, "b");
		stats.record("read", true, "c");
		stats.record("read", true, "d");
		const top = stats.snapshot()[0].topErrors;
		const other = top.find((t) => t.message === "<other>");
		expect(other?.count).toBe(2);
	});

	it("reset wipes all buckets", () => {
		const stats = new ToolCallStats();
		stats.record("read", true, "boom");
		stats.reset();
		expect(stats.snapshot()).toEqual([]);
	});
});

describe("ToolCallStats.recordInvocation (doom-loop)", () => {
	it("reports 0 consecutive on empty sequence", () => {
		const stats = new ToolCallStats();
		expect(stats.getConsecutiveSimilarCount()).toBe(0);
		expect(stats.isInDoomLoop()).toBe(false);
	});

	it("counts trailing identical (tool,args) calls", () => {
		const stats = new ToolCallStats({ doomLoopThreshold: 3 });
		stats.recordInvocation("read", '{"path":"a.ts"}');
		stats.recordInvocation("read", '{"path":"a.ts"}');
		stats.recordInvocation("read", '{"path":"a.ts"}');
		expect(stats.getConsecutiveSimilarCount()).toBe(3);
		expect(stats.isInDoomLoop()).toBe(true);
	});

	it("resets streak when args differ", () => {
		const stats = new ToolCallStats({ doomLoopThreshold: 3 });
		stats.recordInvocation("read", '{"path":"a.ts"}');
		stats.recordInvocation("read", '{"path":"a.ts"}');
		stats.recordInvocation("read", '{"path":"b.ts"}');
		expect(stats.getConsecutiveSimilarCount()).toBe(1);
		expect(stats.isInDoomLoop()).toBe(false);
	});

	it("resets streak when tool name differs", () => {
		const stats = new ToolCallStats({ doomLoopThreshold: 2 });
		stats.recordInvocation("read", "{}");
		stats.recordInvocation("read", "{}");
		stats.recordInvocation("edit", "{}");
		expect(stats.getConsecutiveSimilarCount()).toBe(1);
	});

	it("bounds window size via sequenceWindow", () => {
		const stats = new ToolCallStats({ sequenceWindow: 3 });
		stats.recordInvocation("read", "a");
		stats.recordInvocation("read", "a");
		stats.recordInvocation("read", "a");
		stats.recordInvocation("read", "a");
		expect(stats.getSequence().length).toBe(3);
	});

	it("reset clears the sequence window too", () => {
		const stats = new ToolCallStats();
		stats.recordInvocation("read", "a");
		stats.recordInvocation("read", "a");
		stats.reset();
		expect(stats.getConsecutiveSimilarCount()).toBe(0);
		expect(stats.getSequence()).toEqual([]);
	});

	it("resetSequence wipes only the window, preserving call counts", () => {
		const stats = new ToolCallStats();
		stats.record("read", false);
		stats.recordInvocation("read", "a");
		stats.recordInvocation("read", "a");
		stats.resetSequence();
		expect(stats.getSequence()).toEqual([]);
		expect(stats.getConsecutiveSimilarCount()).toBe(0);
		expect(stats.snapshot()[0]?.calls).toBe(1);
	});

	it("accepts an explicit threshold override", () => {
		const stats = new ToolCallStats({ doomLoopThreshold: 10 });
		stats.recordInvocation("read", "a");
		stats.recordInvocation("read", "a");
		expect(stats.isInDoomLoop()).toBe(false);
		expect(stats.isInDoomLoop(2)).toBe(true);
	});
});

describe("fingerprintToolArgs", () => {
	it("produces stable output regardless of key order", () => {
		expect(fingerprintToolArgs({ a: 1, b: 2 })).toBe(fingerprintToolArgs({ b: 2, a: 1 }));
	});

	it("caps length and appends ellipsis", () => {
		const long = "x".repeat(500);
		const fp = fingerprintToolArgs({ data: long }, 50);
		expect(fp.length).toBeLessThanOrEqual(51);
		expect(fp.endsWith("…")).toBe(true);
	});

	it("survives cyclic references via fallback", () => {
		const a: Record<string, unknown> = { name: "root" };
		a.self = a;
		const fp = fingerprintToolArgs(a);
		expect(fp).toContain("Circular");
	});

	it("handles primitives", () => {
		expect(fingerprintToolArgs(42)).toBe("42");
		expect(fingerprintToolArgs(null)).toBe("null");
		expect(fingerprintToolArgs("hi")).toBe('"hi"');
	});
});

describe("extractErrorMessage", () => {
	it("joins text parts", () => {
		expect(
			extractErrorMessage([
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
				{ type: "image" },
			] as any),
		).toBe("first\nsecond");
	});

	it("returns undefined when no text", () => {
		expect(extractErrorMessage([{ type: "image" }] as any)).toBeUndefined();
		expect(extractErrorMessage(undefined)).toBeUndefined();
	});
});
