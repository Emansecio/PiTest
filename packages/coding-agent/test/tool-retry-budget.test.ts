/**
 * Per-tool, per-target retry budget (tool-retry-budget.ts) — the counter that is
 * appended inline to failing tool results ("attempts on `edit` for this target:
 * 2/3"). Ported from forgecode's error_tracker, softened to steering (never a
 * block). These tests cover the pure key/line/env helpers, the tracker's
 * consecutive-failure semantics, and the Tier-4 hint rule end-to-end.
 */

import { describe, expect, it } from "vitest";
import {
	buildRetryBudgetLine,
	createRetryBudgetHintRule,
	DEFAULT_TOOL_RETRY_BUDGET,
	isToolRetryBudgetDisabled,
	resolveToolRetryBudgetMax,
	retryBudgetTargetKey,
	ToolRetryBudgetTracker,
} from "../src/core/tool-retry-budget.ts";

describe("resolveToolRetryBudgetMax / isToolRetryBudgetDisabled", () => {
	it("defaults to 3 and honors a positive integer override", () => {
		expect(resolveToolRetryBudgetMax({} as NodeJS.ProcessEnv)).toBe(DEFAULT_TOOL_RETRY_BUDGET);
		expect(resolveToolRetryBudgetMax({ PIT_TOOL_RETRY_BUDGET: "5" } as NodeJS.ProcessEnv)).toBe(5);
		expect(resolveToolRetryBudgetMax({ PIT_TOOL_RETRY_BUDGET: "4.9" } as NodeJS.ProcessEnv)).toBe(4);
	});

	it("falls back on invalid overrides — a zero budget would be a permanent block", () => {
		for (const raw of ["0", "-1", "abc", "", "  "]) {
			expect(resolveToolRetryBudgetMax({ PIT_TOOL_RETRY_BUDGET: raw } as NodeJS.ProcessEnv)).toBe(
				DEFAULT_TOOL_RETRY_BUDGET,
			);
		}
	});

	it("kill-switch uses the standard truthy convention", () => {
		expect(isToolRetryBudgetDisabled({ PIT_NO_TOOL_RETRY_BUDGET: "1" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isToolRetryBudgetDisabled({ PIT_NO_TOOL_RETRY_BUDGET: "yes" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isToolRetryBudgetDisabled({} as NodeJS.ProcessEnv)).toBe(false);
	});
});

describe("retryBudgetTargetKey", () => {
	it("keys by the primary path argument when present", () => {
		expect(retryBudgetTargetKey("edit", { path: "a.ts", edits: [] })).toBe("edit\u0000a.ts");
		expect(retryBudgetTargetKey("edit", { file_path: "b.ts" })).toBe("edit\u0000b.ts");
	});

	it("same tool + different path never share a key; same pair always does", () => {
		const a1 = retryBudgetTargetKey("edit", { path: "a.ts" });
		const a2 = retryBudgetTargetKey("edit", { path: "a.ts", edits: [{ oldText: "x" }] });
		const b = retryBudgetTargetKey("edit", { path: "b.ts" });
		expect(a1).toBe(a2); // path dominates — differing secondary args still same target
		expect(a1).not.toBe(b);
	});

	it("falls back to an args fingerprint for path-less tools so bash shapes don't lump together", () => {
		const k1 = retryBudgetTargetKey("bash", { command: "npm test" });
		const k2 = retryBudgetTargetKey("bash", { command: "npm run build" });
		const k1again = retryBudgetTargetKey("bash", { command: "npm test" });
		expect(k1).not.toBe(k2);
		expect(k1).toBe(k1again);
	});

	it("NUL separator prevents name/target concatenation collisions", () => {
		expect(retryBudgetTargetKey("ed", { path: "ita.ts" })).not.toBe(retryBudgetTargetKey("edit", { path: "a.ts" }));
	});
});

describe("ToolRetryBudgetTracker", () => {
	it("counts consecutive failures per key and flags exhaustion at max", () => {
		const t = new ToolRetryBudgetTracker();
		expect(t.observeFailure("c1", "k", 3)).toEqual({ count: 1, max: 3, exhausted: false });
		expect(t.observeFailure("c2", "k", 3)).toEqual({ count: 2, max: 3, exhausted: false });
		expect(t.observeFailure("c3", "k", 3)).toEqual({ count: 3, max: 3, exhausted: true });
		expect(t.observeFailure("c4", "k", 3).exhausted).toBe(true); // beyond max stays exhausted
	});

	it("is idempotent per call id — a re-applied hint pass never double-counts", () => {
		const t = new ToolRetryBudgetTracker();
		const first = t.observeFailure("same-call", "k", 3);
		const second = t.observeFailure("same-call", "k", 3);
		expect(second).toBe(first);
		expect(t.observeFailure("next-call", "k", 3).count).toBe(2);
	});

	it("a success resets only that key's streak", () => {
		const t = new ToolRetryBudgetTracker();
		t.observeFailure("c1", "a", 3);
		t.observeFailure("c2", "a", 3);
		t.observeFailure("c3", "b", 3);
		t.observeSuccess("a");
		expect(t.observeFailure("c4", "a", 3).count).toBe(1); // reset
		expect(t.observeFailure("c5", "b", 3).count).toBe(2); // untouched
	});

	it("reset clears everything (new user turn)", () => {
		const t = new ToolRetryBudgetTracker();
		t.observeFailure("c1", "k", 3);
		t.reset();
		expect(t.observeFailure("c1", "k", 3).count).toBe(1); // even the per-call memo is gone
	});

	it("forgetCall drops the memo without touching the streak", () => {
		const t = new ToolRetryBudgetTracker();
		t.observeFailure("c1", "k", 3);
		t.forgetCall("c1");
		expect(t.observeFailure("c1", "k", 3).count).toBe(2); // recounted as a NEW failure
	});
});

describe("buildRetryBudgetLine", () => {
	it("is informational below the budget and escalates at exhaustion", () => {
		const info = buildRetryBudgetLine("edit", { count: 1, max: 3, exhausted: false });
		expect(info).toContain("attempts on `edit` for this target: 1/3");
		expect(info).not.toContain("exhausted");

		const hard = buildRetryBudgetLine("edit", { count: 3, max: 3, exhausted: true });
		expect(hard).toContain("3/3");
		expect(hard).toContain("retry budget exhausted");
		expect(hard).toContain("different tool or approach");
	});
});

describe("createRetryBudgetHintRule", () => {
	const call = (id: string, name = "edit", args: unknown = { path: "a.ts" }) => ({
		id,
		name,
		arguments: args,
	});

	it("appends a current counter line on consecutive failures for the same target", () => {
		const tracker = new ToolRetryBudgetTracker();
		const rule = createRetryBudgetHintRule(tracker, {} as NodeJS.ProcessEnv);

		const ctx1 = { call: call("c1"), result: { isError: true } } as never;
		expect(rule.matcher(ctx1)).toBe(true);
		expect(rule.hint(ctx1)).toContain("1/3");

		const ctx2 = { call: call("c2"), result: { isError: true } } as never;
		rule.matcher(ctx2);
		expect(rule.hint(ctx2)).toContain("2/3");
	});

	it("matcher and hint agree via the per-call memo (no double count)", () => {
		const tracker = new ToolRetryBudgetTracker();
		const rule = createRetryBudgetHintRule(tracker, {} as NodeJS.ProcessEnv);
		const ctx = { call: call("only"), result: { isError: true } } as never;
		rule.matcher(ctx);
		expect(rule.hint(ctx)).toContain("1/3");
		expect(rule.hint(ctx)).toContain("1/3"); // hint re-entry stays memoised
	});

	it("never counts a result explicitly marked non-error and honors the kill-switch", () => {
		const tracker = new ToolRetryBudgetTracker();
		const rule = createRetryBudgetHintRule(tracker, {} as NodeJS.ProcessEnv);
		expect(rule.matcher({ call: call("ok"), result: { isError: false } } as never)).toBe(false);

		const disabled = createRetryBudgetHintRule(new ToolRetryBudgetTracker(), {
			PIT_NO_TOOL_RETRY_BUDGET: "1",
		} as NodeJS.ProcessEnv);
		expect(disabled.matcher({ call: call("c"), result: { isError: true } } as never)).toBe(false);
	});
});
