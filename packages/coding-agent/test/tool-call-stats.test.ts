import { describe, expect, it } from "vitest";
import { extractErrorMessage, ToolCallStats } from "../src/core/tool-call-stats.js";

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
