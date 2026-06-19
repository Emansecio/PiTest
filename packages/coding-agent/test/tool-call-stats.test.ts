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

describe("ToolCallStats.getConsecutiveSimilarResultOnlyCount (result-only thrash loop)", () => {
	it("counts trailing same-error results even when args differ every call", () => {
		const stats = new ToolCallStats();
		for (let i = 0; i < 4; i++) {
			// DIFFERENT args each call (shifted offset) ...
			stats.recordInvocation("edit", `{"offset":${i}}`);
			// ... but the SAME error result.
			stats.recordInvocationResult("ERR", true);
		}
		expect(stats.getConsecutiveSimilarResultOnlyCount()).toBe(4);
		// The args-keyed result count resets each call because the args differ.
		expect(stats.getConsecutiveSimilarResultCount()).toBe(1);
	});

	it("returns 0 when the last result is a success (a run of successes is progress)", () => {
		const stats = new ToolCallStats();
		for (let i = 0; i < 4; i++) {
			stats.recordInvocation("read", `{"path":"f${i}"}`);
			stats.recordInvocationResult("OK", false);
		}
		expect(stats.getConsecutiveSimilarResultOnlyCount()).toBe(0);
	});

	it("resets the run when the result hash changes mid-stream", () => {
		const stats = new ToolCallStats();
		stats.recordInvocation("edit", "a");
		stats.recordInvocationResult("ERR", true);
		stats.recordInvocation("edit", "b");
		stats.recordInvocationResult("ERR", true);
		stats.recordInvocation("edit", "c");
		stats.recordInvocationResult("OTHER", true);
		stats.recordInvocation("edit", "d");
		stats.recordInvocationResult("OTHER", true);
		// Trailing run of the last hash ("OTHER") is 2; the earlier "ERR" pair is a
		// different hash and stops the count.
		expect(stats.getConsecutiveSimilarResultOnlyCount()).toBe(2);
	});

	it("is 0 on an empty window", () => {
		expect(new ToolCallStats().getConsecutiveSimilarResultOnlyCount()).toBe(0);
	});
});

describe("ToolCallStats parallel result stamping by toolCallId (#12/#34)", () => {
	it("stamps each parallel call's result onto its own ring entry, not ringHead-1", () => {
		const stats = new ToolCallStats();
		// Four identical parallel batches: each batch records BOTH starts first, then
		// the ends fire in completion order (here: second tool finishes before first).
		for (let b = 0; b < 4; b++) {
			stats.recordInvocation("read", '{"path":"a"}', `call-${b}-A`);
			stats.recordInvocation("read", '{"path":"a"}', `call-${b}-B`);
			// ends out of order: B (last pushed) then A (first pushed).
			stats.recordInvocationResult("RES", false, `call-${b}-B`);
			stats.recordInvocationResult("RES", false, `call-${b}-A`);
		}
		// All 8 entries share (read, args, RES); the result-aware count must see the
		// full trailing run. Before the fix the N-1 starts kept resultHash=undefined
		// and broke the streak at 1.
		expect(stats.getConsecutiveSimilarResultCount()).toBe(8);
	});

	it("without a toolCallId it still stamps the most recent entry (sequential path)", () => {
		const stats = new ToolCallStats();
		stats.recordInvocation("read", "a");
		stats.recordInvocationResult("RES", false);
		expect(stats.getConsecutiveSimilarResultCount()).toBe(1);
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
