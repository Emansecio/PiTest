/**
 * Unit coverage for the cross-error ("flailing") detector: tracker run logic,
 * the pure fire decision, and the reminder builder.
 */

import { describe, expect, it } from "vitest";
import { buildCrossErrorReminder, CrossErrorTracker, decideCrossErrorReminder } from "./cross-error.ts";

describe("CrossErrorTracker", () => {
	it("counts a run of the same error across different call shapes", () => {
		const t = new CrossErrorTracker();
		expect(t.observeError("enoent foo", "args-a")).toEqual({ count: 1, distinctApproaches: 1 });
		expect(t.observeError("enoent foo", "args-b")).toEqual({ count: 2, distinctApproaches: 2 });
		expect(t.observeError("enoent foo", "args-c")).toEqual({ count: 3, distinctApproaches: 3 });
	});

	it("does not grow distinctApproaches when the same args repeat", () => {
		const t = new CrossErrorTracker();
		t.observeError("err", "args-a");
		expect(t.observeError("err", "args-a")).toEqual({ count: 2, distinctApproaches: 1 });
	});

	it("resets the run when the error fingerprint changes", () => {
		const t = new CrossErrorTracker();
		t.observeError("err-1", "a");
		t.observeError("err-1", "b");
		expect(t.observeError("err-2", "c")).toEqual({ count: 1, distinctApproaches: 1 });
	});

	it("resets on a successful tool result", () => {
		const t = new CrossErrorTracker();
		t.observeError("err", "a");
		t.observeError("err", "b");
		t.observeSuccess();
		expect(t.observeError("err", "c")).toEqual({ count: 1, distinctApproaches: 1 });
	});
});

describe("decideCrossErrorReminder", () => {
	const base = {
		enabled: true,
		threshold: 3,
		count: 3,
		distinctApproaches: 2,
		lastFiredAt: 0,
		now: 1_000,
		cooldownMs: 30_000,
	};

	it("fires at threshold with ≥2 approaches and a fresh cooldown", () => {
		expect(decideCrossErrorReminder(base)).toEqual({ fire: true, nextLastFiredAt: 1_000 });
	});

	it("does not fire below threshold", () => {
		expect(decideCrossErrorReminder({ ...base, count: 2 }).fire).toBe(false);
	});

	it("does not fire when only one approach was tried (doom-loop owns that case)", () => {
		expect(decideCrossErrorReminder({ ...base, distinctApproaches: 1 }).fire).toBe(false);
	});

	it("respects the cooldown window", () => {
		expect(decideCrossErrorReminder({ ...base, lastFiredAt: 990, now: 1_000 }).fire).toBe(false);
		expect(decideCrossErrorReminder({ ...base, lastFiredAt: 990, now: 31_000 }).fire).toBe(true);
	});

	it("does not fire when disabled", () => {
		expect(decideCrossErrorReminder({ ...base, enabled: false }).fire).toBe(false);
	});
});

describe("buildCrossErrorReminder", () => {
	it("reports the count, approaches, and a truncated sample", () => {
		const out = buildCrossErrorReminder({ count: 3, distinctApproaches: 2, sampleError: "ENOENT: no such file" });
		expect(out).toContain("<repeated-error-reminder>");
		expect(out).toContain("3 tool calls");
		expect(out).toContain("2 different");
		expect(out).toContain("ENOENT: no such file");
		expect(out).toContain("ask the user");
	});
});
